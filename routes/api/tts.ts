import { Handlers } from "$fresh/server.ts";
import { Buffer } from "npm:buffer";

const TTS_KEY = Deno.env.get("TTS_KEY") || "";
const TTS_URL = Deno.env.get("TTS_URL") || "";
const TTS_MODEL = Deno.env.get("TTS_MODEL") || "";

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

    const MIDDLEWARE_BASE_URL = "http://65.109.157.234:8787";

    // Final URL/Key (universal key overrides)
    let useThisTtsUrl = ttsUrl;
    let useThisTtsKey = ttsKey;

    if (universalApiKey) {
      useThisTtsUrl = `${MIDDLEWARE_BASE_URL}/v1/audio/speech`;
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
