# Resumo completo — n8n Self-Healing + múltiplos aprovadores + recibos BoundaryAttest

Documento único para **retomar o trabalho**. Estado em **28/10/2026**. O checklist vivo (o que está feito
e o que falta) é o [`PLANO.md`](PLANO.md); o detalhe técnico de cada fase está em
[`decisions/`](decisions/). Aqui ficam o contexto, o mapa do sistema, como operar e o que aprendemos.

> Nenhum segredo está neste arquivo (o repo é público): tokens, senhas e chaves privadas ficam fora do Git.

---

## 1. De onde veio e qual é o objetivo

O projeto já existia: uma falha em produção no n8n vira um ciclo completo — detecção → triagem por IA →
diagnóstico (Claude Code, só leitura) → aprovação humana → correção (Claude Code, escreve numa branch) → PR.

A **issue #1** deste repo (conversa com o autor do BoundaryAttest) identificou o limite: o sistema assumia
**um único operador confiável**. O trabalho feito aqui implementa o que ficou combinado nela:

1. **Vários aprovadores com níveis de permissão** (`full` / `partial` / `junior`), decididos no backend.
2. **Recibos assinados** (BoundaryAttest, `server_attested`) nas fronteiras do incidente: triagem → diagnóstico →
   aprovação → correção, todos ligados por `lineage = incident:<id>`.

**Princípio que não muda:** o n8n/Postgres decidem *quem pode agir*; o BoundaryAttest só assina *evidência*.
Um recibo, sozinho, nunca libera a Fase 2 do Claude.

## 2. Mapa do sistema

```
Erro em produção ──► W1 (Error Trigger)
   dedup · rate-limit · fingerprint
        │
        ├─► LLM classifica severidade (low/medium/high/critical)  ──► Normalize Triage (fail-open: falhou → high + escala)
        │        └─► [Fase 4] grava evento "triage" ─► pede recibo ao serviço
        │
        ├─ não escala ─► status logged + e-mail
        │
        └─ escala ─► exporta o workflow (fresco) ─► services/heal-run.sh diagnose  (worktree próprio, só Read/Grep/Glob)
                 ─► Parse Diagnosis ─► Save (diagnosis_hash, versão, commit-base, hash do snapshot)
                 ─► [Fase 4] grava evento "diagnosis" ─► pede recibo
                 ─► gera 1 token POR APROVADOR (só o hash vai ao banco) ─► WhatsApp p/ todos os aprovadores ativos

Aprovador clica ─► W2a (GET /webhook/heal-review): só LÊ; mostra Approve/Reject só a quem pode; escapa todo HTML
                   formulário leva o hash do diagnóstico que ele viu
              ─► W2b (POST /webhook/heal-decide):
                   • suggest  → grava sugestão (não consome nada)
                   • approve/reject → UMA query atômica: revalida nível+severidade+hash do diagnóstico NO BANCO,
                     consome o token, grava decided_by, queima os tokens dos outros  → 1 só vencedor
                   • approve → services/heal-run.sh fix (worktree próprio, branch fix/incident-N) ─► PR
                     checagem de escopo: arquivo fora de files_to_change → "needs manual review / NÃO fazer merge"
                   • resultado → WhatsApp p/ todos

Reconciliador (a cada 5 min) ─► emite recibos que ficaram pendentes (serviço fora) — idempotente
Serviço de recibos (usuário "boundaryattest", 127.0.0.1:8787) ─► assina eventos já gravados no ledger append-only
```

### Matriz de permissão (aplicada no banco, não na tela)

| Nível | severidade `low` | `medium` / `high` / `critical` |
|---|---|---|
| `full` | aprova / rejeita | aprova / rejeita |
| `partial` | aprova / rejeita | só lê + sugere |
| `junior` | só lê + sugere | só lê + sugere |

## 3. O que foi feito, fase a fase

| Fase | Resumo | Prova |
|---|---|---|
| **0** Limpeza | Telefones de clientes (workflow PetShop) estavam no histórico público. Saíram do versionamento; export agora remove `staticData`/`pinData`; histórico reescrito com `git filter-repo` + force-push | 0 telefones nas branches; clone novo verificado |
| **1** Permissões | Tabelas `approvers`/`approval_tokens`/`incident_suggestions`; W2a/W2b reescritos; query de decisão atômica; fail-open da triagem; parsers robustos | 8 cenários SQL · matriz via webhook real · XSS · **8 requisições simultâneas → 1 aceita** · E2E real |
| **2** Isolamento | `diagnosis_hash`/versão/commit/snapshot; aprovação presa à versão; 1 `git worktree` por incidente; checagem de escopo | 16 testes do script · SQL · **2 incidentes simultâneos sem troca de contexto** |
| **3** Serviço de recibos | BoundaryAttest vendorizado e fixado; ledger append-only; idempotência; verificador; chave isolada em usuário de sistema | **48 testes** · isolamento verificado ("Permissão negada" para o usuário do n8n/Claude) |
| **4** Recibos de triagem/diagnóstico | n8n grava eventos e pede recibos sem bloquear; reconciliador; comando `audit` | caminho feliz (~5 s) · serviço fora → pipeline segue · recuperação sem repetir diagnóstico |

**Fases 5 e 6 ainda não foram feitas** (ver seção 7).

## 4. Onde está cada coisa

### Repo (`~/projects/n8n-self-healing`)
| Caminho | O quê |
|---|---|
| `workflows/` | exports sanitizados (fonte de verdade é o n8n; o W0 exporta às 3h) |
| `prompts/diagnose.md`, `prompts/fix.md`, `CLAUDE.md` | instruções dos agentes (inclui "só os arquivos aprovados" e hash aprovado no PR) |
| `services/heal-run.sh` + `test-heal-run.sh` | runner por worktree (diagnose/fix) e seus testes (16 checagens, custo zero) |
| `services/receipt-service/` | serviço de recibos (TypeScript): `src/`, `test/`, `migrations/`, `deploy/`, `vendor/BoundaryAttest/`, `trusted-keys.json` |
| `docs/PLANO.md` | **checklist vivo** |
| `docs/decisions/` | plano completo (ChatGPT) e status das fases 1, 2 e 3 |

### n8n (IDs dos workflows)
| Workflow | ID |
|---|---|
| W1 — Detection & Triage | `AZWei6MYYJDihsBi` |
| W2a — Review Page (GET `heal-review`) | `qUB0JOdrxaUAP7C7` |
| W2b — Approve & Fix (POST `heal-decide`) | `YuyxIat8NB2F4TxG` |
| W0 — Daily Export / Sub - Export Workflows | `1zvQKzGsZUICPq5x` / `xqqlNTAEAj7FIMRF` |
| W-Digest / W-Fallback | `tKRpKt2eaS92AOnk` / `NyMhXxnkyTbhmVQj` |
| **W-Receipts-Reconcile** (novo) | `KYfyTDxWAMnrUMgk` |

Credenciais usadas: `Postgres account 2` (`52EskqeODOD50WcM`), `Header Auth account 3` (`I9nZGqHcQhobOBJ7`,
serviço de recibos), `Evolution account` (WhatsApp).

### Banco (Postgres no Docker, `127.0.0.1:5433`, banco `incidents`)
`incidents` (+ `diagnosis_hash`, `diagnosis_version`, `source_commit`, `workflow_snapshot_hash`, `decided_by`…),
`approvers`, `approval_tokens` (só hash SHA-256), `incident_suggestions`, **`incident_events`** e
**`incident_receipts`** (append-only por gatilhos). Papel `receipts_svc` com privilégio mínimo.

### Serviço de recibos (modo endurecido)
- Unit: `n8n-self-healing-receipts.service` (usuário `boundaryattest`, `127.0.0.1:8787`, sandbox)
- Código `/opt/n8n-self-healing-receipts` (somente leitura) · chave/env/token em `/var/lib/…` e `/etc/n8n-self-healing-attest/`
  — **ilegíveis para o usuário que roda n8n e Claude**
- Chave atual: `sha256:5c2e09a1e2850c9ca6213362` · chave antiga (só p/ verificar o passado): `sha256:f311d82d5894d51f852f7a1a`
- A credencial do n8n precisa de **Name = `Authorization`** e **Value = `Bearer ` + token (com espaço)**.

## 5. Como operar

```bash
# Testes
bash services/test-heal-run.sh                                   # runner por worktree (sem custo)
cd services/receipt-service && RECEIPT_TEST_DB_URL=postgres://… npm test   # 48 testes (schema descartável)

# Auditar um incidente (verifica todos os recibos contra as chaves do repo)
cd services/receipt-service
RECEIPT_DB_URL=postgres://… node dist/src/cli.js audit <incidentId> --trusted trusted-keys.json
node dist/src/cli.js verify <bundle.json> --trusted trusted-keys.json   # bundle exportado de GET /v1/receipts/<eventId>

# Serviço
systemctl status n8n-self-healing-receipts
curl -s 127.0.0.1:8787/healthz            # ok + key_id
# checklist de smoke: services/receipt-service/deploy/SMOKE.md
```

**Como testar o pipeline de ponta a ponta** (técnica usada): criar um workflow temporário na API do n8n com um
webhook que lança um erro "grave" e `settings.errorWorkflow = W1`, ativá-lo, dispará-lo, acompanhar `incidents`/
`incident_events`/`incident_receipts`, aprovar pelo webhook real e **apagar tudo no fim** (workflow, incidentes,
branch `fix/incident-N`). O LLM de triagem é não determinístico: um erro "médio" não escala.

## 6. Lições (armadilhas que custaram tempo)

- **n8n:** um `\n` depois do `}}` em `queryReplacement` transforma a expressão em texto e quebra o SQL; o nó `If`
  com validação de tipo **estrita** falha quando o banco devolve número; a palavra **`caller`** é bloqueada em
  expressões (use `actor`); `Convert to File` grava um **array** `[{...}]`, não um objeto.
- **Header Auth no n8n:** *Name* é o nome do **cabeçalho** (`Authorization`), não o nome da credencial.
- **BoundaryAttest:** `createSignedReceipt`/`setupKeys()` **geram uma chave nova em silêncio** se os arquivos
  sumirem — por isso o serviço não os usa (preflight que falha, `keygen` explícito).
- **Testar antes de confiar:** três bugs só apareceram na execução real (formato array do arquivo do incidente,
  `tsc` ausente no instalador, `caller` bloqueado). Os testes offline não os pegariam.
- `pkill -f` com o texto do próprio comando mata o seu shell; use o PID de quem escuta na porta.

## 7. O que falta

### Plano
- **Fase 5** — gravar o evento `approval` **na mesma transação** que consome o token; emitir o recibo; **exigir** o
  recibo de aprovação antes de iniciar a Fase 2 (fail-closed, estado `blocked_evidence`); se o serviço cair depois
  da decisão, liberar na volta **sem segunda aprovação e sem execução dupla**. Teste de queda: quebrar a
  credencial de propósito (não precisa de `sudo`) e, como confirmação final, `sudo systemctl stop`/`start`.
- **Fase 6** — evento + recibo do `fix` (referência ao recibo de `approval`, branch/commit/PR); `execution_state` e
  reconciliação de execução interrompida; falha ao emitir o recibo do fix **não repete o fix**; teste com um PR real.

### Pendências do dono
- [ ] Apagar as cópias antigas sem privilégio: `rm -r ~/.config/n8n-self-healing-attest ~/.local/share/n8n-self-healing-attest`
- [ ] Girar a API key do n8n que foi colada no chat
- [ ] Pedir ao suporte do GitHub a remoção de `refs/pull/2/head` (PR #2 fechado ainda aponta p/ commits com telefones)
- [ ] Decidir se limpa o número do operador do **histórico** (já saiu dos workflows)
- [ ] Decidir o que fazer com o aprovador de teste `Teste Fake` (junior, número inexistente) e com a branch
      `claude/self-healing-implementation-plan-…`

### Limites assumidos (não são bugs)
Link do aprovador = credencial (sem login/CSRF) · `trusted-keys.json` vem do próprio repo · timestamp assinado é
declaração do host · o superusuário do banco consegue desligar os gatilhos · o alerta de flood é código morto
(o dedup de 60 min o sombreia) · nenhum fix **real** abriu PR ainda (só abortos de erro sintético).

## 8. Outras coisas feitas na sessão

- Codex CLI (`@openai/codex`) instalado via npm global (sem login; o app do ChatGPT não existe oficialmente para Linux).
- Aviso dos "5 fundamentos" registrado como issue no GrafPro: `Vitin4267/grafica-saas#24`.
- Feito autônomo, com testes a cada bloco grande e commits pequenos; ações destrutivas (reescrever histórico,
  force-push, instalar serviço) só com autorização explícita — o classificador de permissões barrou duas
  (force-push sem aval; `loginctl enable-linger`) e **não foi contornado**.

## 9. Como retomar (para o Claude ou para você)

1. Ler `docs/PLANO.md` (o que está `[x]`/`[ ]`) e este arquivo.
2. Conferir o estado: `curl 127.0.0.1:8787/healthz`, `git status`, workflows ativos no n8n.
3. Rodar os testes (seção 5) antes de mexer em qualquer coisa.
4. Seguir pela **Fase 5**, testando cada bloco grande e atualizando o checklist enquanto avança.
