# Fase 1 — múltiplos aprovadores (status)

Implementa a Fase 1 do [plano](plano-multi-aprovadores-boundaryattest-chatgpt.md): permissões
nativas (n8n + Postgres), **sem** BoundaryAttest ainda. Quem autoriza é sempre o backend; recibos
(Fases 3–6) serão só evidência.

## Como funciona agora

| Nível | severidade `low` | `medium` / `high` / `critical` |
|---|---|---|
| `full` | aprova / rejeita | aprova / rejeita |
| `partial` | aprova / rejeita | só lê + sugere |
| `junior` | só lê + sugere | só lê + sugere |

- **W1** notifica *todos* os aprovadores ativos e gera **um token por aprovador** (UUID no link;
  só o hash SHA-256 fica em `approval_tokens`). O token não vai mais para o `diagnosis_json`.
- **W2a** (GET) só lê: valida o token por hash, calcula a capability no banco e mostra
  Approve/Reject apenas a quem pode. Todo conteúdo vindo do banco é escapado no HTML.
- **W2b** (POST) tem dois caminhos:
  - `suggest`: grava em `incident_suggestions`; não consome token nem decide nada.
  - `approve`/`reject`: **uma única query atômica** (CTEs + `FOR UPDATE`) revalida nível e
    severidade *no banco*, grava `decided_by`, e queima os tokens dos outros aprovadores. O nível
    enviado pelo cliente é ignorado. Só um aprovador vence, mesmo com requisições simultâneas.
- O resultado da Fase 2 vai para todos os aprovadores ativos (`Get Active Approvers`); falha em um
  destinatário não derruba os demais (`onError: continue`). Idem W-Digest.

## Bugs corrigidos no caminho

- Token de aprovação vazava para `diagnosis_json` (nó `Generate Token` removido; campo limpo das
  linhas antigas).
- `queryReplacement` com `\n` depois de `}}` virava texto e quebrava o `UPDATE ... 'logged'`:
  51 incidentes ficaram presos em `triaging`, e como `triaging` conta como ativo no dedup, esses
  erros nunca mais geravam alerta. Agora `triaging` com mais de 1h expira.
- Switch do rate-limit (`<=5` / `>=5`) sobrepunha em 5.
- `UPDATE ... WHERE id = {{ ... }}` interpolava no SQL; agora é parametrizado.
- Corrida em `.incident/current.json`: cada incidente escreve `incident-<id>.json` e o `cp` para
  `current.json` acontece *dentro* do `flock`.
- Classificador do LLM sem fail-open real: novo nó `Normalize Triage` cai em
  `severity=high, escalate=true` se o modelo falhar ou devolver algo inválido.
- Número de WhatsApp fixo em W1/W2b/W-Digest removido (vem de `approvers`).
- Mensagem do W1 começava com `=` solto.

## Como foi testado

- Query de decisão: 8 cenários (nível × severidade, token forjado, token de outro incidente,
  duplo clique, perdedor) em transação com `ROLLBACK`.
- Webhooks reais, com aprovadores de teste: matriz completa da página, XSS escapado, entradas
  hostis (`1 OR 1=1`, `';DROP TABLE…`), ações inválidas, sugestões, replay.
- **8 requisições simultâneas** de dois aprovadores elegíveis: 1 aceita, 7 negadas.
- **E2E real**: erro forçado → triagem (LLM) → diagnóstico (Claude) → WhatsApp → link do
  aprovador → approve → Fase 2 (abortou, erro sintético) → notificação. Ver também o caminho
  `logged` (LLM decidiu não escalar).

## O que ainda NÃO está feito / verificado

- Autenticação individual (login/CSRF): hoje o token do link *é* a credencial; link
  encaminhado = capability transferida. Decisão consciente (ver plano, seção 8).
- `Normalize Triage` nunca foi exercitado com falha real do modelo (só o caminho feliz).
- O caminho `approve` do W2b só foi exercitado até a Fase 2 abortar; nenhum PR real foi gerado.
- Aprovador `Teste Fake` (junior, número inexistente) continua na tabela.
- Fases 2–6 do plano: isolamento por tentativa, serviço de recibos, recibos assinados.
- W0 (export diário às 3h) ainda não foi observado rodando; o export sanitiza `staticData`.
