# W1 — Progress Notes (estudo pessoal)

Onde paramos, em ordem, com o porquê de cada peça:

## 1. Error Trigger
Dispara quando qualquer workflow que aponte pra ele (Settings → Error Workflow) falha
**de verdade** (webhook, schedule) — nunca em execução manual do editor.

Dado real que ele entrega (campos que importam):
- `workflow.id`, `workflow.name` — qual workflow quebrou
- `execution.lastNodeExecuted` — qual nó especificamente quebrou
- `execution.error.message` — a mensagem de erro
- `execution.url` — link pra ver a execução que falhou
- `execution.mode` — como foi disparado (webhook, schedule, etc — nunca "manual" aqui)

Não existe um campo limpo de "tipo de erro" (tipo `error.name`) — só `message` e `stack`.

## 2. Code in JavaScript (gera o fingerprint)
Pega os dados acima e cria uma "impressão digital" do erro:
- normaliza a mensagem (troca UUID/timestamp/número por placeholder — assim "erro na
  execução 4821" e "erro na execução 4822" viram o mesmo fingerprint, é o mesmo bug)
- concatena `workflow.id + node + mensagem normalizada`
- gera um hash SHA-256 disso (precisou liberar `crypto` no n8n via
  `NODE_FUNCTION_ALLOW_BUILTIN=crypto`, vem bloqueado por padrão)

Devolve: `fingerprint`, `workflow_id`, `workflow_name`, `node_name`, `error_message`,
`execution_url`.

## 3. Execute a SQL query (CREATE TABLE)
Garante que a tabela `incidents` existe no Postgres dedicado (`n8n-self-healing-db`,
porta 5433). Roda toda vez, mas só faz algo na primeira execução (`IF NOT EXISTS`).
**Precisa vir ANTES do Check Dedup** — se rodar depois, a consulta falha na
primeira vez porque a tabela ainda não existe.

## 4. Check Dedup
`SELECT id, occurrences FROM incidents WHERE fingerprint = $1 AND status IN
('triaging','awaiting_approval','pr_open')`.

Pergunta: esse erro específico já está sendo tratado agora? Usa o `fingerprint`
do passo 2.

⚠️ Pegadinha do n8n: se a query não acha nada, o node devolve **zero itens**, não
um item vazio — e nó nenhum roda sem item pra processar. Por isso precisa ligar
**"Always Output Data"** nas Settings desse node, senão o `IF` seguinte nunca roda
no caminho "não existe dedup".

⚠️ O `id` que sai daqui é o ID da **linha da tabela incidents** (a query só pediu
`id, occurrences`) — não confundir com `workflow_id` do passo 2, são coisas
diferentes.

## Próximo passo (não feito ainda)
`IF` depois do Check Dedup: `{{ $json.id }}` "is empty" →
- **True** (vazio, sem incidente ativo) → segue pro Gemini classificar severidade
- **False** (achou incidente) → incrementa `occurrences`, encerra

## Peças de infra já resolvidas (não precisa mexer de novo)
- n8n roda nativo via systemd (`/etc/systemd/system/n8n.service`), não mais Docker
- Env vars especiais nesse systemd (todas por causa de restrições de segurança
  padrão do n8n que não são óbvias): `N8N_RESTRICT_FILE_ACCESS_TO` (libera escrita
  no repo), `NODES_EXCLUDE` (reativa o Execute Command, vem desligado por padrão),
  `NODE_FUNCTION_ALLOW_BUILTIN=crypto` (libera módulo crypto no Code node)
- Postgres dedicado rodando em container Docker (`n8n-self-healing-db`, porta 5433,
  banco `incidents`, user `healing`) — senha em `.state/.pg-password` (fora do git)
- Sub-workflow `Sub - Export Workflows` pronto e testado (exporta pra `workflows/*.json`
  no repo, com commit/push automático)
- `W0 - Daily Export` pronto e ativo (roda 3h da manhã, chama o sub-workflow acima)
- Workflow de teste `Test - Force Error` (webhook `force-error` → Code que lança erro
  proposital) — usa esse pra testar o `W1` sempre que precisar, é só chamar
  `curl http://localhost:5678/webhook/force-error`
