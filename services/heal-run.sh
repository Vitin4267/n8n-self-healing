#!/usr/bin/env bash
# heal-run.sh <diagnose|fix> <incident_id>
#
# Runs Claude Code for ONE incident inside its own git worktree, so two incidents
# processed at the same time can never see (or overwrite) each other's context.
#
#   diagnose  detached worktree of origin/main (read-only tools, set by the caller's
#             allowlist below); reads the freshly exported workflow from that snapshot.
#   fix       worktree on branch fix/incident-<id> created from origin/main.
#
# The shared repo lock (/var/lock/heal-git.lock) only wraps short git operations
# (fetch / worktree add / remove), NOT the Claude run, so incidents run in parallel.
#
# Output: Claude's JSON envelope on stdout, plus `META key=value ...` lines that the
# n8n Parse nodes read. This script always exits 0 once it got far enough to print META,
# so the workflow can surface failures instead of dying (see exit=<code> in META).
#
# Test hook: CLAUDE_BIN overrides the claude binary (used by services/test-heal-run.sh).
set -u

MODE="${1:-}"
ID="${2:-}"
case "$MODE" in diagnose | fix) ;; *) echo "usage: $0 <diagnose|fix> <incident_id>" >&2; exit 2 ;; esac
[[ "$ID" =~ ^[0-9]+$ ]] || { echo "invalid incident id" >&2; exit 2; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WT="$ROOT/.worktrees/$MODE-$ID"
LOCK="${HEAL_GIT_LOCK:-/var/lock/heal-git.lock}"
INCIDENT_FILE="$ROOT/.incident/incident-$ID.json"
CLAUDE="${CLAUDE_BIN:-claude}"
ORIGIN_REF="${HEAL_BASE_REF:-origin/main}"

[ -f "$INCIDENT_FILE" ] || { echo "missing $INCIDENT_FILE" >&2; exit 2; }

glock() { flock -w 120 "$LOCK" "$@"; }

cleanup() {
  glock git -C "$ROOT" worktree remove --force "$WT" >/dev/null 2>&1
  glock git -C "$ROOT" worktree prune >/dev/null 2>&1
}
trap cleanup EXIT

# a previous crashed run may have left this exact worktree behind
glock git -C "$ROOT" worktree remove --force "$WT" >/dev/null 2>&1
[ -d "$WT" ] && rm -rf -- "${WT:?}"
glock git -C "$ROOT" worktree prune

if [ -z "${HEAL_SKIP_FETCH:-}" ]; then
  glock git -C "$ROOT" fetch -q origin main || { echo "META mode=$MODE incident=$ID error=fetch_failed exit=3"; exit 0; }
fi

if [ "$MODE" = fix ]; then
  glock git -C "$ROOT" worktree add -q -B "fix/incident-$ID" "$WT" "$ORIGIN_REF"
else
  glock git -C "$ROOT" worktree add -q --detach "$WT" "$ORIGIN_REF"
fi || { echo "META mode=$MODE incident=$ID error=worktree_failed exit=3"; exit 0; }

mkdir -p "$WT/.incident"
cp "$INCIDENT_FILE" "$WT/.incident/current.json"

BASE="$(git -C "$WT" rev-parse HEAD)"
WF_FILE="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("workflow_file",""))' "$INCIDENT_FILE")"
SNAP="none"
if [ -n "$WF_FILE" ] && [ -f "$WT/$WF_FILE" ]; then
  SNAP="$(sha256sum "$WT/$WF_FILE" | cut -d' ' -f1)"
fi
echo "META mode=$MODE incident=$ID base=$BASE snapshot=$SNAP worktree=$WT"

if [ "$MODE" = diagnose ]; then
  (cd "$WT" && "$CLAUDE" -p "$(cat prompts/diagnose.md)" \
    --allowedTools "Read,Grep,Glob" \
    --output-format json --max-turns 25)
  CODE=$?
  echo "META exit=$CODE"
  exit 0
fi

(cd "$WT" && "$CLAUDE" -p "$(cat prompts/fix.md)" \
  --allowedTools "Read,Grep,Glob,Edit,Write,Bash(git:*),Bash(gh pr create:*)" \
  --output-format json --max-turns 40)
CODE=$?

# Scope check: the approved diagnosis lists the files that may change. Anything else
# (committed on the branch or left uncommitted) is reported, never silently accepted.
VIOLATION="$(python3 - "$INCIDENT_FILE" "$WT" "$BASE" <<'PY'
import json, subprocess, sys
incident, wt, base = sys.argv[1:4]
allowed = set(json.load(open(incident)).get("diagnosis", {}).get("files_to_change") or [])
def git(*a):
    return subprocess.run(["git", "-C", wt, *a], capture_output=True, text=True).stdout.split("\n")
changed = set(filter(None, git("diff", "--name-only", f"{base}..HEAD")))
changed |= {l[3:] for l in git("status", "--porcelain") if len(l) > 3 and not l[3:].startswith(".incident/")}
print(",".join(sorted(changed - allowed)))
PY
)"
echo "META exit=$CODE scope_violation=${VIOLATION:-none}"
exit 0
