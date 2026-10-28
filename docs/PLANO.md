# Plano — múltiplos aprovadores + recibos BoundaryAttest (checklist vivo)

Legenda: `[x]` feito e verificado · `[~]` em andamento · `[ ]` a fazer · `[!]` bloqueado/decisão do dono

Visão geral e como retomar: [RESUMO-COMPLETO](RESUMO-COMPLETO.md).

Detalhe técnico de cada fase: [plano completo](decisions/plano-multi-aprovadores-boundaryattest-chatgpt.md) ·
[Fase 1](decisions/fase1-multi-aprovadores-status.md) · [Fase 2](decisions/fase2-isolamento-e-versao-do-diagnostico.md) ·
[Fase 3](decisions/fase3-servico-de-recibos.md).

**Princípio central:** n8n/Postgres decidem *quem pode agir*; o BoundaryAttest só assina *evidência*.
Um recibo, sozinho, nunca libera a Fase 2 do Claude.

---

## Fase 0 — limpeza e baseline  `[x]`
- [x] Parar o vazamento: workflows alheios (PetShop, "Workflow 123") fora do versionamento (`.gitignore`)
- [x] Export sem dados de runtime: nós `Strip Runtime Data` no `Sub - Export Workflows` (remove `staticData`/`pinData`)
- [x] Reescrever o histórico do Git sem os telefones de clientes (`git filter-repo`) + force-push
- [x] Varredura de segredos/telefones no histórico das branches: 0 ocorrências
- [ ] `[!]` Pedir ao suporte do GitHub a remoção de `refs/pull/2/head` (PR #2 fechado ainda aponta p/ commits antigos) — só o dono pode
- [ ] `[!]` Girar a API key do n8n que foi colada no chat
- [ ] Remover o número do operador do **histórico** (saiu dos workflows; ainda está em commits antigos) — decisão do dono

## Fase 1 — permissões nativas  `[x]`
- [x] Tabela `approvers` (full / partial / junior) + token **por aprovador** (só o hash no banco)
- [x] Matriz: full aprova tudo · partial só `low` · junior nunca (só lê/sugere)
- [x] W2a só lê; escapa todo HTML; botões conforme a permissão
- [x] W2b: decisão numa **única query atômica** (CTEs + lock): um só vencedor, mesmo com POST forjado/simultâneo
- [x] Sugestões (`incident_suggestions`) sem consumir token
- [x] Notificar **todos** os aprovadores ativos; falha de um destinatário não derruba os outros
- [x] Bugs: token no `diagnosis_json`, severidade, Switch do rate-limit, `If1` do W2b, `queryReplacement` com `\n`
- [x] Fail-open real da triagem (`Normalize Triage`: modelo falhou → `high` + escala)
- [x] Parsers robustos (diagnóstico/PR em prosa ou vazio → fallback que notifica)
- [x] Testes: 8 cenários SQL · matriz via webhook real · XSS · 8 requisições simultâneas → 1 aceita · E2E real
- [ ] Login individual + CSRF (link do aprovador ainda é credencial transferível) — fora do escopo, decisão consciente

## Fase 2 — isolamento e versão do diagnóstico  `[x]`
- [x] `diagnosis_hash` / `diagnosis_version` / `source_commit` / `workflow_snapshot_hash`
- [x] Aprovação só vale para o hash que o aprovador viu (re-diagnóstico invalida a página antiga)
- [x] Um `git worktree` por incidente (`services/heal-run.sh`); lock só nas operações de git → paralelo
- [x] Checagem de escopo pós-Fase 2 (arquivo fora de `files_to_change` → revisão manual; falha **fechada**)
- [x] Export sem corrida (lock + `pull --rebase`)
- [x] Testes: 16 do script (stub, custo zero) · SQL de hash · E2E com **2 incidentes simultâneos** sem troca de contexto
- [ ] Fix **real** que abra PR (só abortos de erro sintético foram exercitados)

## Fase 3 — serviço de recibos  `[x]`
- [x] BoundaryAttest vendorizado e fixado (`aa443e9`, 5 arquivos, licença)
- [x] Serviço HTTP loopback + token; só recebe o id de um **evento já gravado**
- [x] Ledger append-only (`incident_events`, `incident_receipts`) com gatilhos; idempotente; lock por evento
- [x] Recusa evidência que contradiz a matriz; `fix` só referencia `approval` real/mesmo incidente/mesmo diagnóstico
- [x] Chave: preflight **nunca gera**; `keygen` explícito; sem chave o serviço não sobe
- [x] Verificador (`verify`) e auditoria de incidente (`audit`) separando cripto / confiança / evidência / referências
- [x] Papel de banco mínimo `receipts_svc` (verificado: não lê `incidents`/`approvers`/tokens)
- [x] 48 testes (conformidade campo a campo com o `createSignedReceipt` real, 19 de adulteração, concorrência, HTTP)
- [x] Instalação **endurecida** (usuário `boundaryattest`, unit com sandbox) — isolamento verificado: meu usuário recebe "Permissão negada"
- [ ] `[!]` Apagar as cópias antigas sem privilégio: `rm -r ~/.config/n8n-self-healing-attest ~/.local/share/n8n-self-healing-attest`
- [x] Credencial do n8n (`Header Auth account 3`) funcionando (2 erros de configuração achados e corrigidos: **Name** = `Authorization`; **Value** = `Bearer ` + token, com espaço)

## Fase 4 — recibos de triagem e diagnóstico  `[x]`
- [x] `Build/Record/Request` de **triage** no W1 (ramo acima do fluxo principal, `onError: continue`)
- [x] `Record/Request` de **diagnosis** no W1 (evento amarrado à `diagnosis_version`)
- [x] Reconciliador `W-Receipts-Reconcile` (a cada 5 min emite recibos pendentes; idempotente)
- [x] Bug achado no teste: o n8n bloqueia a palavra `caller` em expressões → o evento de triagem não era gravado (campo renomeado para `actor`); agora os **2 eventos** são gravados (incidente 95)
- [x] Teste: serviço/credencial fora → pipeline continua até `awaiting_approval`, eventos gravados, recibos **pendentes** (incidentes 94 e 95; `audit` mostra `pending`, não esconde)
- [x] Teste: recuperação → o reconciliador emitiu os 3 recibos pendentes, **sem repetir** triagem/diagnóstico (eventos gravados 02:02–02:04 com o serviço inacessível; recibos às 02:15)
- [x] Teste: `audit` verifica tudo com as chaves do repo (incidentes 94, 95 e 96)
- [x] Caminho feliz: recibo de triagem em ~5 s e o de diagnóstico ao terminar, sem depender do reconciliador (incidente 96)
- [x] Workflows exportados (sanitizados) para o repo
- [x] Dados de teste removidos (ledger vazio, 4/4 gatilhos ativos)

## Fase 5 — aprovação + bloqueio antes da execução  `[ ]`
- [ ] Gravar o evento `approval` **na mesma transação** que consome o token (nível, severidade, capability, token_ref, hash do diagnóstico)
- [ ] Emitir o recibo `approval` após o commit
- [ ] **Exigir** recibo `approval` persistido/verificado antes de reservar a Fase 2 (fail-closed; estado `blocked_evidence`)
- [ ] Recuperação: serviço volta → libera **sem segunda aprovação** e sem execução dupla; revalidar política/versão antes
- [ ] Testes: derrubar o serviço depois do consumo → fix parado; restaurar → continua uma vez só

## Fase 6 — fix/PR e recuperação  `[ ]`
- [ ] Evento + recibo `fix` (referência explícita ao recibo `approval`, branch/commit/PR)
- [ ] `execution_state` (`running`/`unknown`/…) e reconciliação de execução interrompida (conferir branch/PR antes de qualquer retry)
- [ ] Falha ao emitir o recibo do fix **não** repete o fix
- [ ] Notificação universal do resultado (já existe) + estado do recibo
- [ ] Teste com um fix real que abra PR

---

## Decisões do dono (já tomadas)
- Aprova o plano do ChatGPT como direção; quer execução autônoma, testes a cada bloco grande e este checklist atualizado.
- Aprovadores de teste são **fictícios** (números/nomes falsos).
- Custódia da chave: **modo endurecido (A)** — instalado.

## Limites assumidos (não são bugs)
- Link do aprovador = credencial (sem login/CSRF).
- `trusted-keys.json` vem do próprio repo; um verificador externo precisa de canal separado para a chave pública.
- Timestamp assinado é declaração do host, não carimbo independente.
- O superusuário do banco consegue desligar os gatilhos de append-only.
- Flood/rate-limit é efetivamente sombreado pelo dedup de 60 min (não há alerta de flood).
