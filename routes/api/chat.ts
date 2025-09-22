// routes/api/chat.ts
import { Handlers } from "$fresh/server.ts";
import { ServerSentEventStream } from "https://deno.land/std@0.210.0/http/server_sent_event_stream.ts";
import { chatContent } from "../../internalization/content.ts";

const API_URL = Deno.env.get("LLM_URL") || "";
const API_KEY = Deno.env.get("LLM_KEY") || "";
const API_MODEL = Deno.env.get("LLM_MODEL") || "";
const API_IMAGE_URL = Deno.env.get("VLM_URL") || "";
const API_IMAGE_KEY = Deno.env.get("VLM_KEY") || "";
const API_IMAGE_MODEL = Deno.env.get("VLM_MODEL") || "";
const API_IMAGE_CORRECTION_MODEL = Deno.env.get("VLM_CORRECTION_MODEL") || "";
const MIDDLEWARE_BASE_URL = Deno.env.get("MIDDLEWARE_URL") || "";


interface Message {
  role: string;
  // deno-lint-ignore no-explicit-any
  content: string | any[];
}

/** Robust extraction of assistant text from non-stream JSON (OpenAI / Gemini / misc) */
// deno-lint-ignore no-explicit-any
function extractAssistantText(anyJson: any): string {
  if (!anyJson) return "";
  try {
    const ch = anyJson?.choices ?? [];
    if (ch.length) {
      const c0 = ch[0];
      if (typeof c0?.message?.content === "string") return c0.message.content;
      if (typeof c0?.text === "string") return c0.text;
      if (typeof c0?.delta?.content === "string") return c0.delta.content;
    }
  } catch (_) {}
  try {
    // Gemini shape
    const cands = anyJson?.candidates ?? [];
    if (cands.length) {
      const parts = cands[0]?.content?.parts ?? [];
      const txt = parts.map((p: any) => p?.text ?? "").join("");
      if (txt) return txt;
    }
  } catch (_) {}
  if (typeof anyJson?.output_text === "string") return anyJson.output_text;
  if (typeof anyJson?.content === "string") return anyJson.content;
  if (Array.isArray(anyJson?.content)) {
    const txt = anyJson.content.map((p: any) => p?.text ?? "").join("");
    if (txt) return txt;
  }
  return "";
}

/** Turn plain text into a minimal OpenAI-style SSE stream for our UI
 *  NOTE: Wenn kein Text vorhanden ist, senden wir KEIN roles-Delta,
 *  sondern ein eigenes Event 'no_content', damit die UI keinen leeren
 *  Assistenten-Ballon rendert.
 */
function sseFromText(text: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  if (!text || !text.length) {
    const noContent = `event: no_content\ndata: {}\n\n`;
    const end = `data: [DONE]\n\n`;
    return new ReadableStream({
      start(controller) {
        controller.enqueue(enc.encode(noContent));
        controller.enqueue(enc.encode(end));
        controller.close();
      },
    });
  }
  const start = `data: ${JSON.stringify({ choices: [{ delta: { role: "assistant" } }] })}\n\n`;
  const body = `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
  const end = `data: [DONE]\n\n`;
  return new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode(start));
      controller.enqueue(enc.encode(body));
      controller.enqueue(enc.encode(end));
      controller.close();
    },
  });
}

// deno-lint-ignore no-explicit-any
function hasKorrekturHashtag(messages: any[]): boolean {
  if (!messages || messages.length === 0) return false;
  const last = messages[messages.length - 1];
  if (!last || !last.content) return false;

  let content = "";
  if (typeof last.content === "string") {
    content = last.content;
  } else if (Array.isArray(last.content)) {
    const textContent = last.content.find((it: any) => it.type === "text");
    content = textContent?.text || "";
  }
  content = content.toLowerCase();
  return content.includes("#korrektur") || content.includes("#correction");
}

// --- REPLACE THE WHOLE FUNCTION STARTING HERE ---
async function getModelResponseStream(
  messages: Message[],
  lang: string,
  universalApiKey: string,
  llmApiUrl: string,
  llmApiKey: string,
  llmApiModel: string,
  systemPrompt: string,
  vlmApiUrl: string,
  vlmApiKey: string,
  vlmApiModel: string,
  vlmCorrectionModel: string,
  wantsStream: boolean | undefined, // NEW
) {
  const MIDDLEWARE_BASE_URL = "http://65.109.157.234:8787";

  // If a universal key is provided, override URLs to the middleware.
  if (universalApiKey) {
    llmApiUrl = `${MIDDLEWARE_BASE_URL}/v1/chat/completions`;
    vlmApiUrl = `${MIDDLEWARE_BASE_URL}/v1/chat/completions`;
    llmApiKey = universalApiKey;
    vlmApiKey = universalApiKey;
  }

  // 1) Universal key format check
  if (universalApiKey !== "" && !universalApiKey.toLowerCase().startsWith("sbe-")) {
    return new Response("Invalid Universal API Key. It needs to start with 'sbe-'.", { status: 400 });
  }

  // 2) Strip trailing assistant messages
  let isLastAssistant = messages[messages.length - 1]?.role === "assistant";
  while (isLastAssistant) {
    messages.pop();
    isLastAssistant = messages[messages.length - 1]?.role === "assistant";
  }

  // 3) Correction flag
  const isCorrectionInLastMessage = hasKorrekturHashtag(messages);

  // 4) System prompt
  let useThisSystemPrompt = isCorrectionInLastMessage
    ? chatContent[lang].correctionSystemPrompt
    : chatContent[lang].systemPrompt;
  if (systemPrompt != "") useThisSystemPrompt = systemPrompt;
  messages.unshift({ role: "system", content: useThisSystemPrompt });

  // 5) Multimodality detection
  const isImageInMessages = messages.some(
    (m) => Array.isArray(m.content) && m.content.some((p: any) => p.type === "image_url"),
  );
  const isPdfInMessages = messages.some(
    (m) => Array.isArray(m.content) && m.content.some((p: any) => p.type === "pdf"),
  );

  // 6) Direct PDF → Gemini only when NO universal key (otherwise middleware handles PDFs)
  if (isPdfInMessages && !(universalApiKey && universalApiKey.trim().length > 0)) {
    const geminiApiKey = vlmApiKey || Deno.env.get("VLM_KEY") || "";
    const geminiModel = vlmApiModel || Deno.env.get("VLM_MODEL") || "gemini-2.5-pro";
    if (!geminiApiKey) {
      return new Response("Missing VLM API key for PDF processing (expected Google AI Studio key).", { status: 400 });
    }

    const systemMessage = messages.find((m) => m.role === "system");
    const systemInstruction = systemMessage?.content
      ? {
          role: "system",
          parts: [
            {
              text:
                typeof systemMessage.content === "string"
                  ? systemMessage.content
                  : Array.isArray(systemMessage.content)
                  ? (systemMessage.content.find((c: any) => c.type === "text")?.text || "")
                  : "",
            },
          ],
        }
      : undefined;

    const geminiContents = messages
      .filter((m) => m.role !== "system")
      .map((m) => {
        const parts: any[] = [];
        if (typeof m.content === "string") {
          if (m.content.trim() !== "") parts.push({ text: m.content });
        } else if (Array.isArray(m.content)) {
          for (const c of m.content) {
            if (c.type === "text" && c.text && c.text.trim() !== "") {
              parts.push({ text: c.text });
            } else if (c.type === "pdf" && c.data) {
              parts.push({ inlineData: { mimeType: c.mime_type || "application/pdf", data: c.data } });
            } else if (c.type === "image_url" && c.image_url?.url?.startsWith("data:")) {
              const dataUrl = c.image_url.url;
              const commaIdx = dataUrl.indexOf(",");
              const header = dataUrl.substring(5, commaIdx); // e.g. image/png;base64
              const base64 = dataUrl.substring(commaIdx + 1);
              const mimeType = header.split(";")[0];
              parts.push({ inlineData: { mimeType, data: base64 } });
            }
          }
        }
        return { role: m.role === "assistant" ? "model" : "user", parts };
      });

    if (wantsStream !== false) {
      const geminiUrl =
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiModel)}` +
        `:streamGenerateContent?alt=sse&key=${encodeURIComponent(geminiApiKey)}`;

      const geminiBody: any = {
        contents: geminiContents,
        generationConfig: { thinkingConfig: { thinkingBudget: -1 } },
        tools: [{ googleSearch: {} }],
        ...(systemInstruction ? { systemInstruction } : {}),
      };

      function collectTextFields(obj: any, out: string[]) {
        if (!obj) return;
        if (typeof obj === "object") {
          for (const k in obj) {
            const v = obj[k];
            if (k === "text" && typeof v === "string") out.push(v);
            else collectTextFields(v, out);
          }
        }
      }

      return new Response(
        new ReadableStream({
          async start(controller) {
            let closed = false;
            let sentAny = false;
            const finish = () => {
              if (closed) return;
              // Wenn kein Text kam: no_content signalisieren
              if (!sentAny) {
                controller.enqueue({ event: "no_content", data: "{}", id: Date.now() });
              }
              closed = true;
              controller.close();
            };

            try {
              const resp = await fetch(geminiUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(geminiBody),
              });

              if (!resp.ok || !resp.body) {
                const errText = await resp.text().catch(() => "");
                controller.enqueue({
                  event: "error",
                  data: JSON.stringify({
                    provider: "gemini",
                    model: geminiModel,
                    status: resp.status,
                    message: errText || resp.statusText || "Upstream error",
                  }),
                  id: Date.now(),
                });
                controller.enqueue({ data: "[DONE]", event: "message", id: Date.now() });
                finish();
                return;
              }

              const reader = resp.body.getReader();
              const decoder = new TextDecoder();
              let buffer = "";
              let currentEvent = "message";

              readLoop: while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop() || "";

                for (const raw of lines) {
                  const line = raw.trimEnd();
                  if (line.startsWith("event: ")) {
                    currentEvent = line.slice(7).trim() || "message";
                    continue;
                  }
                  if (!line.startsWith("data: ")) continue;

                  const payload = line.slice(6).trim();
                  if (payload === "[DONE]") {
                    finish();
                    break readLoop;
                  }
                  if (currentEvent === "error") {
                    controller.enqueue({ event: "error", data: payload, id: Date.now() });
                    currentEvent = "message";
                    continue;
                  }
                  try {
                    const json = JSON.parse(payload);
                    const parts: string[] = [];
                    collectTextFields(json, parts);
                    const chunk = parts.join("");
                    if (chunk) {
                      sentAny = true;
                      controller.enqueue({ data: JSON.stringify(chunk), id: Date.now(), event: "message" });
                    }
                  } catch {
                    // ignore
                  }
                }
              }
              finish();
            } catch (e: any) {
              controller.enqueue({
                event: "error",
                data: JSON.stringify({
                  provider: "gemini",
                  model: geminiModel,
                  status: 502,
                  message: String(e?.message || e || "Network error"),
                }),
                id: Date.now(),
              });
              controller.enqueue({ data: "[DONE]", event: "message", id: Date.now() });
              finish();
            }
          },
          cancel(err) {
            // Silence normal closures; log only unexpected ones.
            const s = String(err || "").toLowerCase();
            if (err && !s.includes("resource closed") && !s.includes("aborterror")) {
              console.warn("SSE canceled:", err);
            }
          },
        }).pipeThrough(new ServerSentEventStream()),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    } else {
      const url =
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiModel)}` +
        `:generateContent?key=${encodeURIComponent(geminiApiKey)}`;
      const body = {
        contents: geminiContents,
        generationConfig: { thinkingConfig: { thinkingBudget: -1 } },
        tools: [{ googleSearch: {} }],
        ...(systemInstruction ? { systemInstruction } : {}),
      };
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const txt = await r.text();
      return new Response(txt, {
        status: r.status,
        headers: { "Content-Type": r.headers.get("content-type") ?? "application/json" },
      });
    }
  }

  // 7) LLM/VLM (no PDF) → upstream (middleware or direct)
  let useApiUrl = llmApiUrl || Deno.env.get("LLM_URL") || API_URL;
  let useApiKey = llmApiKey || Deno.env.get("LLM_KEY") || API_KEY;
  let useApiModel = llmApiModel || Deno.env.get("LLM_MODEL") || API_MODEL;

  if (isImageInMessages) {
    useApiUrl = vlmApiUrl || Deno.env.get("VLM_URL") || API_IMAGE_URL;
    useApiKey = vlmApiKey || Deno.env.get("VLM_KEY") || API_IMAGE_KEY;
    const chosenVlmModel =
      isCorrectionInLastMessage && vlmCorrectionModel
        ? vlmCorrectionModel
        : vlmApiModel || Deno.env.get("VLM_MODEL") || API_IMAGE_MODEL;
    useApiModel = chosenVlmModel;
  }

  // Non-stream: pass JSON straight through
  if (wantsStream === false) {
    const resp = await fetch(useApiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${useApiKey}` },
      body: JSON.stringify({ model: useApiModel, stream: false, messages }),
    });
    const txt = await resp.text();
    return new Response(txt, {
      status: resp.status,
      headers: { "Content-Type": resp.headers.get("content-type") ?? "application/json" },
    });
  }

  // Stream: request SSE and forward
  return new Response(
    new ReadableStream({
      async start(controller) {
        let closed = false;
        let sentAny = false;
        const finish = () => {
          if (closed) return;
          if (!sentAny) {
            controller.enqueue({ event: "no_content", data: "{}", id: Date.now() });
          }
          closed = true;
          controller.close();
        };

        try {
          const upstream = await fetch(useApiUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${useApiKey}` },
            body: JSON.stringify({ model: useApiModel, stream: true, messages }),
          });

          if (!upstream.ok || !upstream.body) {
            const errText = await upstream.text().catch(() => "");
            controller.enqueue({
              event: "error",
              data: JSON.stringify({
                provider: "middleware",
                model: useApiModel,
                status: upstream.status,
                message: errText || upstream.statusText || "Upstream error",
              }),
              id: Date.now(),
            });
            controller.enqueue({ data: "[DONE]", event: "message", id: Date.now() });
            finish();
            return;
          }

          const ctype = (upstream.headers.get("content-type") || "").toLowerCase();
          const isSSE = ctype.includes("text/event-stream");
          const decoder = new TextDecoder();

          if (isSSE) {
            const reader = upstream.body.getReader();
            let buffer = "";
            let currentEvent = "message";

            readLoop: while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split("\n");
              buffer = lines.pop() || "";

              for (const raw of lines) {
                const line = raw.trimEnd();

                if (line === "data: [DONE]") {
                  finish();
                  continue;
                }
                if (line.startsWith("event: ")) {
                  currentEvent = line.slice(7).trim() || "message";
                  continue;
                }
                if (!line.startsWith("data: ")) continue;

                const jsonStr = line.substring(6);

                if (currentEvent === "error") {
                  controller.enqueue({ event: "error", data: jsonStr, id: Date.now() });
                  currentEvent = "message";
                  continue;
                }

                try {
                  const data = JSON.parse(jsonStr);
                  const delta = data?.choices?.[0]?.delta;
                  if (delta?.content !== undefined && delta?.content !== null) {
                    if (delta.content === "<|im_end|>") {
                      finish();
                    } else {
                      sentAny = true;
                      controller.enqueue({ data: JSON.stringify(delta.content), id: Date.now(), event: "message" });
                    }
                  }
                  if (data?.error) {
                    controller.enqueue({ event: "error", data: JSON.stringify(data.error), id: Date.now() });
                  }
                } catch {
                  if (jsonStr.toLowerCase().includes("error")) {
                    controller.enqueue({ event: "error", data: JSON.stringify({ message: jsonStr }), id: Date.now() });
                  }
                }
              }
            }
            finish();
          } else {
            // Non-SSE fallback → convert JSON to mini-SSE
            const raw = await upstream.text();
            let text = "";
            try {
              text = extractAssistantText(JSON.parse(raw));
            } catch {
              text = raw;
            }
            const stream = sseFromText(text);
            const reader = stream.getReader();
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              // sseFromText sendet bei leerem Text 'event: no_content'
              // und bei nicht-leerem Text role+content.
              controller.enqueue(value);
              if (!sentAny) {
                // Heuristik: sobald irgendein content-Frame kam, markiere sentAny
                // (role-Delta kommt nur wenn Text existiert).
                // Wir setzen sentAny true, wenn der Chunk einen content trägt.
                try {
                  const s = new TextDecoder().decode(value);
                  if (s.includes('"content"')) sentAny = true;
                } catch {}
              }
            }
            finish();
          }
        } catch (e: any) {
          controller.enqueue({
            event: "error",
            data: JSON.stringify({
              provider: "middleware",
              model: useApiModel,
              status: 502,
              message: String(e?.message || e || "Network error"),
            }),
            id: Date.now(),
          });
          controller.enqueue({ data: "[DONE]", event: "message", id: Date.now() });
          finish();
        }
      },
      cancel(err) {
        const s = String(err || "").toLowerCase();
        if (err && !s.includes("resource closed") && !s.includes("aborterror")) {
          console.warn("SSE canceled:", err);
        }
      },
    }).pipeThrough(new ServerSentEventStream()),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}
// --- REPLACE THE WHOLE FUNCTION ENDING HERE ---

export const handler: Handlers = {
  // Canonical entry: POST with JSON payload
  async POST(req: Request) {
    const payload = await req.json();
    const wantsStream: boolean | undefined = payload.stream;
    return getModelResponseStream(
      payload.messages as Message[],
      payload.lang,
      payload.universalApiKey,
      payload.llmApiUrl, payload.llmApiKey, payload.llmApiModel,
      payload.systemPrompt,
      payload.vlmApiUrl, payload.vlmApiKey, payload.vlmApiModel, payload.vlmCorrectionModel,
      wantsStream,
    );
  },

  // Allow GET (some clients/openers use EventSource or trigger GET accidentally)
  // Accepts ?payload=<base64(json)> — if missing/invalid, return SSE error with guidance.
  async GET(req: Request) {
    const url = new URL(req.url);
    const payloadParam = url.searchParams.get("payload");
    if (!payloadParam) {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              `event: error\ndata: ${JSON.stringify({
                status: 405,
                message: "Use POST with JSON body or GET with ?payload=<base64(json)>",
              })}\n\n`,
            ),
          );
          controller.enqueue(new TextEncoder().encode(`data: [DONE]\n\n`));
          controller.close();
        },
      });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
    }

    let payload: any;
    try {
      const jsonStr = atob(payloadParam);
      payload = JSON.parse(jsonStr);
    } catch {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              `event: error\ndata: ${JSON.stringify({
                status: 400,
                message: "Invalid ?payload. Must be base64-encoded JSON.",
              })}\n\n`,
            ),
          );
          controller.enqueue(new TextEncoder().encode(`data: [DONE]\n\n`));
          controller.close();
        },
      });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
    }

    const wantsStream: boolean | undefined = payload.stream;
    return getModelResponseStream(
      payload.messages as Message[],
      payload.lang,
      payload.universalApiKey,
      payload.llmApiUrl, payload.llmApiKey, payload.llmApiModel,
      payload.systemPrompt,
      payload.vlmApiUrl, payload.vlmApiKey, payload.vlmApiModel, payload.vlmCorrectionModel,
      wantsStream,
    );
  },

  // Handle preflight cleanly to avoid 405 on OPTIONS
  async OPTIONS(_req: Request) {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  },
};
