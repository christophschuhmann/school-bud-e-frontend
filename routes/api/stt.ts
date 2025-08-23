import { Handlers } from "$fresh/server.ts";

const STT_KEY = Deno.env.get("STT_KEY") || "";
const STT_MODEL = Deno.env.get("STT_MODEL") || "";
const STT_URL = Deno.env.get("STT_URL") || "";
// PASTE THIS ENTIRE REVISED HANDLER IN: school-bud-e-frontend/routes/api/stt.ts

export const handler: Handlers = {
  async POST(req) {
    try {
      const formData = await req.formData();
      const audioFile = formData.get("audio") as File;
      
      // --- START OF NEW LOGIC ---
      const universalApiKey = formData.get("universalApiKey") as string;
      const MIDDLEWARE_BASE_URL = "http://65.109.157.234:8787";

      // Initialize variables with values from settings or environment variables
      let useThisSttUrl = formData.get("sttUrl") as string || STT_URL;
      let useThisSttKey = formData.get("sttKey") as string || STT_KEY;
      let useThisSttModel = formData.get("sttModel") as string || STT_MODEL;

      // If a universalApiKey is provided, it overrides the specific STT settings
      if (universalApiKey) {
        useThisSttUrl = `${MIDDLEWARE_BASE_URL}/v1/audio/transcriptions`;
        useThisSttKey = universalApiKey;
        // When using middleware, we can let the middleware decide the model,
        // but we still need to provide one. "whisper-1" is a safe default.
        if (!useThisSttModel) {
            useThisSttModel = "whisper-1";
        }
      }
      // --- END OF NEW LOGIC ---

      // This is for direct-to-Groq calls and remains compatible
      if (useThisSttKey.startsWith("gsk_")) {
        useThisSttUrl = useThisSttUrl == "" ? "https://api.groq.com/openai/v1/audio/transcriptions" : useThisSttUrl;
        useThisSttModel = useThisSttModel == "" ? "whisper-large-v3-turbo" : useThisSttModel;
      }

      if (!audioFile) {
        return new Response("No audio file uploaded", { status: 400 });
      }

      if (!useThisSttKey) {
        return new Response("Missing STT API key", { status: 400 });
      }

      const sttFormData = new FormData();
      sttFormData.append("file", audioFile);
      sttFormData.append("model", useThisSttModel);

      // Make the fetch request using the potentially overridden URL and key
      const response = await fetch(useThisSttUrl, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${useThisSttKey}`,
        },
        body: sttFormData,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        console.error("STT API Error:", errorBody);
        throw new Error(`STT API responded with status: ${response.status}`);
      }

      const transcription = await response.json();

      return new Response(transcription.text, {
        status: 200,
        headers: { "Content-Type": "application/text" },
      });
    } catch (error) {
      console.error("Error transcribing audio file:", error);
      return new Response("Internal Server Error", { status: 500 });
    }
  },
};
