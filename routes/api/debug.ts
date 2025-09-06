// routes/api/debug.ts
import type { Handlers } from "$fresh/server.ts";

/** IP aus Forwarding-Headern oder ConnInfo ziehen */
function pickIp(req: Request, connInfo?: { remoteAddr?: Deno.Addr }) {
  const xf = req.headers.get("x-forwarded-for");
  if (xf) return xf.split(",")[0].trim();
  const cf = req.headers.get("cf-connecting-ip");
  if (cf) return cf;

  try {
    const ra = (connInfo as any)?.remoteAddr;
    if (ra && typeof ra === "object") {
      return (ra.hostname ?? (ra as any).host ?? "unknown");
    }
  } catch { /* ignore */ }
  return "unknown";
}

export const handler: Handlers = {
  async POST(req, ctx) {
    let body: any = {};
    try { body = await req.json(); } catch { /* ignore */ }

    const event = String(body?.event ?? "debug.event");
    const detail = body?.detail ?? {};
    const chatIdx = body?.chatIdx ?? detail?.chat ?? "";

    const ip = pickIp(req, (ctx as any));
    const ua = req.headers.get("user-agent") ?? "unknown";
    const ts = new Date().toISOString();

    console.log(
      `[DEBUG ${ts}] ${event} ip=${ip} ua=${ua} chat=${chatIdx || ""} detail=${JSON.stringify(detail)}`
    );

    return new Response(null, { status: 204 });
  },

  GET(_req) {
    return new Response("ok", {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  },
};
