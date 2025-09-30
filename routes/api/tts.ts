import { Handlers } from "$fresh/server.ts";
import { Buffer } from "npm:buffer";

const TTS_KEY = Deno.env.get("TTS_KEY") || "";
const TTS_URL = Deno.env.get("TTS_URL") || "";
const TTS_MODEL = Deno.env.get("TTS_MODEL") || "";
const MIDDLEWARE_BASE_URL = Deno.env.get("MIDDLEWARE_URL") || "";

/* ===================== Universal-key suffix decoding =======================
   Backend encodes "<host>:<port>" as:
     token = "v1" + Base32( bytes(host:port) XOR 0x5A ), without '=' padding
   We decode it, then build "http://<host>:<port>" (IPv6 hosts get brackets).
============================================================================= */

/** RFC4648 Base32 decode (no padding required). Throws on bad chars. */
function base32DecodeNoPadding(s: string): Uint8Array {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = s.trim().toUpperCase().replace(/=+$/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    const idx = alphabet.indexOf(ch);
    if (idx === -1) throw new Error("Invalid Base32 character");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

/** Convert "host:port" → "http://host:port" with IPv6 bracket handling */
function hostPortToHttpBase(hostPort: string): string {
  // Split at last ":" to separate port; IPv6 contains multiple ":"s.
  const last = hostPort.lastIndexOf(":");
  let host = hostPort;
  let port = "";
  if (last !== -1) {
    host = hostPort.slice(0, last);
    port = hostPort.slice(last + 1);
  }
  const isIPv6 = host.includes(":");
  const bracketHost = isIPv6 ? `[${host}]` : host;
  const portPart = port ? `:${port}` : "";
  return `http://${bracketHost}${portPart}`;
}

/** Decode middleware base URL from the composite universal key (or return null). */
function decodeMiddlewareBaseFromUniversalKey(universalApiKey: string | undefined | null): string | null {
  const raw = (universalApiKey || "").trim();
  const hash = raw.indexOf("#");
  if (hash < 0) return null;
  const suffix = raw.slice(hash + 1);

  // Backward compatibility: accept raw http(s) suffixes if they ever existed.
  if (/^https?:\/\/.+/i.test(suffix)) {
    return suffix.replace(/\/+$/g, "");
  }

  // Expected scheme: 'v1' + Base32(no padding) of XOR'd bytes
  if (!suffix.startsWith("v1")) return null;
  try {
    const b32 = suffix.slice(2);
    const bytes = base32DecodeNoPadding(b32);
    // XOR with 0x5A to recover original "host:port" ascii
    for (let i = 0; i < bytes.length; i++) bytes[i] = bytes[i] ^ 0x5a;
    const hostPort = new TextDecoder().decode(bytes);
    if (!hostPort || hostPort.indexOf(":") === -1) return null;
    return hostPortToHttpBase(hostPort).replace(/\/+$/g, "");
  } catch {
    return null;
  }
}

/**
 * MARS6 helper
 */
async function callMARS6API(
  text: string,
  ttsUrl: string,
  ttsKey: string,
) {
  async function createTTSTask(
    url: string,
    key: string,
    voiceID: number = 20299,
    language: number = 1,
  ) {
    try {
      const response = await fetch(`${url}/tts`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": key,
        },
        body: JSON.stringify({
          text,
          voice_id: voiceID,
          language,
        }),
      });
      const responseJSON = await response.json();
      console.log(`Status code for creating TTS: ${response.status}`);
      if (response.ok) {
        return responseJSON.task_id as string;
      } else {
        console.error(
          `Failed to create TTS task for MARS6. Status code: ${response.status}: ${response.statusText}`,
        );
      }
    } catch (error) {
      console.error(`Error in createTTSTask: ${error}`);
    }
  }

  async function pollTTSTask(url: string, key: string, taskID: string): Promise<number> {
    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    try {
      const response = await fetch(`${url}/tts/${taskID}`, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": key,
        },
      });

      const responseJSON = await response.json();
      const status = responseJSON.status;
      console.log(`Polling: ${status}`);

      if (status === "SUCCESS") {
        return responseJSON.run_id as number;
      }
      await delay(1500);
      return pollTTSTask(url, key, taskID);
    } catch (error) {
      console.error("Error polling TTS task:", error);
      throw error;
    }
  }

  async function getTTSAudioResult(
    url: string,
    key: string,
    runID: number,
  ) {
    try {
      const response = await fetch(`${url}/tts-result/${runID}`, {
        method: "GET",
        headers: {
          "x-api-key": key,
        },
      });
      if (response.ok) {
        return await response.arrayBuffer();
      } else {
        console.error(
          `Failed to fetch TTS audio file from MARS6. Status code: ${response.status}: ${response.statusText}`,
        );
      }
    } catch (error) {
      console.error(`Error in fetching TTS audio file from MARS6: ${error}`);
    }
  }

  try {
    const taskID = await createTTSTask(ttsUrl, ttsKey);
    if (!taskID) throw new Error("No task_id from MARS6");
    const runID = await pollTTSTask(ttsUrl, ttsKey, taskID);
    return await getTTSAudioResult(ttsUrl, ttsKey, runID);
  } catch (error) {
    console.error(`Failed to call MARS6: ${error}`);
    throw error;
  }
}

/**
 * Text-to-Speech dispatcher
 * Returns binary audio as Buffer (we respond with audio/mpeg).
 */
async function textToSpeech(
  text: string,
  textPosition: string,
  ttsUrl: string,
  ttsKey: string,
  ttsModel: string,
): Promise<Buffer | null> {
  // clean markup
  const boldTextRegex = /\*\*(.*?)\*\*/g;
  text = String(text).replace(boldTextRegex, "$1");
  text = text.replace(/bud-e/gi, "buddy");

  console.log("textToSpeech", text);
  console.log("textPosition", textPosition);
  console.log("ttsUrl", ttsUrl || TTS_URL);
  console.log("ttsKey", ttsKey ? "[provided]" : "[env/default]");
  console.log("ttsModel", ttsModel || TTS_MODEL);

  const useThisTtsUrl = ttsUrl !== "" ? ttsUrl : TTS_URL;
  const useThisTtsKey = ttsKey !== "" ? ttsKey : TTS_KEY;
  const useThisTtsModel = ttsModel !== "" ? ttsModel : TTS_MODEL;

  try {
    // Fish Audio heuristic (32-hex ID → uses "reference_id" & returns MP3)
    if (useThisTtsModel && /^[a-fA-F0-9]{32}$/.test(useThisTtsModel)) {
      const startTime = Date.now();
      const response = await fetch(useThisTtsUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${useThisTtsKey}`,
        },
        body: JSON.stringify({
          text,
          normalize: true,
          format: "mp3",
          reference_id: useThisTtsModel,
          mp3_bitrate: 64,
          opus_bitrate: -1000,
          latency: "normal",
        }),
      });

      if (response.ok) {
        const audioData = await response.arrayBuffer();
        console.log(`Audio file received for ${textPosition}, Latency:`, Date.now() - startTime);
        return Buffer.from(audioData);
      } else {
        console.error(
          `Fish TTS failed. Status code: ${response.status}: ${response.statusText}`,
        );
        return null;
      }
    }

    // Provider switch (simple normalization)
    switch (useThisTtsModel) {
      case "MARS6": {
        const audioData = await callMARS6API(text, useThisTtsUrl, useThisTtsKey);
        if (audioData) return Buffer.from(audioData);
        console.error(`MARS6 synthesis failed.`);
        break;
      }

      case "aura-helios-en": {
        // Fallback: treat like OpenAI-compatible / simple JSON API returning binary audio
        const startTime = Date.now();
        const response = await fetch(useThisTtsUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${useThisTtsKey}`,
          },
          body: JSON.stringify({
            model: useThisTtsModel,
            input: text,
            // voice can be optional here depending on backend; add if required.
          }),
        });
        if (response.ok) {
          const audioData = await response.arrayBuffer();
          console.log(`Audio [aura-helios-en] received for ${textPosition}, Latency:`, Date.now() - startTime);
          return Buffer.from(audioData);
        } else {
          console.error(`aura-helios-en failed. Status code: ${response.status} ${response.statusText}`);
        }
        break;
      }

      default: {
        // Default: OpenAI-compatible audio/speech endpoint: returns binary audio (mp3)
        const startTime = Date.now();
        const response = await fetch(useThisTtsUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${useThisTtsKey}`,
          },
          body: JSON.stringify({
            model: useThisTtsModel,
            input: text,
            // If your middleware requires "voice" or "format", add here.
            // format: "mp3",
          }),
        });

        if (response.ok) {
          const audioData = await response.arrayBuffer();
          console.log(
            `Audio file received for ${textPosition}, Latency:`,
            Date.now() - startTime,
          );
          return Buffer.from(audioData);
        } else {
          console.error(
            `Failed to synthesize speech. Status code: ${response.status}: ${response.statusText}`,
          );
        }
      }
    }
  } catch (error) {
    console.error(`Error in textToSpeech: ${error}`);
  }
  return null;
}

export const handler: Handlers = {
  async POST(req) {
    const payload = await req.json();
    const { text, textPosition, ttsUrl, ttsKey, ttsModel, universalApiKey } = payload;

    // Final URL/Key (universal key overrides)
    let useThisTtsUrl: string = ttsUrl;
    let useThisTtsKey: string = ttsKey;

    if (universalApiKey) {
      const base =
        decodeMiddlewareBaseFromUniversalKey(universalApiKey) ||
        (MIDDLEWARE_BASE_URL || "").trim();

      if (!base) {
        return new Response("Middleware base unavailable", { status: 400 });
      }

      useThisTtsUrl = `${base.replace(/\/+$/,"")}/v1/audio/speech`;
      useThisTtsKey = universalApiKey;
    }

    if (!text) {
      return new Response("No text provided", { status: 400 });
    }

    const audioData = await textToSpeech(
      text,
      textPosition,
      useThisTtsUrl,
      useThisTtsKey,
      ttsModel,
    );

    if (audioData) {
      // Use audio/mpeg consistently (front-end reads header & sets Blob type accordingly)
      const response = new Response(audioData, {
        status: 200,
        headers: {
          "Content-Type": "audio/mpeg",
          "Cache-Control": "no-store",
        },
      });
      return response;
    } else {
      return new Response("Failed to synthesize speech", {
        status: 500,
      });
    }
  },
};
