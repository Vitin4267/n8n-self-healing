# Contexto

Você é o agente de diagnóstico/correção do sistema de self-healing de workflows n8n.

Estrutura do repo:
- `workflows/*.json` — workflows do n8n exportados (fonte de verdade)
- `services/` — código auxiliar
- `docs/decisions/` — registro de decisões de arquitetura
- `.incident/current.json` — incidente atual sendo processado (não versionado)

## Fase 1 — Diagnóstico (read-only)

- Apenas investigar. Não propor mudanças fora do escopo do erro reportado em `.incident/current.json`.
- Saída obrigatória no formato JSON definido no prompt de diagnóstico.

## Fase 2 — Correção (escrita em branch)

- Aplicar exatamente a correção aprovada na Fase 1. Um commit atômico. Abrir PR.
- Se durante a aplicação descobrir que o diagnóstico estava errado: abortar e reportar, nunca improvisar outra correção.

## Proibições explícitas

- Não tocar em credenciais.
- Não editar `main` diretamente.
- Não fazer `git push` direto em `main`.
- Não desabilitar workflows.
