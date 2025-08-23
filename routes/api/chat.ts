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

/** Turn plain text into a minimal OpenAI-style SSE stream for our UI */
function sseFromText(text: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const start = `data: ${JSON.stringify({ choices: [{ delta: { role: "assistant" } }] })}\n\n`;
  const body =
    text && text.length
      ? `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`
      : "";
  const end = `data: [DONE]\n\n`;
  return new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode(start));
      if (body) controller.enqueue(enc.encode(body));
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

  // If a universal key is provided, it ALWAYS overrides the other URLs
  // to point to your central middleware.
  if (universalApiKey) {
    llmApiUrl = `${MIDDLEWARE_BASE_URL}/v1/chat/completions`;
    vlmApiUrl = `${MIDDLEWARE_BASE_URL}/v1/chat/completions`; // VLM uses the same endpoint
    llmApiKey = universalApiKey;
    vlmApiKey = universalApiKey;
  }
  // 1) Universal-Key Gate (wie zuvor)
  if (universalApiKey !== "" && !universalApiKey.toLowerCase().startsWith("sbe-")) {
    return new Response("Invalid Universal API Key. It needs to start with 'sbe-'.", { status: 400 });
  }

  // 2) Trailing assistant messages entfernen (wie zuvor)
  let isLastAssistant = messages[messages.length - 1]?.role === "assistant";
  while (isLastAssistant) {
    messages.pop();
    isLastAssistant = messages[messages.length - 1]?.role === "assistant";
  }

  // 3) Korrektur-Flag
  const isCorrectionInLastMessage = hasKorrekturHashtag(messages);

  // 4) Systemprompt wählen
  let useThisSystemPrompt = isCorrectionInLastMessage
    ? chatContent[lang].correctionSystemPrompt
    : chatContent[lang].systemPrompt;
  if (systemPrompt != "") useThisSystemPrompt = systemPrompt;
  messages.unshift({ role: "system", content: useThisSystemPrompt });

  // 5) Multimodalität erkennen
  const isImageInMessages = messages.some((m) =>
    Array.isArray(m.content) && m.content.some((p: any) => p.type === "image_url")
  );
  const isPdfInMessages = messages.some((m) =>
    Array.isArray(m.content) && m.content.some((p: any) => p.type === "pdf")
  );

  // 6) PDF → Gemini
  if (isPdfInMessages) {
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

    // Gemini-contents
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

    // Stream- oder Non-Stream-Weg
    if (wantsStream !== false) {
      // SSE-Streaming
      const geminiUrl =
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiModel)}` +
        `:streamGenerateContent?alt=sse&key=${encodeURIComponent(geminiApiKey)}`;

      const geminiBody: any = {
        contents: geminiContents,
        generationConfig: { thinkingConfig: { thinkingBudget: -1 } },
        tools: [{ googleSearch: {} }],
      };
      if (systemInstruction) geminiBody.systemInstruction = systemInstruction;

      // Textrekursion aus SSE-Events
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
            try {
              const resp = await fetch(geminiUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(geminiBody) });
              if (!resp.ok || !resp.body) {
                controller.error(new Error(`Gemini API error: ${resp.status} ${resp.statusText}`));
                controller.close();
                return;
              }
              const reader = resp.body.getReader();
              const decoder = new TextDecoder();
              let buffer = "";
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop() || "";
                for (const line of lines) {
                  if (!line.startsWith("data: ")) continue;
                  const payload = line.slice(6).trim();
                  if (payload === "[DONE]") {
                    controller.close();
                    break;
                  }
                  try {
                    const json = JSON.parse(payload);
                    const parts: string[] = [];
                    collectTextFields(json, parts);
                    const chunk = parts.join("");
                    if (chunk) {
                      controller.enqueue({ data: JSON.stringify(chunk), id: Date.now(), event: "message" });
                    }
                  } catch (_) { /* ignore */ }
                }
              }
              controller.close();
            } catch (_) {
              controller.close();
            }
          },
        }).pipeThrough(new ServerSentEventStream()),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    } else {
      // Non-Stream: /generateContent + JSON zurück
      const url =
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiModel)}` +
        `:generateContent?key=${encodeURIComponent(geminiApiKey)}`;
      const body = { contents: geminiContents };
      if (systemInstruction) (body as any).systemInstruction = systemInstruction;
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json();
      return new Response(JSON.stringify(j), { status: r.status, headers: { "Content-Type": "application/json" } });
    }
  }

  // 7) LLM/VLM (kein PDF) → Upstream (typischerweise deine Middleware)
  let useApiUrl = llmApiUrl || Deno.env.get("LLM_URL") || API_URL;
  let useApiKey = llmApiKey || Deno.env.get("LLM_KEY") || API_KEY;
  let useApiModel = llmApiModel || Deno.env.get("LLM_MODEL") || API_MODEL;

  if (isImageInMessages) {
    useApiUrl = vlmApiUrl || Deno.env.get("VLM_URL") || API_IMAGE_URL;
    useApiKey = vlmApiKey || Deno.env.get("VLM_KEY") || API_IMAGE_KEY;
    const chosenVlmModel =
      (isCorrectionInLastMessage && vlmCorrectionModel)
        ? vlmCorrectionModel
        : vlmApiModel || Deno.env.get("VLM_MODEL") || API_IMAGE_MODEL;
    useApiModel = chosenVlmModel;
  }

  // Non-Stream explizit angefordert → JSON 1:1
  if (wantsStream === false) {
    const resp = await fetch(useApiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${useApiKey}` },
      body: JSON.stringify({ model: useApiModel, stream: false, messages }),
    });
    const txt = await resp.text(); // JSON oder Fehler durchreichen
    return new Response(txt, { status: resp.status, headers: { "Content-Type": resp.headers.get("content-type") ?? "application/json" } });
  }

  // Standard: Stream anfordern und 1:1 durchreichen – oder bei JSON auf Mini-SSE fallen
  return new Response(
    new ReadableStream({
      async start(controller) {
        try {
          const upstream = await fetch(useApiUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${useApiKey}` },
            body: JSON.stringify({ model: useApiModel, stream: true, messages }),
          });

          if (!upstream.ok) {
            controller.error(new Error(`Upstream error: ${upstream.status} ${upstream.statusText}`));
            controller.close();
            return;
          }

          const ctype = (upstream.headers.get("content-type") || "").toLowerCase();
          const isSSE = ctype.includes("text/event-stream");
          if (!upstream.body) {
            controller.close();
            return;
          }

          const decoder = new TextDecoder();

          if (isSSE) {
            // 1:1 SSE → UI-SSE mapping (delta.content → JSON-String)
            const reader = upstream.body.getReader();
            let buffer = "";
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split("\n");
              buffer = lines.pop() || "";
              for (const line of lines) {
                if (line === "data: [DONE]") {
                  controller.close();
                  continue;
                }
                if (!line.startsWith("data: ")) continue;
                const jsonStr = line.substring(6);
                try {
                  const data = JSON.parse(jsonStr);
                  const delta = data?.choices?.[0]?.delta;
                  if (delta?.content !== undefined && delta?.content !== null) {
                    if (delta.content === "<|im_end|>") controller.close();
                    else controller.enqueue({ data: JSON.stringify(delta.content), id: Date.now(), event: "message" });
                  }
                } catch (_) { /* ignore */ }
              }
            }
            controller.close();
          } else {
            // Kein SSE → JSON lesen, Text extrahieren → Mini-SSE an UI
            const raw = await upstream.text();
            let text = "";
            try { text = extractAssistantText(JSON.parse(raw)); } catch (_) { text = raw; }
            const stream = sseFromText(text);
            const reader = stream.getReader();
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              controller.enqueue(value);
            }
            controller.close();
          }
        } catch (_) {
          controller.close();
        }
      },
      cancel(err) { console.log("SSE canceled:", err); },
    }).pipeThrough(new ServerSentEventStream()),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}
// --- REPLACE THE WHOLE FUNCTION ENDING HERE ---

export const handler: Handlers = {
  async POST(req: Request) {
    const payload = await req.json();
    // wantsStream: true (default) – wenn payload.stream explizit false ist, geben wir JSON zurück
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
};
 