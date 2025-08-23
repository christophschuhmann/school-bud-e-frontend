import { Handlers } from "$fresh/server.ts";
import { Buffer } from "npm:buffer";

const TTS_KEY = Deno.env.get("TTS_KEY") || "";
const TTS_URL = Deno.env.get("TTS_URL") || "";
const TTS_MODEL = Deno.env.get("TTS_MODEL") || "";

async function callMARS6API(
  text: string,
  ttsUrl: string,
  ttsKey: string,
) {
  async function createTTSTask(
    ttsUrl: string,
    ttsKey: string,
    voiceID: number = 20299,
    language: number = 1,
  ) {
    try {
      const response = await fetch(
        `${ttsUrl}/tts`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": ttsKey,
          },
          body: JSON.stringify({
            text: text,
            voice_id: voiceID,
            language: language,
          }),
        },
      );
      const responseJSON = await response.json();
      console.log(`Status code for creating TTS: ${response.status}`);
      if (response.ok) {
        return responseJSON.task_id;
      } else {
        console.error(
          `Failed to create TTS task for MARS6. Status code: ${response.status}: ${response.statusText}`,
        );
      }
    } catch (error) {
      console.error(`Error in createTTSTask: ${error}`);
    }
  }

  async function pollTTSTask(ttsUrl: string, ttsKey: string, taskID: string) {
    const delay = (ms: number) =>
      new Promise((resolve) => setTimeout(resolve, ms));
    try {
      const response = await fetch(`${ttsUrl}/tts/${taskID}`, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ttsKey,
        },
      });

      const responseJSON = await response.json();
      const status = responseJSON.status;
      console.log(`Polling: ${status}`);

      if (status === "SUCCESS") {
        return responseJSON.run_id;
      }
      await delay(1500); // Wait for 1.5 seconds before the next poll.
      return pollTTSTask(ttsUrl, ttsKey, taskID); // Recursive call for polling.
    } catch (error) {
      console.error("Error polling TTS task:", error);
      throw error;
    }
  }

  async function getTTSAudioResult(
    ttsUrl: string,
    ttsKey: string,
    runID: number,
  ) {
    try {
      const response = await fetch(
        `${ttsUrl}/tts-result/${runID}`,
        {
          method: "GET",
          headers: {
            "x-api-key": ttsKey,
          },
        },
      );
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
    const taskID: string = await createTTSTask(
      ttsUrl,
      ttsKey,
    );
    const runID = await pollTTSTask(ttsUrl, ttsKey, taskID);
    return await getTTSAudioResult(ttsUrl, ttsKey, runID);
  } catch (error) {
    console.error(`Failed to call MARS6: ${error}`);
    throw error;
  }
}

// REPLACE YOUR EXISTING textToSpeech FUNCTION WITH THIS ENTIRE BLOCK

async function textToSpeech(
  text: string,
  textPosition: string,
  ttsUrl: string,
  ttsKey: string,
  ttsModel: string,
): Promise<Buffer | null> {
  const boldTextRegex = /\*\*(.*?)\*\*/g;
  text = String(text).replace(boldTextRegex, "$1");

  const buddyRegex = /bud-e/gi;
  text = text.replace(buddyRegex, "buddy");

  console.log("textToSpeech", text);
  console.log("textPosition", textPosition);
  console.log("ttsUrl", ttsUrl);
  console.log("ttsKey", ttsKey);
  console.log("ttsModel", ttsModel);

  const useThisTttsUrl = ttsUrl != "" ? ttsUrl : TTS_URL;
  const useThisTtsKey = ttsKey != "" ? ttsKey : TTS_KEY;
  const useThisTtsModel = ttsModel != "" ? ttsModel : TTS_MODEL;

  try {
    // --- START OF REVISED LOGIC ---

    // Fish Audio models are 32-character hexadecimal IDs. We can detect them by their length.
    if (useThisTtsModel && useThisTtsModel.length === 32) {
        const startTime = Date.now();
        const response = await fetch(useThisTttsUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${useThisTtsKey}`,
          },
          // This is the specific payload format that Fish Audio expects.
          body: JSON.stringify({
            text: text,
            normalize: true,
            format: "mp3",
            reference_id: useThisTtsModel, // Fish uses reference_id for the model
            mp3_bitrate: 64,
            opus_bitrate: -1000,
            latency: "normal",
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
          return null; // Explicitly return null on failure
        }
    }

    // This logic handles other providers like Deepgram, which have specific model names.
    switch (useThisTtsModel) {
      case "MARS6": {
        // ... (This block is unchanged)
        const audioData = await callMARS6API(text, ttsUrl, ttsKey);
        if (audioData) { return Buffer.from(audioData); }
        else { console.error(`Failed to synthesize speech.`); break; }
      }
      case "aura-helios-en": {
        // ... (This block is unchanged)
        const startTime = Date.now();
        const response = await fetch(useThisTttsUrl, { /* ... */ });
        if (response.ok) { return Buffer.from(await response.arrayBuffer()); }
        else { console.error(`...`); }
        break;
      }
      // This default case now correctly handles your middleware and any other
      // standard OpenAI-compatible TTS provider.
      default: {
        const startTime = Date.now();
        const response = await fetch(useThisTttsUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${useThisTtsKey}`,
          },
          body: JSON.stringify({
            model: useThisTtsModel,
            input: text,
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
    // --- END OF REVISED LOGIC ---

  } catch (error) {
    console.error(`Error in textToSpeech: ${error}`);
  }
  return null;
}

export const handler: Handlers = {
  async POST(req) {
    // --- Start of new logic ---
    const payload = await req.json();
    const { text, textPosition, ttsUrl, ttsKey, ttsModel, universalApiKey } = payload;

    const MIDDLEWARE_BASE_URL = "http://65.109.157.234:8787";

    // These variables will hold the final values to be used.
    let useThisTtsUrl = ttsUrl;
    let useThisTtsKey = ttsKey;

    // If a universalApiKey is provided, it overrides the specific TTS settings.
    if (universalApiKey) {
        useThisTtsUrl = `${MIDDLEWARE_BASE_URL}/v1/audio/speech`;
        useThisTtsKey = universalApiKey;
    }
    // --- End of new logic ---

    if (!text) {
      return new Response("No text provided", { status: 400 });
    }

    // The textToSpeech function now receives the potentially overridden URL and key.
    const audioData = await textToSpeech(
      text,
      textPosition,
      useThisTtsUrl,
      useThisTtsKey,
      ttsModel,
    );

    if (audioData) {
      const response = new Response(audioData, {
        status: 200,
        headers: {
          "Content-Type": "audio/mp3",
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