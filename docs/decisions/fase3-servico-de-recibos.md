# Fase 3 — serviço de recibos (BoundaryAttest `server_attested`)

Segue o [plano](plano-multi-aprovadores-boundaryattest-chatgpt.md) (seções 4–5) e a
[Fase 2](fase2-isolamento-e-versao-do-diagnostico.md). **Nada na autorização depende deste serviço**:
ele só registra evidência. Desligá-lo não muda quem pode aprovar o quê (rollback da fase).

## O que existe (`services/receipt-service/`)

- **Dependência fixada**: só 5 arquivos do BoundaryAttest (`hash`, `signing`, `receipts`, `keys`,
  `paths`) copiados sem modificação do commit `aa443e9`, com licença e `VENDORED.md`. Sem MCP/zod.
  Formato **nativo** (`stableJson`), não o RFC 8785 do Interop Profile v0.2.
- **O serviço só recebe o id de um evento** que o n8n *já gravou* em `incident_events`. Estágio, nível,
  severidade, caller, saída: tudo vem da linha armazenada. Um POST que tenta mandar `stage`/`level`
  é ignorado (teste dedicado).
- **Ledger append-only** (`incident_events`, `incident_receipts`): gatilhos bloqueiam UPDATE/DELETE/
  TRUNCATE; um recibo por evento; chave de idempotência `(incident, stage, attempt)`.
- **Idempotente e concorrente**: lock advisory por evento; 8 requisições simultâneas → 1 recibo.
  Mesmo evento com conteúdo diferente → 409, nunca sobrescreve.
- **Evidência que contradiz a política é recusada, não assinada** (ex.: `junior` decidindo, `partial`
  decidindo `high`). O recibo do `fix` só é emitido se apontar para um recibo de `approval` **real,
  do mesmo incidente, para a mesma versão do diagnóstico, e que seja uma aprovação** (não rejeição).
- **Chave**: o preflight carrega a chave ou **falha**; nunca gera. Só `keygen` cria, e recusa
  sobrescrever. Permissões frouxas, par de chaves que não casa e id adulterado também falham.
  (A `setupKeys()` do BoundaryAttest geraria outra chave em silêncio; por isso o serviço não a usa.)
- **Verificador** (`cli.js verify`): reporta separado integridade criptográfica, confiança na chave,
  consistência da evidência e referências. Chaves confiáveis vêm de `trusted-keys.json`.
- **HTTP** só em loopback, token Bearer em tempo constante, corpo limitado a 16 KB.
- **Banco**: papel `receipts_svc` só lê eventos e lê/insere recibos. Verificado: não lê `incidents`,
  `approvers`, `approval_tokens`; não altera, não apaga, não cria tabela.

## Testes

`cd services/receipt-service && RECEIPT_TEST_DB_URL=… npm test` — **47 testes**, todos passando:
conformidade campo a campo com o `createSignedReceipt` real do BoundaryAttest; 8 de chaves; 19 de
adulteração; 11 do serviço com Postgres real (schema descartável); 6 do HTTP.

Critérios de aceite do plano, no **deploy real** (chave de produção, tabelas reais):
adulterar nível/severidade/saída/caller/lineage invalida; reiniciar preserva a chave e o recibo;
repetir o evento devolve o mesmo recibo; sem chave o serviço **não sobe e não cria nada**.

## Custódia da chave: o que está feito e o que não está

- **Feito (modo não-root, `deploy/provision.sh`)**: chave em `~/.local/share/n8n-self-healing-attest`
  (dir 0700, chave 0600), env e token 0600 fora do repo. **Limite honesto:** é o *mesmo usuário Unix*
  que roda o n8n e o Claude Code, então quem executa o pipeline consegue ler a chave. Protege contra
  vazamento acidental e contra o repo, **não** contra um n8n comprometido.
- **Modo endurecido instalado e verificado (`deploy/install-hardened-root.sh`)**: usuário de sistema
  `boundaryattest`, código read-only em `/opt`, chave/token/env só legíveis por ele, unit com sandbox
  (`active`, `enabled`). Verificado como o usuário que roda n8n/Claude: **"Permissão negada"** ao ler
  a chave privada, o token e o env, e ao listar o diretório de chaves. Identidade atual:
  `sha256:5c2e09a1e2850c9ca6213362` (a chave anterior, de usuário comum, `sha256:f311d82d5894d51f852f7a1a`,
  continua em `trusted-keys.json` só para verificar o que ela já assinou; seu arquivo deve ser apagado).
  Dois bugs do instalador apareceram só na execução real (o primeiro: `tsc` ausente com `--omit=dev`).
- O serviço agora é um unit de sistema (instalado pelo dono com `sudo`). `deploy/run.sh` e
  `loginctl enable-linger` deixam de ser necessários.

## Não coberto / próximos passos

- Fases 4–6: o n8n ainda **não grava eventos nem chama o serviço**. Hoje o serviço está provado, mas
  desligado do pipeline.
- `trusted-keys.json` vem do próprio repo: quem escreve no repo troca a chave "confiável". Para um
  verificador externo, a chave pública tem de ser publicada por um canal separado.
- O timestamp assinado é declaração do host, não carimbo de tempo independente.
- O dono do banco (`healing`, superusuário) ainda consegue desligar os gatilhos; eles barram
  acidente e o `receipts_svc`, não um administrador malicioso.
