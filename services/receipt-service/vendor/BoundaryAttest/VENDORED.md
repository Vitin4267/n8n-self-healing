# Vendored: BoundaryAttest

- Upstream: https://github.com/cullenmeyers/BoundaryAttest (MIT, see LICENSE)
- Commit: `aa443e96449a0fb9793f70c2060564dbe289a894` (2026-10-25)
- Files copied unmodified from `src/`: `hash.ts`, `signing.ts`, `receipts.ts`, `keys.ts`, `paths.ts`
  (nothing else: no MCP adapter, no zod, no sinks).
- Why vendored and pinned: the upstream package is `private` and its API is explicitly
  experimental; receipts must stay verifiable, so updates must be a reviewed diff, never a float.
- **Never call `createSignedReceipt`/`setupKeys` from this repo's service**: `setupKeys()` silently
  generates a NEW signing key if the key files are missing. The service signs with
  `signReceiptPayload` and its own key loader (see `../../src/keys.ts`).
- Receipt format: BoundaryAttest *native* (`stableJson`, ordered with `localeCompare`), NOT the
  RFC 8785 Interop Profile v0.2. Do not mix them.
