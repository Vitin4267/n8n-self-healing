# n8n Self-Healing

Sistema de auto-recuperação de workflows do n8n: detecção de erro → triagem (Gemini) →
diagnóstico (Claude Code, read-only) → aprovação humana por e-mail → correção (Claude Code, branch + PR) → deploy.

Ver `docs/decisions/` para os porquês de cada decisão de arquitetura.
