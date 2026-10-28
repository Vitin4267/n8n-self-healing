# Fase 2 — isolamento por incidente e aprovação presa à versão do diagnóstico

Segue o [plano](plano-multi-aprovadores-boundaryattest-chatgpt.md) (seção 6, Fase 2) depois da
[Fase 1](fase1-multi-aprovadores-status.md).

## O que mudou

**1. A aprovação vale para uma versão exata do diagnóstico.**
`incidents` ganhou `diagnosis_hash`, `diagnosis_version`, `source_commit` e
`workflow_snapshot_hash`. A página de revisão (W2a) mostra "Diagnóstico vN · hash …" e leva o hash
completo num campo do formulário. A query atômica do W2b só aceita a decisão se
`i.diagnosis_hash = <hash que o aprovador viu>` **e** se o hash gravado ainda bate com o SHA-256 do
texto atual de `diagnosis_json` (detecta adulteração direta no banco). Re-diagnóstico → hash novo →
a página antiga deixa de valer. Sem hash no POST → negado (fail-closed).

**2. Cada incidente roda no seu próprio `git worktree`** — `services/heal-run.sh <diagnose|fix> <id>`.
- `diagnose`: worktree *detached* de `origin/main` (já contém o export fresco do workflow); só
  `Read,Grep,Glob`.
- `fix`: worktree na branch `fix/incident-<id>`; allowlist de escrita como antes.
- O lock (`/var/lock/heal-git.lock`) cobre só operações curtas de git, **não** a execução do Claude:
  incidentes rodam em paralelo. O contexto é `.incident/incident-<id>.json`, copiado para
  `<worktree>/.incident/current.json` (acabou o `current.json` global compartilhado).
- Worktree é removido ao final (`trap`), inclusive órfãos de execuções que caíram.
- O script imprime linhas `META` (commit-base, hash do snapshot do workflow, `exit`,
  `scope_violation`) que o `Parse Diagnosis` / `Parse PR Result` leem.

**3. Checagem de escopo pós-Fase 2.** Os arquivos alterados na branch (commitados ou não) são
comparados com `diagnosis.files_to_change`. Qualquer outro arquivo → `needs_manual_review` com
"Do NOT merge <PR>". Se a própria checagem quebrar → `check_failed` (também manual review): falha
fechada, nunca "nenhuma violação".

**4. Export sem corrida.** O `Sub - Export Workflows` agora usa o mesmo lock e faz
`git pull --rebase` antes do `push`.

## Bugs encontrados *durante* os testes

- O arquivo do incidente que o n8n escreve é um **array** (`[{...}]`); o script assumia objeto, então
  `snapshot=none` e — pior — a checagem de escopo teria falhado **em silêncio**. Corrigido e coberto
  por teste.
- O `claude -p` esperava 3 s por stdin; agora recebe `</dev/null`.

## Como foi testado

- `bash services/test-heal-run.sh` (16 checagens, `claude` falso + repo/origin descartáveis, custo
  zero): 2 incidentes simultâneos sem troca de contexto e em paralelo; snapshot real e distinto; nenhum
  worktree sobrando; árvore principal intacta; escopo (objeto e array); escopo fail-closed; id
  malicioso; modo inválido; worktree órfão.
- SQL em transação com `ROLLBACK`: hash ausente, errado, diagnóstico adulterado, página antiga após
  re-diagnóstico, página nova.
- 13 testes offline dos parsers v2 (META, fallback, fora do escopo, check_failed).
- **E2E real**: dois incidentes disparados juntos (2 worktrees simultâneos, 0 no fim); cada
  diagnóstico cita só o arquivo do **seu** workflow; snapshots distintos; stale-page negada pelo
  webhook; approve → Fase 2 (`scope_violation=none`); reject.

## Não coberto

- Fase 2 com um fix **real** que abra PR (só abortos de erro sintético foram exercitados).
- Violação de escopo ao vivo com o Claude de verdade (coberta só com o stub).
- O diagnóstico não é bloqueado se o hash do snapshot ficar `none` (workflow sem arquivo no repo);
  a aprovação ainda é presa ao hash do diagnóstico.
