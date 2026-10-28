# Smoke test do serviço de recibos (depois de qualquer deploy)

Usa o token de `~/.config/n8n-self-healing-attest/token` (modo não-root) ou `/etc/n8n-self-healing-attest/token` (endurecido).

1. `curl -s 127.0.0.1:8787/healthz` → `{"ok":true,"key_id":"sha256:…"}` e o `key_id` está em `trusted-keys.json`.
2. Sem token: `curl -s -o /dev/null -w '%{http_code}' -X POST 127.0.0.1:8787/v1/receipts -d '{}'` → `401`.
3. Evento inexistente com token → `404` (prova que o serviço leu o banco com o papel mínimo).
4. Emitir um evento real (ou sintético, mas **apague-o depois**: o ledger é append-only) → `201`; de novo → `200` com o mesmo `receipt_id`.
5. `GET /v1/receipts/<eventId>` → salvar → `node dist/src/cli.js verify bundle.json --trusted trusted-keys.json` → `ok: true`, exit 0.
6. Mudar um campo da evidência no bundle → `ok: false`, exit 1.
7. Reiniciar o serviço: mesmo evento → `200`, mesmo `receipt_id`, mesma chave.
8. Apontar `RECEIPT_KEY_DIR` para um diretório vazio → o serviço **recusa subir** (`KEY_MISSING`) e não cria arquivo.
