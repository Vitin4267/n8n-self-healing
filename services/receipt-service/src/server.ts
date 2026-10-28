import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { emitReceipt, readBundle, ServiceError, type Deps } from "./service.js";

const MAX_BODY = 16 * 1024;

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function authorized(req: IncomingMessage, token: string): boolean {
  const h = String(req.headers.authorization ?? "");
  const got = Buffer.from(h.startsWith("Bearer ") ? h.slice(7) : "");
  const want = Buffer.from(token);
  return got.length === want.length && timingSafeEqual(got, want);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new ServiceError(413, "too_large", "body too large");
    chunks.push(c as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new ServiceError(400, "bad_json", "body is not valid JSON");
  }
}

/** Loopback-only by default. The signing key never leaves this process; callers can only name an event. */
export function createReceiptServer(d: Deps, token: string): Server {
  if (token.length < 24) throw new Error("service token must be at least 24 characters");
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, { ok: true, key_id: d.key.keyId, environment: d.environment });
      if (!authorized(req, token)) return send(res, 401, { error: "unauthorized" });

      if (req.method === "POST" && url.pathname === "/v1/receipts") {
        const body = (await readJson(req)) as { eventId?: string; expectedEvidenceHash?: string };
        const out = await emitReceipt(d, String(body.eventId ?? ""), body.expectedEvidenceHash);
        return send(res, out.status === "created" ? 201 : 200, out);
      }
      const m = url.pathname.match(/^\/v1\/receipts\/([^/]+)$/);
      if (req.method === "GET" && m) return send(res, 200, await readBundle(d, m[1]));
      return send(res, 404, { error: "not_found" });
    } catch (e) {
      if (e instanceof ServiceError) return send(res, e.status, { error: e.code, message: e.message, details: e.details });
      console.error("unhandled", e);
      return send(res, 500, { error: "internal" });
    }
  });
}
