# Plano de implementação — Multi-aprovador + recibos BoundaryAttest

Origem: conversa com Cullen Meyers na [issue #1](https://github.com/Vitin4267/n8n-self-healing/issues/1)
e leitura do repo [cullenmeyers/BoundaryAttest](https://github.com/cullenmeyers/BoundaryAttest)
(`src/withServerReceipt.ts`, `src/receipts.ts`, `src/sinks.ts`, `src/keys.ts`, `docs/interop-profile-v0.2.md`).

## 1. O que foi combinado (resumo da issue #1)

| Ponto | Decisão combinada com o Cullen |
|---|---|
| Problema real | Hoje existe **um operador implícito** atrás do link do WhatsApp. Com vários operadores, "quem aprovou" precisa ser registrado e verificável. |
| Níveis de permissão | `full` (sempre aprova), `partial` (aprova só severidade baixa; acima disso vira só leitura + sugestão), `junior` (sempre só leitura + sugestão). Todos são notificados; o que muda é quem pode **agir**. |
| Enforcement | A lógica nativa (Postgres + token de uso único + permissão × severidade) continua sendo a **única autoridade**. O BoundaryAttest é camada de **evidência**, nunca de autorização. |
| `caller` | Só identidade/autenticação (`id`, `type`, `authRef`). **Não** colocar `permissionLevel` dentro de `caller`: o serializer atual só assina `caller_id`, `caller_type`, `caller_auth_ref` — um campo extra simplesmente não entraria no recibo. |
| Contexto de decisão | Permissão, severidade, elegibilidade, capacidade resultante e versão da política vão no **input receiptado** (`getReceiptInput`) → coberto por `input_hash`. O objeto de evidência fica guardado ao lado do recibo para quem verificar poder recalcular o hash. |
| Correlação | Todos os recibos do incidente usam a mesma `lineage: { ref: "incident:<id>", type: "workflow_run" }`. |
| `previous_receipt_hash` | Só integridade sequencial da cadeia. **Não** é mecanismo de autorização (recibos de incidentes concorrentes podem se intercalar legitimamente). |
| Fase 2 | O input receiptado da Fase 2 carrega explicitamente `approval_receipt_id` + `approval_receipt_hash`. A existência de um recibo de aprovação **não** autoriza nada sozinha. |
| `receipt_role` | `server_attested` — o n8n assina o que ele afirma ter observado/executado. |
| `caller.type` | `human` só na aprovação (host mapeou token → operador). Nas etapas automáticas o n8n orquestra o LLM/Claude → `type: "service"`, com o modelo/ferramenta em `toolMetadata` ou no input. |
| Retorno esperado | Cullen quer saber onde deu **atrito**: formato dos campos, empacotamento da evidência, custódia de chave, timing do recibo, comportamento em falha. |

## 2. Estado atual do repo (o que o plano precisa mexer)

- **W1** (`workflows/w1-detection-triage.json`): gera fingerprint → dedup → rate limit → AI Agent
  (`low|medium|high|critical` + `escalate`) → export fresco → Fase 1 (`claude -p` com
  `Read,Grep,Glob`) → `Generate Token` (um único `randomUUID`) → grava em `incidents.approval_token`
  → **um** `Send Text` para um número fixo no JSON.
- **W2a** (`w2a-review-page.json`): GET, valida `incident + token`, renderiza botões Approve/Reject.
- **W2b** (`w2b-approve-and-fix.json`): POST, `UPDATE ... SET token_used = true ... RETURNING`
  (consumo atômico), depois `If1` approve/reject → Fase 2 ou `status = 'rejected'`.
- Tabela `incidents` tem **um** `approval_token` por incidente — não existe noção de aprovador.

Achados que afetam este plano (corrigir antes ou junto):

1. **Caminhos divergentes:** W1 e `sub-export-workflows.json` usam `/home/victor-ferrareto-dias/projects/n8n-self-healing`,
   W2b usa `/home/user/projects/n8n-self-healing` (provável resíduo do "scrub" do README). Confirmar qual é o real.
2. **Telefone:** W1 ainda tem um número real hardcoded no JSON público; W2b tem placeholder `5511999999999`.
   A tabela `approvers` (Fase A) resolve os dois — os números saem do workflow.
3. **`Build Incident File`** monta JSON por interpolação de string (`"error_message": "{{ ... }}"`).
   Uma mensagem de erro com `"` ou `\n` quebra o arquivo. Como vamos **hashear** esse arquivo como
   evidência, trocar por um Code node com `JSON.stringify`.
4. **Status após consumo do token:** W2b marca `token_used = true` mas o status continua
   `awaiting_approval` durante a Fase 2 inteira. Com vários aprovadores isso precisa de um estado
   intermediário (`approved`), senão outro aprovador ainda enxerga o incidente como pendente.

## 3. Atritos já encontrados no BoundaryAttest (anotar para o retorno ao Cullen)

Antes de escrever uma linha, a leitura do código já mostra fricções reais — é exatamente o sinal que ele pediu:

1. **Distribuição:** `package.json` tem `"private": true` e `dist/` não é versionado → não dá `npm install agentreceipt`.
   Solução: dependência git fixada em commit (`github:cullenmeyers/BoundaryAttest#<sha>`) + `npm run build` no setup.
2. **Caminhos fixos relativos ao `cwd`:** `src/paths.ts` usa `.agentreceipt/keys` e `receipts/` sem configuração.
   Solução: o serviço roda com `WorkingDirectory` dedicado (ver §5.2).
3. **Geração silenciosa de chave:** `createSignedReceipt()` chama `setupKeys()`, que **gera uma chave nova** se não
   encontrar a existente. Em produção isso vira rotação silenciosa. Solução: checagem de chave no boot do serviço
   (falha se `public_key_id` ≠ o esperado configurado).
4. **Modelo "wrapper" vs. orquestração externa:** `withServerReceipt` foi feito para envolver um `handler` em
   processo. No n8n a ação já aconteceu em outro nó; o serviço recebe entrada+saída observadas e o `handler`
   só devolve a saída. Funciona, mas é atestação *post-hoc* — vale relatar.
5. **Cadeia só no sink local:** com sink customizado, `withServerReceipt` grava `previous_receipt_hash: null`.
   Solução: manter `LocalFileReceiptSink` (cadeia global) e espelhar no Postgres via `onReceipt`.
6. **Canonicalização legada:** `withServerReceipt` assina com `stableJson` (+ `localeCompare`), que é o formato
   v0.1. O Interop Profile v0.2 (JCS/RFC 8785) é outro caminho. Um export v0.2 (`approval_context` como campo do
   claim) fica como etapa opcional.
7. Nomes de arquivo de chave contêm `demo` (`agentreceipt-demo-private.pem`) mesmo em uso real.

## 4. Decisões que dependem de você (antes de começar)

| # | Pergunta | Recomendação |
|---|---|---|
| D1 | A severidade do W1 é `low/medium/high/critical` (não "ERROR/CRITICAL" como escrito na issue). Até onde `partial` aprova? | `partial` aprova `low` **e** `medium`. Incidentes escalados raramente são `low`, então "só low" deixaria o `partial` quase sempre sem ação. |
| D2 | Quem pode **rejeitar**? | Quem pode aprovar naquele momento também pode rejeitar. `junior` e `partial` fora da faixa só sugerem. |
| D3 | Se o serviço de recibos cair na hora da aprovação, a Fase 2 roda? | **Não** (fail-closed só para a Fase 2): sem o recibo de aprovação não há como vincular a evidência. Triagem/diagnóstico seguem fail-open (log + continua), coerente com o resto do projeto. Importante: isso é regra de *evidência*, a autorização continua sendo o token. |
| D4 | `caller.id` do humano: telefone ou ID estável? | ID estável (`approver:<id>`). O telefone é PII e ficaria em texto puro **assinado** para sempre; ele fica só na evidência guardada. |
| D5 | Assinar tentativas negadas (ex.: junior forjando um POST de approve)? | Sim, como recibo `incident.approval_decision` com `decision: "denied"` — é justamente a evidência multi-operador. Sugestões não geram recibo (baixo valor, "selective capture"). |

## 5. Plano por fases

Cada fase é entregável e testável isoladamente. A Fase A não depende do BoundaryAttest.

### Fase A — Multi-aprovador (enforcement nativo)

**A1. Schema (Postgres, via nó "CREATE IF NOT EXISTS" do W1 ou migração em `services/db/`)**

```sql
CREATE TABLE IF NOT EXISTS approvers (
  id               SERIAL PRIMARY KEY,
  name             TEXT NOT NULL,
  phone            TEXT NOT NULL UNIQUE,
  permission_level TEXT NOT NULL CHECK (permission_level IN ('full','partial','junior')),
  active           BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ DEFAULT now(),
  updated_at       TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS approval_tokens (
  id           SERIAL PRIMARY KEY,
  incident_id  INTEGER NOT NULL REFERENCES incidents(id),
  approver_id  INTEGER NOT NULL REFERENCES approvers(id),
  token_hash   TEXT NOT NULL UNIQUE,          -- sha256(token); o token em claro só vai no link
  expires_at   TIMESTAMPTZ NOT NULL,
  used_at      TIMESTAMPTZ,
  UNIQUE (incident_id, approver_id)
);

CREATE TABLE IF NOT EXISTS incident_suggestions (
  id          SERIAL PRIMARY KEY,
  incident_id INTEGER NOT NULL REFERENCES incidents(id),
  approver_id INTEGER NOT NULL REFERENCES approvers(id),
  body        TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE incidents ADD COLUMN IF NOT EXISTS decided_by INTEGER REFERENCES approvers(id);
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS decided_at TIMESTAMPTZ;
```

Política como função SQL única (fonte da verdade, versionada):

```sql
-- policy_version = 'approval-policy/v1'
CREATE OR REPLACE FUNCTION approval_capability(level TEXT, sev TEXT) RETURNS TEXT AS $$
  SELECT CASE
    WHEN level = 'full'                                  THEN 'approve'
    WHEN level = 'partial' AND sev IN ('low','medium')   THEN 'approve'   -- D1
    ELSE 'suggest_only'
  END $$ LANGUAGE sql IMMUTABLE;
```

`incidents.approval_token`/`token_used` ficam deprecados (manter as colunas até a migração estar validada).

**A2. W1 — notificação por aprovador**
- `Build Incident File` → Code node com `JSON.stringify` (achado 3).
- Gravar também `incidents.severity` no caminho escalado (hoje só o caminho `logged` grava).
- Substituir `Generate Token` + `Send Text` por:
  `SELECT id, name, phone, permission_level FROM approvers WHERE active` → Code (um token por aprovador,
  calcula `sha256`) → `INSERT INTO approval_tokens` → `Send Text` **por item**, com `remoteJid` vindo do banco.
- A mensagem diz a capacidade daquela pessoa ("você pode aprovar" / "você pode revisar e sugerir").

**A3. W2a — página de revisão (continua GET só-leitura)**
- Validar `incident + sha256(token)` em `approval_tokens` com join em `approvers`.
- Calcular `approval_capability(level, severity)` e renderizar:
  `approve` → Approve/Reject; `suggest_only` → só textarea "Sugestão". Isso é **UX**, não segurança.

**A4. W2b — decisão (a autoridade)**
Uma única query transacional (CTE) substitui o `UPDATE` atual:

```sql
WITH tok AS (
  UPDATE approval_tokens t SET used_at = now()
  FROM approvers a, incidents i
  WHERE t.token_hash = $2 AND t.incident_id = $1
    AND t.approver_id = a.id AND a.active
    AND i.id = t.incident_id AND i.status = 'awaiting_approval'
    AND t.expires_at > now() AND t.used_at IS NULL
  RETURNING t.incident_id, a.id AS approver_id, a.permission_level, i.severity,
            approval_capability(a.permission_level, i.severity) AS capability
), dec AS (
  UPDATE incidents i
  SET status = CASE WHEN $3 = 'approve' THEN 'approved' ELSE 'rejected' END,
      decided_by = tok.approver_id, decided_at = now()
  FROM tok
  WHERE i.id = tok.incident_id AND tok.capability = 'approve'
    AND $3 IN ('approve','reject') AND i.status = 'awaiting_approval'
  RETURNING i.id, i.diagnosis_json, i.workflow_id, i.workflow_name, i.node_name
)
SELECT tok.*, dec.id IS NOT NULL AS decision_applied, dec.diagnosis_json, dec.workflow_id
FROM tok LEFT JOIN dec ON true;
```

- A capacidade é recalculada **no momento do POST** a partir do banco (nunca do formulário).
- `i.status = 'awaiting_approval'` no segundo UPDATE garante "primeira decisão vence" entre aprovadores diferentes.
- Ramos: sem linha → link inválido; `decision_applied` → Fase 2 / rejeitado; `capability = suggest_only` com
  `action = suggest` → grava em `incident_suggestions` e avisa os `full` por WhatsApp; `suggest_only` com
  `action = approve|reject` → **negado** (e recibo, D5).
- Após decisão aplicada: `UPDATE approval_tokens SET used_at = now() WHERE incident_id = $1 AND used_at IS NULL`.
- Fase 2 termina com `status = 'pr_open' | 'failed_healing'` como hoje. Adicionar `'approved'` na lista de
  status ativos do `Check Dedup` do W1.

**Testes da Fase A** (usar `Test - Force Error`):
matriz 3 níveis × 4 severidades; POST forjado de `junior` com `action=approve`; duplo clique; dois aprovadores
`full` clicando ao mesmo tempo (só um dispara Fase 2); token de um aprovador usado para o incidente errado;
aprovador desativado depois da notificação.

### Fase B — Serviço de atestação (`services/attest/`)

**B1. Por que um serviço separado (e não Code node / Execute Command)**
- O Code node do n8n não importa o pacote local; e o **ponto crítico de custódia**: a Fase 2 roda o Claude Code
  como o usuário do n8n com `Read` e `Bash(git:*)` liberados. Se a chave privada estiver legível por esse usuário
  (ou dentro do repo), o agente de escrita consegue lê-la. A chave precisa morar fora do alcance do usuário do n8n.

**B2. Desenho**
- Node + TypeScript em `services/attest/`, dependência `agentreceipt` via git fixada em commit (atrito 1).
- Usuário de sistema próprio (`boundaryattest`), unit systemd, `WorkingDirectory=/var/lib/boundaryattest`
  (atrito 2), chave em `/var/lib/boundaryattest/.agentreceipt/keys` com `0600`, **fora do repo**.
- Escuta só em `127.0.0.1:<porta>`, header `Authorization: Bearer <segredo>` guardado como credential do n8n.
- No boot: carrega a chave e compara com `EXPECTED_PUBLIC_KEY_ID`; se não bater ou não existir, **não sobe** (atrito 3).
  Geração de chave só por comando explícito (`npm run keygen`).
- Endpoint único: `POST /receipts` com `{ stage, incident_id, caller, input, output | error, tool_metadata }`.
  Internamente:

```ts
const attest = withServerReceipt({
  agentId: "n8n-self-healing",
  tool: `incident.${stage}`,                 // triage | diagnose | approval_decision | fix
  caller,                                    // só id/type/authRef
  lineage: { ref: `incident:${incidentId}`, type: "workflow_run" },
  toolMetadata,
  receiptPolicy: { mode: "required", reason: stage },
  getReceiptInput: () => input,              // evidência de entrada
  handler: async () => { if (error) throw toError(error); return output; },  // atrito 4
  onReceipt: ({ receipt }) => saveToPostgres(receipt, { input, output, error, toolMetadata }),
});
```

- Sink: `LocalFileReceiptSink` (mantém `previous_receipt_hash` e o `npm run chain`) + espelho no Postgres pelo
  `onReceipt` (atrito 5). Um único processo → a fila serializada do sink local é suficiente.
- **Sem pruning** (`retention` desligado) — o histórico é o produto.
- Resposta: `{ receipt_id, receipt_hash, public_key_id }` (`receipt_hash = sha256(stableJson(receipt))`, a mesma
  conta que `receiptHash` faz na cadeia — essa função não é exportada em `public.ts`, então o serviço reimplementa
  ou importa de `dist/src/receipts.js`; mais um atrito para relatar).

**B3. Tabela de evidência**

```sql
CREATE TABLE IF NOT EXISTS incident_receipts (
  receipt_id     UUID PRIMARY KEY,
  incident_id    INTEGER NOT NULL REFERENCES incidents(id),
  stage          TEXT NOT NULL,
  receipt_json   JSONB NOT NULL,     -- recibo assinado, exatamente como emitido
  receipt_hash   TEXT NOT NULL,
  evidence_json  JSONB NOT NULL,     -- input/output/error/toolMetadata para recalcular os hashes
  created_at     TIMESTAMPTZ DEFAULT now()
);
```

Atenção: `JSONB` reordena chaves, mas isso não importa porque o hash é recalculado com `stableJson`, que ordena.
Mesmo assim, guardar também o texto original (`TEXT`) evita surpresa com números/unicode.

**Testes da Fase B:** unit tests com `node --test` (recibo válido, `verifyReceipt` falha com input alterado,
serviço recusa subir com chave errada, 401 sem token, recibo `failed` quando vem `error`).

### Fase C — Recibos em cada etapa do pipeline

Todos com `receipt_role: server_attested` e `lineage.ref = incident:<id>`.

| Etapa (tool) | Onde no n8n | `caller` | Input receiptado | Output | Em falha do serviço |
|---|---|---|---|---|---|
| `incident.triage` | W1, depois do `AI Agent` (ambos os ramos de `If1`) | `{type:"service", id:"n8n:W1"}` | `incident_id`, `fingerprint`, `workflow_id`, `node_name`, `error_message_sha256`, `recent_count` | `{severity, escalate, reason}` | fail-open |
| `incident.diagnose` | W1, depois do `Parse Diagnosis` | `{type:"service", id:"n8n:W1"}` | `incident_id`, `repo_head` (`git rev-parse HEAD` no mesmo Execute Command), `workflow_export_sha256`, `incident_file_sha256`, `prompt_sha256` (`prompts/diagnose.md`), `allowed_tools: "Read,Grep,Glob"`, `triage_receipt_id` | diagnóstico parseado + `cost_usd` | fail-open |
| `incident.approval_decision` | W2b, logo após a CTE da A4 (também nos negados) | `{type:"human", id:"approver:<id>", authRef:"whatsapp-single-use-token"}` | `incident_id`, `action`, `permission_level`, `severity`, `capability`, `policy_version: "approval-policy/v1"`, `token_ref: sha256(token)`, `diagnosis_receipt_id` | `{decision: approved\|rejected\|denied, token_consumed, decision_applied}` | **fail-closed para a Fase 2** (D3): marca `failed_healing`, avisa no WhatsApp |
| `incident.fix` | W2b, depois do `Parse PR Result` | `{type:"service", id:"n8n:W2b"}` | `incident_id`, **`approval_receipt_id`, `approval_receipt_hash`**, `base_commit`, `branch`, `prompt_sha256` (`prompts/fix.md`), `allowed_tools` | `{status, commit, pr_url, abort_reason_sha256}` | fail-open (a PR já existe) |

`toolMetadata` leva a identidade do modelo/ferramenta (ex.: `{ model: "openai/gpt-4o-mini", temperature: 0 }`,
`{ tool: "claude-code", version: "<claude --version>" }`) — conforme a regra do Cullen, o modelo **não** é o `caller`.

Ajustes associados:
- `.incident/current.json` da Fase 2 passa a incluir `approval_receipt_id` (só referência; o `prompts/fix.md` não
  muda de comportamento — o PR body pode citar o ID).
- Cada chamada ao serviço é um nó HTTP Request com "Continue On Fail" nos estágios fail-open.
- Nenhum valor de credential entra em input/output (regra do `CLAUDE.md`).

**Testes da Fase C:** um incidente ponta a ponta gera 4 recibos com a mesma lineage; o recibo `fix` referencia
o hash exato do recibo `approval_decision`; com o serviço parado, triagem/diagnóstico continuam e a Fase 2 não roda.

### Fase D — Verificação, exportação e documentação

- `services/attest/verify-incident.ts <incident_id>`: busca os recibos + evidência no Postgres, verifica assinatura
  com a chave pública, recalcula `input_hash`/`output_hash`, confere a ligação `fix.approval_receipt_hash` ==
  `receiptHash(approval)` e roda `chain` no diretório local.
- `export-incident-bundle`: gera `incident-<id>-bundle.json` (recibos + evidência + chave pública + `public_key_id`)
  — este é o artefato de *handoff* que o BoundaryAttest pretende proteger (revisor externo, auditoria pós-incidente).
- (Opcional) Export no Interop Profile v0.2 com `approval_context` dentro do claim (atrito 6).
- Docs: ADR `docs/decisions/boundaryattest-integration.md` com o que o recibo **prova** e **não prova**
  (não prova que o telefone é da pessoa, que a atribuição de permissão está certa, que a severidade está certa,
  nem que o host não foi comprometido); atualizar README (fluxograma, "Why it's built this way", "Known limitations").
- **Retorno ao Cullen** na issue #1: lista de atritos da §3 + o que aparecer na implementação (timing do recibo,
  empacotamento da evidência, comportamento em falha).

## 6. Ordem sugerida e tamanho

| Fase | Entrega | Depende de | Esforço estimado |
|---|---|---|---|
| Pré | Corrigir caminhos, telefone hardcoded, `Build Incident File` | — | pequeno |
| A | Multi-aprovador nativo (schema, W1, W2a, W2b, testes) | Pré, D1/D2 | médio |
| B | Serviço `services/attest/` + custódia de chave | D4 | médio |
| C | Recibos nos 4 estágios | A, B, D3/D5 | médio |
| D | Verificador, bundle, ADR, README, retorno ao Cullen | C | pequeno |

Cada fase em um branch/PR próprio, respeitando o `CLAUDE.md` (nunca editar `main` direto). Como os workflows são
editados no n8n e exportados pelo `Sub - Export Workflows`, o fluxo prático é: editar no n8n → exportar → PR.

## 7. Riscos

- **Chave legível pelo agente da Fase 2** → mitigado pelo usuário de sistema separado (B1). Validar com
  `sudo -u <usuario-n8n> cat /var/lib/boundaryattest/.agentreceipt/keys/*` → precisa dar *Permission denied*.
- **Cadeia global intercalada** entre incidentes → esperado e documentado; a correlação é pela lineage.
- **Chave única do host** → rotação não implementada; registrar `public_key_id` por período no ADR.
- **PII nos recibos** → só IDs e hashes no conteúdo assinado; telefones e mensagens de erro ficam na evidência
  (Postgres), que pode ser redigida no bundle exportado.
- **Dependência experimental** (BoundaryAttest v0.1, `private`) → commit fixado; a Fase A funciona sem ela.
