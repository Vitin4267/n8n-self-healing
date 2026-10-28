#!/usr/bin/env bash
# Offline test for heal-run.sh: throwaway repo + bare origin + a fake `claude`.
# Costs nothing and never touches the real repo.   Usage: bash services/test-heal-run.sh
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf -- "${TMP:?}"' EXIT
FAIL=0
ok() { if [ "$1" = 0 ]; then echo "PASS  $2"; else echo "FAIL  $2"; FAIL=1; fi; }

git init -q --bare "$TMP/origin.git"
git clone -q "$TMP/origin.git" "$TMP/repo" 2>/dev/null
cd "$TMP/repo" || exit 1
git config user.email t@t; git config user.name t; git checkout -q -b main
mkdir -p prompts workflows services .incident
echo diag > prompts/diagnose.md; echo fix > prompts/fix.md
echo '{"wf":"A"}' > workflows/WFA.json; echo '{"wf":"B"}' > workflows/WFB.json
cp "$HERE/heal-run.sh" services/; printf '.incident/\n.worktrees/\n' > .gitignore
git add -A; git commit -q -m init; git push -q origin main
export HEAL_GIT_LOCK="$TMP/heal-git.lock"

# fake claude: echoes the incident context it can see; in fix mode makes one in-scope and one out-of-scope commit
cat > "$TMP/claude" <<'EOF'
#!/usr/bin/env bash
sleep 2
INC="$(python3 -c 'import json;print(json.load(open(".incident/current.json"))["incident_id"])')"
if [ "$(cat prompts/fix.md 2>/dev/null)" = "$(printf 'fix')" ] && [ "$1" = "-p" ] && [[ "$2" == fix* ]]; then
  echo '{"patched":true}' > workflows/WFA.json; echo oops > OUT_OF_SCOPE.txt
  git add -A; git -c user.email=t@t -c user.name=t commit -q -m "fix $INC"
fi
printf '{"type":"result","result":"saw incident %s in %s","total_cost_usd":0}\n' "$INC" "$(pwd | sed 's#.*/##')"
EOF
chmod +x "$TMP/claude"; export CLAUDE_BIN="$TMP/claude"

mk() { # id wf
  python3 - "$1" "$2" <<'PY'
import json,sys
i,wf=sys.argv[1:3]
json.dump({"incident_id":int(i),"workflow_file":f"workflows/{wf}.json",
           "diagnosis":{"files_to_change":[f"workflows/{wf}.json"]}}, open(f".incident/incident-{i}.json","w"))
PY
}
mk 9001 WFA; mk 9002 WFB

echo "== diagnose: 2 incidentes simultâneos"
START=$(date +%s)
bash services/heal-run.sh diagnose 9001 > "$TMP/o1" 2>&1 &
bash services/heal-run.sh diagnose 9002 > "$TMP/o2" 2>&1 &
wait
ELAPSED=$(( $(date +%s) - START ))
grep -q "saw incident 9001" "$TMP/o1" && ! grep -q "9002" "$TMP/o1"; ok $? "9001 viu só o próprio contexto"
grep -q "saw incident 9002" "$TMP/o2" && ! grep -q "9001" "$TMP/o2"; ok $? "9002 viu só o próprio contexto"
S1=$(grep -o 'snapshot=[0-9a-f]*' "$TMP/o1"); S2=$(grep -o 'snapshot=[0-9a-f]*' "$TMP/o2")
[ -n "$S1" ] && [ "$S1" != "$S2" ]; ok $? "snapshot hash difere por workflow ($S1 vs $S2)"
[ "$ELAPSED" -lt 4 ]; ok $? "rodaram em paralelo (${ELAPSED}s < 4s; serial seria >= 4s)"
grep -q "META exit=0" "$TMP/o1"; ok $? "META exit=0 presente"
[ "$(git worktree list | wc -l)" = 1 ]; ok $? "nenhum worktree sobrando"
[ "$(git branch --show-current)" = main ] && [ -z "$(git status --porcelain)" ]; ok $? "árvore principal intacta (main, limpa)"

echo "== fix: escopo"
bash services/heal-run.sh fix 9001 > "$TMP/f1" 2>&1
grep -q 'scope_violation=OUT_OF_SCOPE.txt$' "$TMP/f1"; ok $? "só o arquivo fora do escopo é apontado (workflows/WFA.json permitido)"
git rev-parse --verify -q fix/incident-9001 >/dev/null; ok $? "branch fix/incident-9001 criada"
[ "$(git branch --show-current)" = main ]; ok $? "árvore principal continua em main"
git branch -q -D fix/incident-9001

echo "== robustez"
rm -f .incident/incident-9003.json
bash services/heal-run.sh diagnose 9003 >/dev/null 2>&1; [ $? = 2 ]; ok $? "incidente sem arquivo -> exit 2"
bash services/heal-run.sh diagnose '1;touch /tmp/pwned' >/dev/null 2>&1; [ $? = 2 ] && [ ! -e /tmp/pwned ]; ok $? "id malicioso rejeitado"
bash services/heal-run.sh weird 9001 >/dev/null 2>&1; [ $? = 2 ]; ok $? "modo inválido -> exit 2"
mkdir -p .worktrees/diagnose-9001; echo junk > .worktrees/diagnose-9001/x
bash services/heal-run.sh diagnose 9001 > "$TMP/o3" 2>&1; grep -q "saw incident 9001" "$TMP/o3"; ok $? "recupera worktree órfão de uma execução que caiu"

exit $FAIL
