import { Handlers } from "$fresh/server.ts";
import { ServerSentEventStream } from "https://deno.land/std@0.210.0/http/server_sent_event_stream.ts";

import { chatContent } from "../../internalization/content.ts";

// const API_URL = Deno.env.get("API_URL_TOGETHER") || "";
// const API_KEY = Deno.env.get("API_KEY_TOGETHER") || "";
// const API_MODEL = "MISTRALAI/MIXTRAL-8X22B-INSTRUCT-V0.1";

const API_URL = Deno.env.get("LLM_URL") || "";
const API_KEY = Deno.env.get("LLM_KEY") || "";
const API_MODEL = Deno.env.get("LLM_MODEL") || "";
const API_IMAGE_URL = Deno.env.get("VLM_URL") || "";
const API_IMAGE_KEY = Deno.env.get("VLM_KEY") || "";
const API_IMAGE_MODEL = Deno.env.get("VLM_MODEL") || "";
const API_IMAGE_CORRECTION_MODEL = Deno.env.get("VLM_CORRECTION_MODEL") || "";

// const CURRENT_DATETIME = new Date().toISOString();
// console.log(CURRENT_DATETIME, API_MODEL);

interface Message {
  role: string;
  content: string;
}

// --- REPLACE THE WHOLE FUNCTION STARTING HERE ---
async function getModelResponseStream(
  // deno-lint-ignore no-explicit-any
  messages: any[],
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
) {
  // 1) Same universal key gate as before
  if (universalApiKey != "" && !universalApiKey.startsWith("sbe-")) {
    return new Response(
      "Invalid Universal API Key. It needs to start with '**sbe-**'.",
      { status: 400 },
    );
  }

  // 2) Trim trailing assistant messages (unchanged behavior)
  let isLastMessageAssistant = messages[messages.length - 1]?.role === "assistant";
  while (isLastMessageAssistant) {
    messages.pop();
    isLastMessageAssistant = messages[messages.length - 1]?.role === "assistant";
  }

  // 3) Correction mode flag (re-uses your helper)
  const isCorrectionInLastMessage = hasKorrekturHashtag(messages);

  // 4) System prompt selection (unchanged)
  let useThisSystemPrompt = isCorrectionInLastMessage
    ? chatContent[lang].correctionSystemPrompt
    : chatContent[lang].systemPrompt;
  if (systemPrompt != "") useThisSystemPrompt = systemPrompt;

  // Keep your current pattern: push a system message in front
  messages.unshift({
    role: "system",
    content: useThisSystemPrompt,
  });

  // 5) Detect images (unchanged) and PDFs (NEW)
  const isImageInMessages = messages.some((m) =>
    Array.isArray(m.content) && m.content.some((p: any) => p.type === "image_url")
  );

  const isPdfInMessages = messages.some((m) =>
    Array.isArray(m.content) && m.content.some((p: any) => p.type === "pdf")
  );

  // 6) If PDF present, call Gemini native streaming API with inlineData
  if (isPdfInMessages) {
    // Prefer configured VLM key/model from settings/env (like your image path)
    const geminiApiKey =
      vlmApiKey || Deno.env.get("VLM_KEY") || "";
    const geminiModel =
      vlmApiModel || Deno.env.get("VLM_MODEL") || "gemini-2.5-pro";

    if (!geminiApiKey) {
      return new Response(
        "Missing VLM API key for PDF processing (expected Google AI Studio key).",
        { status: 400 },
      );
    }

    // Build Gemini "contents" from your existing messages
    // - Convert your 'system' message into system_instruction
    // - Map user/assistant text to parts[]
    // - For PDFs: use inlineData { mimeType, data } (already base64 in your UI)
    const systemMessage = messages.find((m) => m.role === "system");
    const systemInstruction = systemMessage?.content
      ? {
          role: "system",
          parts: [{ text: typeof systemMessage.content === "string"
            ? systemMessage.content
            : Array.isArray(systemMessage.content)
              ? (systemMessage.content.find((c: any) => c.type === "text")?.text || "")
              : "" }],
        }
      : undefined;

    // Map remaining messages into Gemini contents
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
              // Your PdfUploadButton already supplies base64 `data` + `mime_type`
              parts.push({
                inlineData: {
                  mimeType: c.mime_type || "application/pdf",
                  data: c.data, // base64 only
                },
              });
            } else if (c.type === "image_url" && c.image_url?.url?.startsWith("data:")) {
              // If images are uploaded alongside a PDF, include them as inlineData too
              const dataUrl = c.image_url.url;
              const commaIdx = dataUrl.indexOf(",");
              const header = dataUrl.substring(5, commaIdx); // e.g. image/png;base64
              const base64 = dataUrl.substring(commaIdx + 1);
              const mimeType = header.split(";")[0];       // e.g. image/png
              parts.push({
                inlineData: {
                  mimeType,
                  data: base64,
                },
              });
            }
          }
        }

        return { role: m.role === "assistant" ? "model" : "user", parts };
      });

    // Gemini streaming endpoint (SSE)
    const geminiUrl =
      `https://generativelanguage.googleapis.com/v1beta/models/` +
      `${encodeURIComponent(geminiModel)}:streamGenerateContent` +
      `?alt=sse&key=${encodeURIComponent(geminiApiKey)}`;

    // Build request body similar to the example you supplied
    const geminiBody: any = {
      contents: geminiContents,
      generationConfig: {
        // Keep defaults; expose "thinking" like your example if desired
        thinkingConfig: { thinkingBudget: -1 },
      },
      tools: [{ googleSearch: {} }],
    };
    if (systemInstruction) {
      // The API accepts system instruction; camelCase is fine here
      geminiBody.systemInstruction = systemInstruction;
    }

    // Helper to extract incremental text from Gemini SSE JSON events
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

    // Return a streamed response to the browser in your existing format
    return new Response(
      new ReadableStream({
        async start(controller) {
          try {
            const resp = await fetch(geminiUrl, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
              },
              body: JSON.stringify(geminiBody),
            });

            if (!resp.ok || !resp.body) {
              controller.error(
                new Error(`Gemini API error: ${resp.status} ${resp.statusText}`),
              );
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
                // SSE format: "data: {json}" or "data: [DONE]"
                if (line.startsWith("data: ")) {
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
                      controller.enqueue({
                        data: JSON.stringify(chunk), // your UI expects a JSON-encoded string
                        id: Date.now(),
                        event: "message",
                      });
                    }
                  } catch (_e) {
                    // ignore keep-alive / non-JSON data lines
                  }
                }
              }
            }

            controller.close();
          } catch (_error) {
            controller.close();
          }
        },
      }).pipeThrough(new ServerSentEventStream()),
      { headers: { "Content-Type": "text/event-stream" } },
    );
  }

  // 7) No-PDF path: preserve your existing LLM/VLM behavior (images & plain text)
  //     - Choose endpoint/key/model from settings/env, just like before
  let useThisApiUrl = llmApiUrl || Deno.env.get("LLM_URL") || API_URL;
  let useThisApiKey = llmApiKey || Deno.env.get("LLM_KEY") || API_KEY;
  let useThisApiModel = llmApiModel || Deno.env.get("LLM_MODEL") || API_MODEL;

  if (isImageInMessages) {
    useThisApiUrl = vlmApiUrl || Deno.env.get("VLM_URL") || API_IMAGE_URL;
    useThisApiKey = vlmApiKey || Deno.env.get("VLM_KEY") || API_IMAGE_KEY;

    // pick correction model if requested and configured
    const chosenVlmModel = (isCorrectionInLastMessage && vlmCorrectionModel)
      ? vlmCorrectionModel
      : vlmApiModel || Deno.env.get("VLM_MODEL") || API_IMAGE_MODEL;

    useThisApiModel = chosenVlmModel;
  }

  // 8) Forward to your OpenAI-compatible streaming as before
  return new Response(
    new ReadableStream({
      async start(controller) {
        try {
          const response = await fetch(useThisApiUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${useThisApiKey}`,
            },
            body: JSON.stringify({
              model: useThisApiModel,
              stream: true,
              messages: messages,
            }),
          });

          if (!response.ok || !response.body) {
            controller.error(new Error(`Upstream error: ${response.status} ${response.statusText}`));
            controller.close();
            return;
          }

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            buffer += chunk;

            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            lines.forEach((line: string) => {
              if (line.startsWith("data: ") && line !== "data: [DONE]") {
                const jsonStr = line.substring(6);
                try {
                  const data = JSON.parse(jsonStr);
                  if (
                    data.choices?.[0]?.delta?.content !== undefined &&
                    data.choices?.[0]?.delta?.content !== null
                  ) {
                    if (data.choices[0].delta.content === "<|im_end|>") {
                      controller.close();
                    } else {
                      controller.enqueue({
                        data: JSON.stringify(data.choices[0].delta.content),
                        id: Date.now(),
                        event: "message",
                      });
                    }
                  }
                } catch (_e) {
                  controller.close();
                }
              } else if (line === "data: [DONE]") {
                controller.close();
              }
            });
          }
        } catch (_error) {
          controller.close();
        }
      },
      cancel(err) {
        console.log("SSE canceled:", err);
      },
    }).pipeThrough(new ServerSentEventStream()),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}
// --- REPLACE THE WHOLE FUNCTION ENDING HERE ---

// deno-lint-ignore no-explicit-any
function hasKorrekturHashtag(messages: any[]): boolean {
  if (!messages || messages.length === 0) return false;
  
  const lastMessage = messages[messages.length - 1];
  if (!lastMessage || !lastMessage.content) return false;

  let content = '';
  
  // Handle different content formats
  if (typeof lastMessage.content === 'string') {
    content = lastMessage.content;
  } else if (Array.isArray(lastMessage.content)) {
    // Handle array of content objects
    const textContent = lastMessage.content.find(
      // deno-lint-ignore no-explicit-any
      (item: any) => item.type === 'text'
    );
    content = textContent?.text || '';
  }

  return content.toLowerCase().includes('#korrektur') || 
         content.toLowerCase().includes('#correction');
}

export const handler: Handlers = {
  async POST(req: Request) {
    const payload = await req.json();

    // console.log(payload.lang);

    // payload.messages.unshift({
    //   role: "system",
    //   content:
    //     "You are an intelligent and empathetic learning assistant. Always respond empathetically, friendly, curiously and appropriately to the school context. Respond briefly and to the point. Your name is BUD-E and you would be created by LAION. LAION is a non-profit organization for the democratization of open source AI. Try to keep the conversation friendly, educational and entertaining and to keep it running while taking into account previously said information. Respond briefly, concisely and to the point.",
    // });

    // console.log("Model used: ", API_MODEL);
    // console.log("payload messages", payload.messages);
    return getModelResponseStream(payload.messages, payload.lang, payload.universalApiKey, payload.llmApiUrl, payload.llmApiKey, payload.llmApiModel, payload.systemPrompt, payload.vlmApiUrl, payload.vlmApiKey, payload.vlmApiModel, payload.vlmCorrectionModel);
  },
};
