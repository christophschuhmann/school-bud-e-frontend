// ###############
// ### IMPORTS ###
// ###############

// The ChatIsland component is responsible for managing the chat messages and audio playback.
import ChatTemplate from "../components/ChatTemplate.tsx";

// Buttons separated from ChatTemplate to avoid circular dependencies
import { ChatSubmitButton } from "../components/ChatSubmitButton.tsx";
import ImageUploadButton from "../components/ImageUploadButton.tsx";
import VoiceRecordButton from "../components/VoiceRecordButton.tsx";
import { PdfUploadButton, PdfFile } from "../components/PdfUploadButton.tsx";

// Necessary for streaming service
import {
  EventSourceMessage,
  fetchEventSource,
} from "https://esm.sh/@microsoft/fetch-event-source@2.0.1";
import { useEffect, useRef, useState } from "preact/hooks";

// Internalization
import { chatIslandContent } from "../internalization/content.ts";

// // Import necessary types from Preact
// import { JSX } from 'preact';
import Settings from "../components/Settings.tsx";

// ###############
// ## / IMPORTS ##
// ###############

class RetriableError extends Error {}
class FatalError extends Error {}

interface Message {
  role: string;
  // deno-lint-ignore no-explicit-any
  content: string | any[];
}

// Define the AudioItem interface if not already defined
interface AudioItem {
  audio: HTMLAudioElement & { __text?: string }; // store text for regeneration checks
  played: boolean;
}

// Define the AudioFileDict type if not already defined
type AudioFileDict = Record<number, Record<number, AudioItem>>;

export default function ChatIsland({ lang }: { lang: string }) {
  // Necessary to load the chat messages from localStorage only once
  const [firstLoad, setFirstLoad] = useState(true);

  // Multiple chats can be stored in localStorage, each chat is identified by a unique suffix
  const [query, setQuery] = useState("");
  const [currentChatSuffix, setCurrentChatSuffix] = useState("0");
  const [localStorageKeys, setLocalStorageKeys] = useState([] as string[]);

  // dictionary containg audio files for each groupIndex for the current chat
  const [audioFileDict, setAudioFileDict] = useState<AudioFileDict>({});

  // used for STT in VoiceRecordButton
  const [resetTranscript, setResetTranscript] = useState(0);

  // General settings
  const [readAlways, setReadAlways] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [images, setImages] = useState([] as Image[]);
  const [pdfs, setPdfs] = useState([] as PdfFile[]);

  const [isStreamComplete, setIsStreamComplete] = useState(true);
  const [stopList, setStopList] = useState([] as number[]);
  const [currentEditIndex, setCurrentEditIndex] = useState(
    -1 as number | undefined,
  );

  const [messages, setMessages] = useState([
    {
      role: "assistant",
      content: [chatIslandContent[lang]["welcomeMessage"]],
    },
  ] as Message[]);

  const [showSettings, setShowSettings] = useState(false);

  // Abort controller for streaming cancel
  const abortRef = useRef<AbortController | null>(null);

  const [settings, setSettings] = useState({
    universalApiKey: localStorage.getItem("bud-e-universal-api-key") || "",
    apiUrl: localStorage.getItem("bud-e-api-url") || "",
    apiKey: localStorage.getItem("bud-e-api-key") || "",
    apiModel: localStorage.getItem("bud-e-model") || "",
    ttsUrl: localStorage.getItem("bud-e-tts-url") || "",
    ttsKey: localStorage.getItem("bud-e-tts-key") || "",
    ttsModel: localStorage.getItem("bud-e-tts-model") || "tts-1",
    sttUrl: localStorage.getItem("bud-e-stt-url") || "",
    sttKey: localStorage.getItem("bud-e-stt-key") || "",
    sttModel: localStorage.getItem("bud-e-stt-model") || "",
    systemPrompt: localStorage.getItem("bud-e-system-prompt") || "",
    vlmUrl: localStorage.getItem("bud-e-vlm-url") || "",
    vlmKey: localStorage.getItem("bud-e-vlm-key") || "",
    vlmModel: localStorage.getItem("bud-e-vlm-model") || "",
    vlmCorrectionModel: localStorage.getItem("bud-e-vlm-correction-model") ||
      "",
  });

  // NEW: pending manual speak groups (autostart when first chunk arrives)
  const [pendingManualSpeak, setPendingManualSpeak] = useState<Set<number>>(new Set());

  // ---------- Persistence helper (immediate & safe) ----------
  const safePersist = (msgs: Message[], suffix: string) => {
    try {
      localStorage.setItem("bude-chat-" + suffix, JSON.stringify(msgs));
      const key = "bude-chat-" + suffix;
      if (!localStorageKeys.includes(key)) {
        setLocalStorageKeys((prev) => [...new Set([...prev, key])]);
      }
    } catch (e: any) {
      if (e?.name === "QuotaExceededError") {
        console.warn("localStorage quota exceeded while saving chat.");
      } else {
        console.warn("Failed to persist messages:", e);
      }
    }
  };
  // -----------------------------------------------------------

  // Fixed-height composer helpers
  const resetComposerHeight = () => {
    const textarea = document.querySelector<HTMLTextAreaElement>("textarea");
    if (textarea) {
      textarea.style.height = ""; // ensure default height from CSS applies
      textarea.scrollTop = 0;
    }
  };
  const handleComposerChange = (val: string) => setQuery(val);

  // Add useEffect for loading settings
  useEffect(() => {
    const savedSettings = {
      universalApiKey: localStorage.getItem("bud-e-universal-api-key") || "",
      apiUrl: localStorage.getItem("bud-e-api-url") || "",
      apiKey: localStorage.getItem("bud-e-api-key") || "",
      apiModel: localStorage.getItem("bud-e-model") || "",
      ttsUrl: localStorage.getItem("bud-e-tts-url") || "",
      ttsKey: localStorage.getItem("bud-e-tts-key") || "",
      ttsModel: localStorage.getItem("bud-e-tts-model") || "",
      sttUrl: localStorage.getItem("bud-e-stt-url") || "",
      sttKey: localStorage.getItem("bud-e-stt-key") || "",
      sttModel: localStorage.getItem("bud-e-stt-model") || "",
      systemPrompt: localStorage.getItem("bud-e-system-prompt") || "",
      vlmUrl: localStorage.getItem("bud-e-vlm-url") || "",
      vlmKey: localStorage.getItem("bud-e-vlm-key") || "",
      vlmModel: localStorage.getItem("bud-e-vlm-model") || "",
      vlmCorrectionModel: localStorage.getItem("bud-e-vlm-correction-model") ||
        "",
    };
    setSettings(savedSettings);
  }, []);

  const handleSaveSettings = (newSettings: typeof settings) => {
    setSettings(newSettings);
    localStorage.setItem(
      "bud-e-universal-api-key",
      newSettings.universalApiKey,
    );
    localStorage.setItem("bud-e-api-url", newSettings.apiUrl);
    localStorage.setItem("bud-e-api-key", newSettings.apiKey);
    localStorage.setItem("bud-e-model", newSettings.apiModel);
    localStorage.setItem("bud-e-tts-url", newSettings.ttsUrl);
    localStorage.setItem("bud-e-tts-key", newSettings.ttsKey);
    localStorage.setItem("bud-e-tts-model", newSettings.ttsModel);
    localStorage.setItem("bud-e-stt-url", newSettings.sttUrl);
    localStorage.setItem("bud-e-stt-key", newSettings.sttKey);
    localStorage.setItem("bud-e-stt-model", newSettings.sttModel);
    localStorage.setItem("bud-e-system-prompt", newSettings.systemPrompt);
    localStorage.setItem("bud-e-vlm-url", newSettings.vlmUrl);
    localStorage.setItem("bud-e-vlm-key", newSettings.vlmKey);
    localStorage.setItem("bud-e-vlm-model", newSettings.vlmModel);
    localStorage.setItem(
      "bud-e-vlm-correction-model",
      newSettings.vlmCorrectionModel,
    );
    setShowSettings(false);
  };

  // #################
  // ### useEffect ###
  // #################
  // 1. useEffect []: Load chat messages from localStorage on first load
  // 2. useEffect [isStreamComplete]: Save chat messages to localStorage when the stream is complete
  // 3. useEffect [messages]: Automatic scrolling to last message on incoming messages
  // 4. useEffect [currentChatSuffix]: Load messages from localStorage when the chat suffix changes
  // 5. useEffect [audioFileDict, readAlways, stopList]: Play incoming audio files when readAlways is true
  // 6. useEffect [messages, currentChatSuffix]: last-ditch flush on unload/hidden

  // 1. useEffect
  useEffect(() => {
    let lsKeys: string[] = Object.keys(localStorage).filter((key) =>
      key.startsWith("bude-chat-")
    );
    lsKeys = lsKeys.length > 0 ? lsKeys : ["bude-chat-0"];
    // numeric sort
    lsKeys.sort((a, b) => Number(a.slice(10)) - Number(b.slice(10)));
    const currSuffix = lsKeys.length > 0
      ? String(lsKeys[0].slice(10))
      : "0";
    let lsMsgs = JSON.parse(
      String(localStorage.getItem("bude-chat-" + currSuffix)),
    );
    lsMsgs = lsMsgs || [
      {
        role: "assistant",
        content: [chatIslandContent[lang]["welcomeMessage"]],
      },
    ];
    setLocalStorageKeys(lsKeys);
    setMessages(lsMsgs);
    setCurrentChatSuffix(currSuffix);
  }, []);

  // 2. useEffect [isStreamComplete]
  useEffect(() => {
    if (isStreamComplete) {
      if ("content" in messages[messages.length - 1]) {
        let lastMessageFromBuddy: string;
        const lastMessageContent = messages[messages.length - 1]["content"];

        if (typeof lastMessageContent === "string") {
          lastMessageFromBuddy = lastMessageContent;
        } else {
          lastMessageFromBuddy = (lastMessageContent as string[]).join("");
        }

        if (lastMessageFromBuddy !== "" && messages.length > 1) {
          messages[messages.length - 1]["content"] = lastMessageFromBuddy;

          safePersist(messages, currentChatSuffix);

          if (!localStorageKeys.includes("bude-chat-" + currentChatSuffix)) {
            setLocalStorageKeys([
              ...localStorageKeys,
              "bude-chat-" + currentChatSuffix,
            ]);
          }
        }
        if (lastMessageFromBuddy !== "") {
          const groupIndex = messages.length - 1;
          if (groupIndex === 0) {
            getTTS(lastMessageFromBuddy, groupIndex, "stream");
          }
        }
      }
    }
  }, [isStreamComplete]);

  // 3. useEffect [messages]
  useEffect(() => {
    if (autoScroll) {
      // Find the scrollable chat container element we created earlier
      const chatContainer = document.querySelector(".chat-history");
      if (chatContainer) {
        // Scroll the container smoothly to the bottom to show the newest message
        (chatContainer as HTMLElement).scrollTo({
          top: (chatContainer as HTMLElement).scrollHeight,
          behavior: "smooth",
        });
      }
    }

    if (!firstLoad) {
      safePersist(messages, currentChatSuffix);
      setLocalStorageKeys(
        Object.keys(localStorage).filter((key) => key.startsWith("bude-chat-")),
      );
    }

    if (firstLoad) {
      setFirstLoad(false);
    }
  }, [messages, autoScroll]);

  // 4. useEffect [currentChatSuffix]
  useEffect(() => {
    // load messages from localStorage if they exist, else start with the default introductory message
    const lsMsgs = JSON.parse(
      String(localStorage.getItem("bude-chat-" + currentChatSuffix)),
    ) || [
      {
        role: "assistant",
        content: [chatIslandContent[lang]["welcomeMessage"]],
      },
    ];
    if (lsMsgs.length === 1) {
      if (
        lsMsgs[0].content[0] !== chatIslandContent[lang]["welcomeMessage"]
      ) {
        lsMsgs[0].content[0] = chatIslandContent[lang]["welcomeMessage"];
      }
    }
    setMessages(lsMsgs);
    stopAndResetAudio();
    setStopList([]);
    resetComposerHeight();
  }, [currentChatSuffix]);

  // 5. useEffect [audioFileDict, readAlways, stopList]
  useEffect(() => {
    if (!readAlways) return;

    Object.entries(audioFileDict).forEach(([groupIndex, groupAudios]) => {
      const nextUnplayedIndex = findNextUnplayedAudio(groupAudios);

      if (nextUnplayedIndex === null) return;

      const isLatestGroup =
        Math.max(...Object.keys(audioFileDict).map(Number)) <=
        Number(groupIndex);

      if (
        isLatestGroup &&
        canPlayAudio(
          Number(groupIndex),
          nextUnplayedIndex,
          groupAudios,
          stopList,
        )
      ) {
        playAudio(
          groupAudios[nextUnplayedIndex].audio,
          Number(groupIndex),
          nextUnplayedIndex,
          audioFileDict,
          setAudioFileDict,
        );
      }

      if (stopList.includes(Number(groupIndex))) {
        (Object.values(groupAudios) as AudioItem[]).forEach((item) => {
          if (!(item as AudioItem).audio.paused) {
            (item as AudioItem).audio.pause();
            (item as AudioItem).audio.currentTime = 0;
          }
        });
      }
    });
  }, [audioFileDict, readAlways, stopList]);

  // 6) Flush latest messages just before unload / when tab becomes hidden
  useEffect(() => {
    const flush = () => safePersist(messages, currentChatSuffix);
    const vis = () => {
      if (document.visibilityState === "hidden") flush();
    };

    window.addEventListener("beforeunload", flush);
    document.addEventListener("visibilitychange", vis);

    return () => {
      window.removeEventListener("beforeunload", flush);
      document.removeEventListener("visibilitychange", vis);
    };
  }, [messages, currentChatSuffix]);

  // Helper functions for audio playback
  const findNextUnplayedAudio = (
    groupAudios: Record<number, AudioItem>,
  ): number | null => {
    const [nextUnplayed] = Object.entries(groupAudios)
      .sort(([a], [b]) => Number(a) - Number(b))
      .find(([_, item]) => !item.played) || [];
    return nextUnplayed ? Number(nextUnplayed) : null;
  };

  const canPlayAudio = (
    groupIndex: number,
    audioIndex: number,
    groupAudios: Record<number, AudioItem>,
    stopList_: number[],
  ): boolean => {
    if (stopList_.includes(Number(groupIndex))) return false;

    const previousAudio = groupAudios[audioIndex - 1];
    return audioIndex === 0 ||
      (previousAudio?.played && previousAudio?.audio.paused);
  };

  const playAudio = (
    audio: HTMLAudioElement,
    groupIndex: number,
    audioIndex: number,
    audioFileDict_: AudioFileDict,
    setAudioFileDict_: (dict: AudioFileDict) => void,
  ) => {
    audio.play();
    audioFileDict_[groupIndex][audioIndex].played = true;

    // Add onended handler to update state when audio finishes
    audio.onended = () => {
      audioFileDict_[groupIndex][audioIndex].played = true;
      setAudioFileDict_({ ...audioFileDict_ }); // Force state update
    };

    // Force immediate state update when starting playback
    setAudioFileDict_({ ...audioFileDict_ });
  };

  // ---------- Smart Chunking (unchanged core) ----------
  const countWords = (s: string) => (s.trim().match(/[^\s]+/g) ?? []).length;

  // "." is only valid as sentence end if left token isn't a number or single-letter enum
  const isValidDot = (text: string, dotIdx: number) => {
    const left = text.slice(0, dotIdx).trimEnd();
    const m = left.match(/([\p{L}\p{N}]+)\s*$/u);
    if (!m) return false;
    const token = m[1];
    if (/^[A-Za-zÄÖÜäöüß]$/.test(token)) return false;     // A. / B.
    if (/^\d+([.)])?$/.test(token)) return false;          // 1. / 2)
    return /[\p{L}]{2,}/u.test(token);                     // needs ≥2 letters somewhere
  };

  const findChunkEnd = (text: string, start: number, minWords: number) => {
    const tail = text.slice(start);
    if (countWords(tail) <= minWords) return text.length;

    let i = start;
    while (i < text.length) {
      const ch = text[i];
      // only consider boundaries after minWords in the current slice
      const wordsSoFar = countWords(text.slice(start, i + 1));
      if (wordsSoFar >= minWords) {
        if (i + 2 < text.length && text.slice(i, i + 3) === "...") return i + 3;
        if (/[!?]/.test(ch)) return i + 1;
        if (ch === "." && isValidDot(text, i)) return i + 1;
      }
      i++;
    }

    // fallback: first whitespace after minWords
    i = start;
    while (i < text.length && countWords(text.slice(start, i)) < minWords) i++;
    while (i < text.length && !/\s/.test(text[i])) i++;
    return Math.min(text.length, Math.max(i, start + 1));
  };

  const splitIntoSmartChunks = (text: string) => {
    const t = text.trim();
    if (!t) return [] as string[];

    const end1 = findChunkEnd(t, 0, 10);
    const end2 = findChunkEnd(t, end1, 20);
    const end3 = findChunkEnd(t, end2, 40);

    const seg1 = t.slice(0, end1).trim();
    const seg2 = t.slice(end1, end2).trim();
    const seg3 = t.slice(end2, end3).trim();
    const seg4 = t.slice(end3).trim();

    const parts: string[] = [];
    if (seg1) parts.push(seg1);
    if (seg2) parts.push(seg2);
    if (seg3) parts.push(seg3);
    if (seg4) parts.push(seg4);
    return parts;
  };

  // ordered playback starter (used when first manual chunk arrives)
  const startOrderedPlaybackForGroup = (groupIndex: number) => {
    // Pause all other groups and mark them as stopped to avoid overlaps
    const newStopList = stopList.slice();
    Object.entries(audioFileDict).forEach(([gStr, group]) => {
      const gi = Number(gStr);
      if (gi !== groupIndex) {
        Object.values(group).forEach((item) => {
          if (!item.audio.paused) {
            item.audio.pause();
            item.audio.currentTime = 0;
          }
        });
        if (!newStopList.includes(gi)) newStopList.push(gi);
      }
    });
    setStopList(newStopList);

    // Play first and attach chaining
    const first = audioFileDict[groupIndex]?.[0]?.audio;
    if (!first) return;

    const chain = (idx: number) => {
      const curr = audioFileDict[groupIndex]?.[idx]?.audio;
      if (!curr) return;
      curr.onended = () => {
        const nextIdx = idx + 1;
        const next = audioFileDict[groupIndex]?.[nextIdx]?.audio;
        if (next) next.play();
        setAudioFileDict({ ...audioFileDict });
      };
    };

    Object.keys(audioFileDict[groupIndex] || {}).map(Number).sort((a,b)=>a-b).forEach(chain);

    first.play();
    setAudioFileDict({ ...audioFileDict });
  };

  // connect manual chunks to their neighbors as they arrive (so late arrivals still chain)
  const wireNeighborChaining = (groupIndex: number, idx: number) => {
    const prev = audioFileDict[groupIndex]?.[idx - 1]?.audio;
    if (prev) {
      prev.onended = () => {
        const next = audioFileDict[groupIndex]?.[idx]?.audio;
        if (next) next.play();
        setAudioFileDict({ ...audioFileDict });
      };
      // if previous already ended → start now
      const prevItem = audioFileDict[groupIndex][idx - 1];
      if (prevItem.played && prevItem.audio.paused && !stopList.includes(groupIndex)) {
        const curr = audioFileDict[groupIndex]?.[idx]?.audio;
        curr?.play();
      }
    }
  };

  // ---------- Trigger helpers (robust parsing) ----------
  const normalizeForTrigger = (raw: string) =>
    raw
      // remove inline/backtick markup and zero-width chars
      .replace(/[`]/g, " ")
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      // collapse whitespace
      .replace(/\s+/g, " ")
      .trim();

  type AutoTrigger =
    | { kind: "wikipedia"; q: string; n?: number; collection?: string }
    | { kind: "papers"; q: string; n?: number }
    | { kind: "bildungsplan"; q: string; n?: number };

  const findTriggersInText = (raw: string): AutoTrigger[] => {
    const t = normalizeForTrigger(raw);

    // allow "# wikipedia : q", "#wikipedia_de: q", etc.
    const rxWiki =
      /#\s*wikipedia(?:_(de|en))?\s*:\s*([^:\n]+?)(?:\s*:\s*(\d+))?(?=$|\s)/i;
    const rxPapers = /#\s*papers\s*:\s*([^:\n]+?)(?:\s*:\s*(\d+))?(?=$|\s)/i;
    const rxBP =
      /#\s*bildungsplan\s*:\s*([^:\n]+?)(?:\s*:\s*(\d+))?(?=$|\s)/i;

    const triggers: AutoTrigger[] = [];

    const mW = t.match(rxWiki);
    if (mW) {
      const langSuffix = (mW[1] || "").toLowerCase();
      let collection =
        lang === "en" ? "English-ConcatX-Abstract" : "German-ConcatX-Abstract";
      if (langSuffix === "de") collection = "German-ConcatX-Abstract";
      if (langSuffix === "en") collection = "English-ConcatX-Abstract";
      const q = (mW[2] || "").trim();
      const n = mW[3] ? parseInt(mW[3], 10) : undefined;
      if (q) triggers.push({ kind: "wikipedia", q, n, collection });
    }

    const mP = t.match(rxPapers);
    if (mP) {
      const q = (mP[1] || "").trim();
      const n = mP[2] ? parseInt(mP[2], 10) : undefined;
      if (q) triggers.push({ kind: "papers", q, n });
    }

    const mB = t.match(rxBP);
    if (mB) {
      const q = (mB[1] || "").trim();
      const n = mB[2] ? parseInt(mB[2], 10) : undefined;
      if (q) triggers.push({ kind: "bildungsplan", q, n });
    }

    return triggers;
  };
  // ------------------------------------------------------

  // Handle functions that interact with the chatTemplate
  // 1. handleRefreshAction: repeats query at given groupIndex
  // 2. handleEditAction: edits query at given groupIndex
  // 3. handleOnSpeakAtGroupIndexAction: plays audio at given groupIndex
  // 4. handleUploadActionToMessages: uploads from local file to messages

  // 1. handleRefreshAction (no duplication; cancel current stream if any)
  const handleRefreshAction = (groupIndex: number) => {
    if (!(groupIndex >= 0 && groupIndex < messages.length)) return;

    // Cancel any running stream
    abortRef.current?.abort();
    abortRef.current = null;
    setIsStreamComplete(true);

    // We want to re-run from this assistant turn’s *preceding user* turn (if present),
    // keeping everything before that user turn.
    let sliceStart = groupIndex;
    if (messages[groupIndex - 1]?.role === "user") {
      sliceStart = groupIndex - 1;
    }

    const prev = messages.slice(0, sliceStart) as Message[];

    // Extract the most recent user text to re-send
    // If the selected group is assistant, the user is at sliceStart
    const userMsg = messages[sliceStart];
    let userText = "";
    if (userMsg?.role === "user") {
      if (typeof userMsg.content === "string") userText = userMsg.content;
      else if (Array.isArray(userMsg.content)) {
        const t = userMsg.content.find((p: any) => p?.type === "text");
        userText = t?.text ?? "";
      }
    }
    if (!userText.trim()) return;

    setStopList([]);
    setMessages(prev);            // update UI immediately
    safePersist(prev, currentChatSuffix);
    startStream(userText, prev);  // stream from here
  };

  // 2. handleEditAction
  const handleEditAction = (groupIndex: number) => {
    const message = messages[groupIndex];
    let contentToEdit = "";

    if (typeof message.content === "string") {
      contentToEdit = message.content;
    } else if (Array.isArray(message.content)) {
      if (typeof message.content[0] === "string") {
        contentToEdit = message.content.join("");
      } else {
        // Handle content array of objects with text and image_url
        contentToEdit = message.content
          // deno-lint-ignore no-explicit-any
          .filter((item: any) => item.type === "text")
          // deno-lint-ignore no-explicit-any
          .map((item: any) => item.text)
          .join("");
      }
    }

    setQuery(contentToEdit);
    setStopList([]);
    setCurrentEditIndex(groupIndex);

    const textarea = document.querySelector("textarea");
    textarea?.focus();
  };

  // NEW: helper – parse index from "streamN" or "manual_streamN"
  const indexFromSourceFunction = (sourceFunction: string): number => {
    const m = sourceFunction.match(/(?:^|_)stream(\d+)/);
    return m ? Math.max(0, Number(m[1]) - 1) : 0;
  };

  // NEW: send smart chunks in parallel
  const speakMessageInSmartChunks = (groupIndex: number, fullText: string) => {
    const chunks = splitIntoSmartChunks(fullText);
    if (chunks.length === 0) return;

    // clear old audios for this group (fresh regeneration)
    setAudioFileDict((prev) => {
      const next = { ...prev };
      next[groupIndex] = {};
      return next;
    });

    // mark that we should autostart when first chunk arrives
    setPendingManualSpeak((prev) => {
      const cp = new Set(prev);
      cp.add(groupIndex);
      return cp;
    });

    // fire *all* chunks concurrently
    chunks.forEach((chunk, i) => {
      getTTS(chunk, groupIndex, `manual_stream${i + 1}`);
    });
  };

  // 3. handleOnSpeakAtGroupIndexAction  (MODIFIED: uses Smart-Chunking)
  const handleOnSpeakAtGroupIndexAction = (groupIndex: number) => {
    if (groupIndex < 0 || groupIndex >= messages.length) return;

    const lastMessage = messages[groupIndex];
    const currentText = Array.isArray(lastMessage?.content)
      ? lastMessage.content
          .filter((c: any) => c?.type === "text")
          .map((c: any) => c?.text ?? "")
          .join("")
      : (lastMessage?.content ?? "");

    const text = String(currentText || "").trim();
    if (!text) return;

    if (!audioFileDict[groupIndex]) {
      // first time → generate chunks and parallel TTS
      speakMessageInSmartChunks(groupIndex, text);
      return;
    }

    // If we already have audio but text changed, regenerate via chunks
    const firstItem = audioFileDict[groupIndex][0];
    const prevText = firstItem?.audio?.__text ?? "";
    if (text !== String(prevText).trim()) {
      speakMessageInSmartChunks(groupIndex, text);
      return;
    }

    // Otherwise play/pause as before
    const indexThatIsPlaying = Object.entries(audioFileDict[groupIndex])
      .findIndex(([_, item]) => !item.audio.paused);

    if (indexThatIsPlaying !== -1) {
      (Object.values(audioFileDict) as Record<number, AudioItem>[]).forEach(
        (group) => {
          (Object.values(group) as AudioItem[]).forEach((item) => {
            if (!item.audio.paused) {
              item.audio.pause();
              item.audio.currentTime = 0;
            }
          });
        },
      );

      setStopList([...stopList, groupIndex]);
      setAudioFileDict({ ...audioFileDict });
    } else {
      setStopList(stopList.filter((item) => item !== groupIndex));
      (Object.values(audioFileDict) as Record<number, AudioItem>[]).forEach(
        (group) => {
          (Object.values(group) as AudioItem[]).forEach((item) => {
            if (!item.audio.paused) {
              item.audio.pause();
              item.audio.currentTime = 0;
            }
          });
        },
      );

      startOrderedPlaybackForGroup(groupIndex);
    }
  };

  // 4. handleUploadActionToMessages
  const handleUploadActionToMessages = (uploadedMessages: Message[]) => {
    const newMessages = uploadedMessages.map((msg) => [msg]).flat();
    setMessages(newMessages);
    safePersist(newMessages, currentChatSuffix);
    const textarea = document.querySelector("textarea");
    textarea?.focus();
  };

  const handleImagesUploaded = (newImages: Image[]) => {
    setImages((prevImages) => [...prevImages, ...newImages]);
  };

  const handlePdfsUploaded = (newPdfs: PdfFile[]) => {
    setPdfs((prevPdfs) => [...prevPdfs, ...newPdfs]);
  };

  const handleImageChange = (images_: Image[]) => {
    setImages(images_);
  };

  // ======= TTS CLEANING (NEW) =======
  // Remove asterisks and emoji characters (keep words intact)
  const cleanForTTS = (s: string) =>
    s
      .replace(/\*/g, "")
      // Remove common emoji ranges + variation selectors + ZWJ
      .replace(
        /[\u{1F1E6}-\u{1F1FF}\u{1F300}-\u{1F5FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FAFF}\u2600-\u26FF\u2700-\u27BF\uFE0F\u200D]/gu,
        ""
      )
      .replace(/\s{2,}/g, " ");

  // ======= THINK TAG STREAM FILTER (NEW) =======
  // Incremental filter that hides <think>...</think> blocks from both UI and TTS.
  type ThinkState = { inThink: boolean; carry: string };
  const makeThinkFilter = () => {
    const state: ThinkState = { inThink: false, carry: "" };
    return (chunk: string): string => {
      let s = state.carry + chunk;
      let out = "";
      let i = 0;
      const lower = () => s.toLowerCase();

      while (i < s.length) {
        if (!state.inThink) {
          const L = lower();
          let j = L.indexOf("<think", i);
          if (j === -1) {
            // output everything except possible start of "<think"
            const keepTail = Math.max(0, s.length - 6);
            out += s.slice(i, keepTail);
            state.carry = s.slice(keepTail);
            i = s.length;
            break;
          } else {
            // output text before the tag
            out += s.slice(i, j);
            // find end of opening tag
            const k = s.indexOf(">", j);
            if (k === -1) {
              // incomplete opening tag -> carry
              state.carry = s.slice(j);
              i = s.length;
              break;
            } else {
              state.inThink = true;
              i = k + 1; // skip "<think...>"
            }
          }
        } else {
          // inside think: skip until closing
          const L = lower();
          let j = L.indexOf("</think", i);
          if (j === -1) {
            // keep tail that might contain start of closing tag
            const keepTail = Math.max(0, s.length - 8);
            state.carry = s.slice(keepTail);
            i = s.length;
            break;
          } else {
            const k = s.indexOf(">", j);
            if (k === -1) {
              state.carry = s.slice(j);
              i = s.length;
              break;
            } else {
              state.inThink = false;
              i = k + 1; // resume output after closing tag
            }
          }
        }
      }

      // if finished and not in a tag, clear carry (we already preserved possible prefix)
      if (!state.inThink && i === s.length && state.carry && !state.carry.startsWith("<")) {
        // safety: if carry doesn't look like a tag start, flush it out next time via prefix logic
      }
      return out;
    };
  };

  // BILDUNGSPLAN
  const fetchBildungsplan = async (query_: string, top_n: number) => {
    try {
      const response = await fetch("/api/bildungsplan", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: query_,
          top_n: top_n,
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json() as BildungsplanResponse;

      return data;
    } catch (error) {
      console.error("Error in bildungsplan API:", error);
    }
  };

  // WIKIPEDIA
  const fetchWikipedia = async (
    text: string,
    collection: string,
    n: number,
  ) => {
    try {
      const response = await fetch("/api/wikipedia", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: text,
          collection: collection,
          n: n,
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json() as WikipediaResult[];

      return data;
    } catch (error) {
      console.error("Error in wikipedia API:", error);
    }
  };

  // PAPERS
  const fetchPapers = async (query_: string, limit: number) => {
    try {
      const response = await fetch("/api/papers", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: query_,
          limit: limit,
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json() as PapersResponse;

      return data;
    } catch (error) {
      console.error("Error in papers API:", error);
    }
  };

  // PRIMARY FUNCTIONS
  // 1. startStream: getting LLM output and streams it to ChatTemplate through messages
  // 2. getTTS: plays audio if
  // 2.1 readAlways is true and new stream comes in or
  // 2.2 the loudspeaker button is clicked in chatTemplate to play groupIndex
  //     (handleOnSpeakAtGroupIndex)

  // 1) Drop-in replacement for: islands/ChatIsland.tsx -> const startStream = async (...)
  const startStream = async (transcript: string, prevMessages?: Message[]) => {
    // If we're editing a previous user message (and not the last one), just update and exit
    if (currentEditIndex !== undefined && currentEditIndex !== -1) {
      const updated = [...messages];
      updated[currentEditIndex] = {
        ...updated[currentEditIndex],
        content: query,
      };
      setMessages(updated);
      safePersist(updated, currentChatSuffix);
      setQuery("");
      setCurrentEditIndex(-1);
      return;
    }

    // Stop any ongoing audio and reset players
    (Object.values(audioFileDict) as Record<number, AudioItem>[]).forEach(
      (group) => {
        (Object.values(group) as AudioItem[]).forEach((item) => {
          if (!item.audio.paused) item.audio.pause();
          item.audio.currentTime = 0;
        });
      },
    );
    setAudioFileDict({ ...audioFileDict });

    if (!isStreamComplete) return;

    // Cancel any previous fetchEventSource if it exists
    abortRef.current?.abort();
    abortRef.current = new AbortController();

    setIsStreamComplete(false);
    setResetTranscript((n) => n + 1);

    // Build the outbound user "content" payload (text + images + PDFs)
    const userText = transcript && transcript.trim() !== "" ? transcript : query;
    let previousMessages = prevMessages || messages;

    // Normalize any array-based assistant texts into plain strings for safety
    previousMessages = previousMessages.map((m) => {
      if (typeof m.content === "string") return m;
      if (Array.isArray(m.content) && typeof m.content[0] === "string") {
        return { role: m.role, content: (m.content as string[]).join("") };
      }
      return m;
    });

    const contentPayload: any[] = [{ type: "text", text: userText }];
    if (images.length > 0) for (const img of images) contentPayload.push(img);
    if (pdfs.length > 0) for (const pdf of pdfs) contentPayload.push(pdf);

    const newMessagesArr: Message[] = [
      ...previousMessages,
      { role: "user", content: contentPayload },
    ];

    // Clear composer state immediately for snappy UX
    setImages([]);
    setPdfs([]);
    setMessages(newMessagesArr);
    safePersist(newMessagesArr, currentChatSuffix);
    setQuery("");
    resetComposerHeight();

    // Hashtag short-circuits (#wikipedia / #papers / #bildungsplan) — non-streaming
    const lower = userText.toLowerCase();

    // #wikipedia[:collection][:n]
    if (
      lower.includes("#wikipedia") || lower.includes("#wikipedia_de") ||
      lower.includes("#wikipedia_en")
    ) {
      let collection = lang === "en"
        ? "English-ConcatX-Abstract"
        : "German-ConcatX-Abstract";
      if (lower.includes("#wikipedia_de")) collection = "German-ConcatX-Abstract";
      if (lower.includes("#wikipedia_en")) collection = "English-ConcatX-Abstract";

      const parts = userText.split(":");
      const q = (parts[1] ?? "").trim();
      let n = 5;
      if (parts.length > 2) n = parseInt((parts[2] ?? "5").trim(), 10) || 5;

      const res = await fetchWikipedia(q, collection, n);
      const out = (res || []).map((r: WikipediaResult, i: number) =>
        `**${chatIslandContent[lang].result} ${i + 1} ${chatIslandContent[lang].of} ${(res || []).length}**\n**${chatIslandContent[lang].wikipediaTitle}**: ${r.Title}\n**${chatIslandContent[lang].wikipediaURL}**: ${r.URL}\n**${chatIslandContent[lang].wikipediaContent}**: ${r.content}\n**${chatIslandContent[lang].wikipediaScore}**: ${r.score}`
      ).join("\n\n");

      setMessages((m) => {
        const next = [...m, { role: "assistant", content: out }];
        safePersist(next, currentChatSuffix);
        return next;
      });
      setIsStreamComplete(true);
      return;
    }

    // #papers:query[:limit]
    if (lower.includes("#papers")) {
      const parts = userText.split(":");
      const q = (parts[1] ?? "").trim();
      let limit = 5;
      if (parts.length > 2) limit = parseInt((parts[2] ?? "5").trim(), 10) || 5;

      const res = await fetchPapers(q, limit);
      const items = res?.payload?.items || [];
      const out = items.map((it: PapersItem, i: number) => {
        const authors = it.authors?.join(", ") || "";
        const subjs = it.subjects?.join(", ") || "";
        const papersTitle = chatIslandContent[lang].papersTitle ?? "Title";
        const papersAuthors = chatIslandContent[lang].papersAuthors ?? "Authors";
        const papersSubjects = chatIslandContent[lang].papersSubjects ?? "Subjects";
        const papersAbstract = chatIslandContent[lang].papersAbstract ?? "Abstract";
        const doiLabel = "DOI";
        return `**${chatIslandContent[lang].result} ${i + 1} ${chatIslandContent[lang].of} ${items.length}**\n**${papersTitle}**: ${it.title}\n**${papersAuthors}**: ${authors}\n**${papersSubjects}**: ${subjs}\n**${doiLabel}**: ${it.doi}\n**${papersAbstract}**: ${it.abstract}`;
      }).join("\n\n");

      setMessages((m) => {
        const next = [...m, { role: "assistant", content: out }];
        safePersist(next, currentChatSuffix);
        return next;
      });
      setIsStreamComplete(true);
      return;
    }

    // #bildungsplan:query[:top_n]
    if (lower.includes("#bildungsplan")) {
      const parts = userText.split(":");
      const q = (parts[1] ?? "").trim();
      let top_n = 5;
      if (parts.length > 2) top_n = parseInt((parts[2] ?? "5").trim(), 10) || 5;

      const res = await fetchBildungsplan(q, top_n);
      const results = res?.results || [];
      const out = results.map((r, i) =>
        `**${chatIslandContent[lang].result} ${i + 1} ${chatIslandContent[lang].of} ${results.length}**\n${r.text}\n\n**Score**: ${r.score}`
      ).join("\n\n");

      setMessages((m) => {
        const next = [...m, { role: "assistant", content: out }];
        safePersist(next, currentChatSuffix);
        return next;
      });
      setIsStreamComplete(true);
      return;
    }

    // === Streaming path (LLM) ===
    const assistantGroupIndex = newMessagesArr.length; // where assistant message would appear
    const ongoingStream: string[] = []; // buffer for sentence-boundary TTS
    let currentAudioIndex = 1;

    // For reliable auto-trigger: accumulate assistant text locally (after think-filter)
    let assistantAccum = "";
    let autoTriggered = false;

    // Lazy draft controls
    let createdDraft = false;
    let gotAnyText = false;

    // NEW: build a think filter instance for this stream
    const filterThink = makeThinkFilter();

    const ensureDraft = () => {
      if (!createdDraft) {
        createdDraft = true;
        setMessages((prev) => {
          const next = [...prev, { role: "assistant", content: "" }];
        safePersist(next, currentChatSuffix);
          return next;
        });
      }
    };

    const appendToAssistant = (txt: string) => {
      if (!txt) return;
      setMessages((prev) => {
        if (!createdDraft) {
          createdDraft = true;
          const next = [...prev, { role: "assistant", content: txt }];
          safePersist(next, currentChatSuffix);
          return next;
        }
        const idx = prev.length - 1;
        const last = prev[idx];
        const prevText =
          typeof last.content === "string"
            ? last.content
            : Array.isArray(last.content)
              ? (last.content as string[]).join("")
              : "";
        const updated = { ...last, content: prevText + txt };
        const next = [...prev.slice(0, -1), updated];
        safePersist(next, currentChatSuffix);
        return next;
      });
    };

    await fetchEventSource("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lang,
        messages: newMessagesArr,
        universalApiKey: settings.universalApiKey,
        llmApiUrl: settings.apiUrl,
        llmApiKey: settings.apiKey,
        llmApiModel: settings.apiModel,
        vlmApiUrl: settings.vlmUrl,
        vlmApiKey: settings.vlmKey,
        vlmApiModel: settings.vlmModel,
        vlmCorrectionModel: settings.vlmCorrectionModel,
        systemPrompt: settings.systemPrompt,
      }),
      signal: abortRef.current?.signal,

      async onopen(response: Response) {
        if (response.ok) return;
        if (response.status !== 200) {
          const errorText = await response.text().catch(() => "");
          ensureDraft();
          appendToAssistant(
            `\n\n**BACKEND ERROR**\nStatuscode: ${response.status}\nMessage: ${errorText || response.statusText}`,
          );
          throw new FatalError(errorText || response.statusText);
        }
        throw new RetriableError();
      },

      onmessage(ev: EventSourceMessage) {
        if (ev.event === "error") {
          const err = (() => {
            try {
              return JSON.parse(ev.data);
            } catch {
              return { message: ev.data };
            }
          })();
          ensureDraft();
          appendToAssistant(
            `\n\n**BACKEND ERROR**\nStatuscode: ${err?.status ?? ""}\nMessage: ${err?.message ?? ""}`,
          );
          return;
        }
        if (ev.event === "no_content") {
          return;
        }

        let rawChunk = "";
        try {
          rawChunk = JSON.parse(ev.data) as string; // server sends JSON.stringify(chunk)
        } catch {
          return;
        }
        if (!rawChunk) return;

        // Filter THINK tokens incrementally (affects both UI and TTS)
        const chunk = filterThink(rawChunk);
        if (!chunk) return; // If entire piece was think-only, skip fully.

        gotAnyText = true;
        ensureDraft();

        // accumulate *visible* text for triggers
        assistantAccum += chunk;

        // Buffer for TTS by sentence
        ongoingStream.push(chunk);
        const combined = ongoingStream.join("");

        // speak when we hit a sentence-end that's not a decimal number boundary
        const re = /(?<!\d)[.!?]/g;
        let lastIdx = -1, m: RegExpExecArray | null;
        while ((m = re.exec(combined)) !== null) lastIdx = m.index;
        if (lastIdx !== -1) {
          const split = lastIdx + 1;
          const toSpeak = combined.slice(0, split).trim();
          const remaining = combined.slice(split);
          if (toSpeak) {
            getTTS(toSpeak, assistantGroupIndex, `stream${currentAudioIndex}`);
            currentAudioIndex++;
          }
          ongoingStream.length = 0;
          if (remaining.trim()) ongoingStream.push(remaining);
        }

        // Append filtered chunk to assistant bubble
        appendToAssistant(chunk);
      },

      onerror(err: FatalError) {
        setIsStreamComplete(true);
        ensureDraft();
        appendToAssistant(`\n\n${String(err?.message || err)}`);
        throw err;
      },

      onclose() {
        setIsStreamComplete(true);
        setQuery("");

        if (!gotAnyText) {
          setMessages((prev) => {
            if (!prev.length) return prev;
            const last = prev[prev.length - 1];
            const txt =
              typeof last.content === "string"
                ? last.content
                : Array.isArray(last.content)
                  ? (last.content as string[]).join("")
                  : "";
            if (last?.role === "assistant" && (!txt || txt.trim() === "")) {
              const next = prev.slice(0, -1);
              safePersist(next, currentChatSuffix);
              return next; // drop empty
            }
            return prev;
          });
        } else {
          const remaining = ongoingStream.join("").trim();
          if (remaining) {
            getTTS(remaining, assistantGroupIndex, `stream${currentAudioIndex}`);
          }
        }

        // ---- Auto-trigger detection (race-free, uses assistantAccum) ----
        if (!autoTriggered && assistantAccum.trim()) {
          const triggers = findTriggersInText(assistantAccum);
          if (triggers.length) {
            autoTriggered = true;
            (async () => {
              for (const trig of triggers) {
                if (trig.kind === "wikipedia") {
                  const n = trig.n ?? 5;
                  const collection =
                    trig.collection ??
                    (lang === "en"
                      ? "English-ConcatX-Abstract"
                      : "German-ConcatX-Abstract");
                  const res = await fetchWikipedia(trig.q, collection, n);
                  const out = (res || []).map((r: WikipediaResult, i: number) =>
                    `**${chatIslandContent[lang].result} ${i + 1} ${chatIslandContent[lang].of} ${(res || []).length}**\n**${chatIslandContent[lang].wikipediaTitle}**: ${r.Title}\n**${chatIslandContent[lang].wikipediaURL}**: ${r.URL}\n**${chatIslandContent[lang].wikipediaContent}**: ${r.content}\n**${chatIslandContent[lang].wikipediaScore}**: ${r.score}`
                  ).join("\n\n");
                  setMessages((m) => {
                    const next = [...m, { role: "assistant", content: out }];
                    safePersist(next, currentChatSuffix);
                    return next;
                  });
                } else if (trig.kind === "papers") {
                  const limit = trig.n ?? 5;
                  const res = await fetchPapers(trig.q, limit);
                  const items = res?.payload?.items || [];
                  const out = items.map((it: PapersItem, i: number) => {
                    const authors = it.authors?.join(", ") || "";
                    const subjs = it.subjects?.join(", ") || "";
                    const papersTitle = chatIslandContent[lang].papersTitle ?? "Title";
                    const papersAuthors = chatIslandContent[lang].papersAuthors ?? "Authors";
                    const papersSubjects = chatIslandContent[lang].papersSubjects ?? "Subjects";
                    const papersAbstract = chatIslandContent[lang].papersAbstract ?? "Abstract";
                    const doiLabel = "DOI";
                    return `**${chatIslandContent[lang].result} ${i + 1} ${chatIslandContent[lang].of} ${items.length}**\n**${papersTitle}**: ${it.title}\n**${papersAuthors}**: ${authors}\n**${papersSubjects}**: ${subjs}\n**${doiLabel}**: ${it.doi}\n**${papersAbstract}**: ${it.abstract}`;
                  }).join("\n\n");
                  setMessages((m) => {
                    const next = [...m, { role: "assistant", content: out }];
                    safePersist(next, currentChatSuffix);
                    return next;
                  });
                } else if (trig.kind === "bildungsplan") {
                  const top_n = trig.n ?? 5;
                  const res = await fetchBildungsplan(trig.q, top_n);
                  const results = res?.results || [];
                  const out = results.map((r, i) =>
                    `**${chatIslandContent[lang].result} ${i + 1} ${chatIslandContent[lang].of} ${results.length}**\n${r.text}\n\n**Score**: ${r.score}`
                  ).join("\n\n");
                  setMessages((m) => {
                    const next = [...m, { role: "assistant", content: out }];
                    safePersist(next, currentChatSuffix);
                    return next;
                  });
                }
              }
            })();
          }
        }
        // ----------------------------------------------------------------

        abortRef.current = null;
      },
    });
  };

  // 2. getTTS  (MODIFIED: supports manual_streamN + robust chaining + CLEANING)
  const getTTS = async (
    text: string,
    groupIndex: number,
    sourceFunction: string,
  ) => {
    // Only return early if readAlways is false AND this is a *pure streaming* request (not manual)
    if (!readAlways && /^stream\d+$/.test(sourceFunction)) return;

    // Clean text for TTS (remove asterisks + emojis) but keep original for equality checks
    const ttsText = cleanForTTS(text);

    if (text === chatIslandContent[lang]["welcomeMessage"]) {
      const audioFile = text === chatIslandContent["de"]["welcomeMessage"]
        ? "./intro.mp3"
        : "./intro-en.mp3";
      const audio = new Audio(audioFile) as HTMLAudioElement & { __text?: string };
      audio.__text = text;

      const sourceFunctionIndex = indexFromSourceFunction(sourceFunction);

      if (!audioFileDict[groupIndex]) audioFileDict[groupIndex] = {};
      audioFileDict[groupIndex][sourceFunctionIndex] = {
        audio: audio,
        played: false,
      };

      // pause all other groups
      const newStopList = stopList.slice();
      for (let i = 0; i < groupIndex; i++) {
        if (audioFileDict[i]) {
          (Object.values(audioFileDict[i]) as AudioItem[]).forEach((item) => {
            if (!item.audio.paused) {
              item.audio.pause();
              item.audio.currentTime = 0;
              if (!newStopList.includes(i)) newStopList.push(i);
            }
          });
        }
      }

      setStopList(newStopList);
      setAudioFileDict({ ...audioFileDict });

      if (sourceFunction.startsWith("manual_")) {
        // manual path: start chain when first arrives
        setPendingManualSpeak((prev) => {
          if (prev.has(groupIndex) && audioFileDict[groupIndex]?.[0]) {
            setTimeout(() => startOrderedPlaybackForGroup(groupIndex), 0);
            const cp = new Set(prev); cp.delete(groupIndex); return cp;
          }
          return prev;
        });
      } else if (sourceFunction === "handleOnSpeakAtGroupIndexAction") {
        handleOnSpeakAtGroupIndexAction(groupIndex);
      }
      return;
    }

    try {
      const response = await fetch("/api/tts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: ttsText,                   // cleaned!
          textPosition: sourceFunction,
          voice: lang === "en" ? "Stefanie" : "Florian",
          ttsKey: settings.ttsKey,
          ttsUrl: settings.ttsUrl,
          ttsModel: settings.ttsModel,
          universalApiKey: settings.universalApiKey,
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const audioData = await response.arrayBuffer();
      const audioBlob = new Blob([audioData], { type: "audio/wav" });
      const audioUrl = URL.createObjectURL(audioBlob);
      const audio = new Audio(audioUrl) as HTMLAudioElement & { __text?: string };
      audio.__text = text; // keep original (with stars/emojis) for regen checks

      // ensure group slot
      if (!audioFileDict[groupIndex]) audioFileDict[groupIndex] = {};

      // compute index for both "streamN" and "manual_streamN"
      const idx = indexFromSourceFunction(sourceFunction);

      audioFileDict[groupIndex][idx] = {
        audio: audio,
        played: false,
      };

      // dynamic chaining: link to previous if exists, and link this to next (when present later)
      wireNeighborChaining(groupIndex, idx);
      audio.onended = () => {
        const next = audioFileDict[groupIndex]?.[idx + 1]?.audio;
        if (next) next.play();
        setAudioFileDict({ ...audioFileDict });
      };

      setAudioFileDict((prev) => ({
        ...prev,
        [groupIndex]: audioFileDict[groupIndex],
      }));

      // manual first chunk arrived → autostart
      if (sourceFunction.startsWith("manual_")) {
        setPendingManualSpeak((prev) => {
          const group = audioFileDict[groupIndex] || {};
          const firstReady = !!group[0]?.audio || idx === 0;
          if (prev.has(groupIndex) && firstReady) {
            setTimeout(() => startOrderedPlaybackForGroup(groupIndex), 0);
            const cp = new Set(prev); cp.delete(groupIndex); return cp;
          }
          return prev;
        });
      } else if (sourceFunction === "handleOnSpeakAtGroupIndexAction") {
        handleOnSpeakAtGroupIndexAction(groupIndex);
      }
    } catch (error) {
      console.error("Error fetching TTS:", error);
    }
  };

  // General functions
  // 0. toggleAutoScroll
  // 1. toggleReadAlways
  // 2. stopAndResetAudio

  // 0. toggleAutoScroll
  const toggleAutoScroll = (value: boolean) => {
    setAutoScroll(value);
  };

  // 1. toggleReadAlways
  const toggleReadAlways = (value: boolean) => {
    setReadAlways(value);
    if (!value) {
      (Object.values(audioFileDict) as Record<number, AudioItem>[]).forEach(
        (group) => {
          (Object.values(group) as AudioItem[]).forEach((item: AudioItem) => {
            if (!item.audio.paused) {
              item.audio.pause();
              item.audio.currentTime = 0;
            }
          });
        },
      );
      setStopList(Object.keys(audioFileDict).map(Number));
    }
  };

  // 2. stopAndResetAudio
  const stopAndResetAudio = () => {
    (Object.values(audioFileDict) as Record<number, AudioItem>[]).forEach(
      (group) => {
        (Object.values(group) as AudioItem[]).forEach((item: AudioItem) => {
          if (!item.audio.paused) {
            item.audio.pause();
            item.audio.currentTime = 0;
          }
        });
      },
    );
    setAudioFileDict({}); // clear old audios
  };

  // Chat functions overview
  // 1. startNewChat
  // 2. deleteCurrentChat
  // 3. deleteAllChats
  // 4. saveChatsToLocalFile
  // 5. restoreChatsFromLocalFile

  // 1. startNewChat
  const startNewChat = () => {
    const maxValueInChatSuffix = Math.max(
      ...localStorageKeys.map((key) => Number(key.slice(10))),
    );
    const newChatSuffix = String(Number(maxValueInChatSuffix) + 1);

    const welcome = [
      {
        role: "assistant",
        content: [chatIslandContent[lang]["welcomeMessage"]],
      },
    ] as Message[];

    setMessages(welcome);
    setCurrentChatSuffix(newChatSuffix);
    safePersist(welcome, newChatSuffix);
    resetComposerHeight();
  };

  // 2. deleteCurrentChat
  const deleteCurrentChat = () => {
    if (localStorageKeys.length > 1) {
      localStorage.removeItem("bude-chat-" + currentChatSuffix);

      const nextChatSuffix = localStorageKeys
        .filter((key: string) => key !== "bude-chat-" + currentChatSuffix)
        .sort((a, b) => Number(a.slice(10)) - Number(b.slice(10)))[0]
        .slice(10);

      setMessages(
        JSON.parse(
          String(localStorage.getItem("bude-chat-" + nextChatSuffix)),
        ),
      );
      setCurrentChatSuffix(nextChatSuffix);
    } else {
      const welcome = [
        {
          role: "assistant",
          content: [chatIslandContent[lang]["welcomeMessage"]],
        },
      ] as Message[];
      setMessages(welcome);
      safePersist(welcome, "0");
    }
    stopAndResetAudio();
  };

  // 3. deleteAllChats
  const deleteAllChats = () => {
    localStorage.clear();
    const welcome = [
      {
        role: "assistant",
        content: [chatIslandContent[lang]["welcomeMessage"]],
      },
    ] as Message[];
    setMessages(welcome);
    setLocalStorageKeys([]);
    setCurrentChatSuffix("0");
    safePersist(welcome, "0");
    stopAndResetAudio();
  };

  // 4. saveChatsToLocalFile
  const saveChatsToLocalFile = () => {
    // deno-lint-ignore no-explicit-any
    const chats = {} as any;
    for (const key of localStorageKeys) {
      chats[key] = JSON.parse(String(localStorage.getItem(key)));
    }
    const chatsString = JSON.stringify(chats);
    const blob = new Blob([chatsString], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const currentDate = new Date();
    a.download = `chats-${currentDate.toISOString()}.json`;
    a.click();
  };

  // 5. restoreChatsFromLocalFile
  // deno-lint-ignore no-explicit-any
  const restoreChatsFromLocalFile = (e: any) => {
    const file = e.target.files[0];
    if (!file) {
      console.error("No file selected");
      return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const chats = JSON.parse(event.target?.result as string);

        // Restore chats to localStorage
        for (const [key, value] of Object.entries(chats)) {
          localStorage.setItem(key, JSON.stringify(value));
        }

        const newChatSuffix = chats
          ? Object.keys(chats).sort((a, b) => Number(a.slice(10)) - Number(b.slice(10)))[0].slice(10)
          : "0";
        setLocalStorageKeys(
          Object.keys(localStorage).filter((key) =>
            key.startsWith("bude-chat-")
          ),
        );
        setCurrentChatSuffix(newChatSuffix);
        const nextMsgs = chats["bude-chat-" + newChatSuffix] as Message[];
        setMessages(nextMsgs);
        safePersist(nextMsgs, newChatSuffix);
      } catch (error) {
        console.error("Error parsing JSON file:", error);
      }
    };

    reader.onerror = (error) => {
      console.error("Error reading file:", error);
    };

    reader.readAsText(file);
  };

  // MAIN CONTENT THAT IS RENDERED
  return (
    <div class="w-full">
      <div class="flex items-center mb-4 flex-wrap">
        {/* Add settings button next to existing chat buttons */}
        <button
          class="rounded-full bg-slate-200 px-4 py-2 mx-2 mb-2"
          onClick={() => setShowSettings(true)}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            height="24"
            viewBox="0 -960 960 960"
            width="24"
          >
            <path d="m370-80-16-128q-13-5-24.5-12T307-235l-119 50L78-375l103-78q-1-7-1-13.5v-27q0-6.5 1-13.5L78-585l110-190 119 50q11-8 23-15t24-12l16-128h220l16 128q13 5 24.5 12t22.5 15l119-50 110 190-103 78q1 7 1 13.5v27q0 6.5-2 13.5l103 78-110 190-118-50q-11 8-23 15t-24 12L590-80H370Zm112-260q58 0 99-41t41-99q0-58-41-99t-99-41q-58 0-99 41t-41 99q0 58 41 99t99 41Z" />
          </svg>
        </button>

        {[...localStorageKeys]
          .sort((a, b) => Number(a.slice(10)) - Number(b.slice(10)))
          .map((key) => {
            const chatSuffix = key.substring(10);
            return (
              <button
                className={`rounded-full ${
                  chatSuffix === currentChatSuffix
                    ? "bg-slate-400 text-white font-bold"
                    : "bg-slate-200"
                } px-4 py-2 mx-2 mb-2`}
                onClick={() => setCurrentChatSuffix(chatSuffix)}
              >
                {Number(chatSuffix) + 1}
              </button>
            );
          })}

        <button
          class="rounded-full bg-slate-200 px-4 py-2 mx-2 mb-2"
          onClick={() => startNewChat()}
        >
          +
        </button>

        {Object.keys(localStorageKeys).length > 0 && (
          <button
            class="rounded-full bg-red-200 font-bold px-4 py-2 mx-2 mb-2"
            onClick={() => deleteCurrentChat()}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              class="inline-block"
              height="24px"
              viewBox="0 -960 960 960"
              width="24px"
              fill="#000000"
            >
              <path d="M240-800v200-200 640-9.5 9.5-640Zm0 720q-33 0-56.5-23.5T160-160v-640q0-33 23.5-56.5T240-880h320l240 240v174q-19-7-39-10.5t-41-3.5v-120H520v-200H240v640h254q8 23 20 43t28 37H240Zm396-20-56-56 84-84-84-84 56-56 84 84 84-84 56 56-83 84 83 84-56 56-84-83-84 83Z" />
            </svg>
            {chatIslandContent[lang]["deleteCurrentChat"]}
          </button>
        )}

        {Object.keys(localStorageKeys).length > 0 && (
          <button
            class="rounded-full bg-red-200 font-bold px-4 py-2 mx-2 mb-2"
            onClick={() => deleteAllChats()}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              class="inline-block"
              height="24px"
              viewBox="0 -960 960 960"
              width="24px"
              fill="#000000"
            >
              <path d="M240-800v200-200 640-9.5 9.5-640Zm0 720q-33 0-56.5-23.5T160-160v-640q0-33 23.5-56.5T240-880h320l240 240v174q-19-7-39-10.5t-41-3.5v-120H520v-200H240v640h254q8 23 20 43t28 37H240Zm396-20-56-56 84-84-84-84 56-56 84 84 84-84 56 56-83 84 83 84-56 56-84-83-84 83Z" />
            </svg>
            {chatIslandContent[lang]["deleteAllChats"]}
          </button>
        )}

        {Object.keys(localStorageKeys).length > 0 && (
          <button
            class="rounded-full bg-green-200 font-bold px-4 py-2 mx-2 mb-2"
            onClick={() => saveChatsToLocalFile()}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              class="inline"
              height="24px"
              viewBox="0 -960 960 960"
              width="24px"
              fill="#000000"
            >
              <path d="M480-320 280-520l56-58 104 104v-326h80v326l104-104 56 58-200 200ZM240-160q-33 0-56.5-23.5T160-240v-120h80v120h480v-120h80v120q0 33-23.5 56.5T720-160H240Z" />
            </svg>
          </button>
        )}

        <input
          type="file"
          id="restoreChatFromLocalFile"
          style="display: none;"
          onChange={(e) => restoreChatsFromLocalFile(e)}
        />
        <button
          class="rounded-full bg-green-200 font-bold px-4 py-2 mx-2 mb-2"
          onClick={() =>
            document.getElementById("restoreChatFromLocalFile")?.click()}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            class="inline"
            height="24px"
            viewBox="0 -960 960 960"
            width="24px"
            fill="#000000"
          >
            <path d="M440-200h80v-167l64 64 56-57-160-160-160 160 57 56 63-63v167ZM240-80q-33 0-56.5-23.5T160-160v-640q0-33 23.5-56.5T240-880h320l240 240v480q0 33-23.5 56.5T720-80H240Zm280-520v-200H240v640h480v-440H520ZM240-800v200-200 640-640Z" />
          </svg>
        </button>
      </div>

      <ChatTemplate
        lang={lang}
        parentImages={images}
        parentPdfs={pdfs}
        messages={messages}
        isComplete={isStreamComplete}
        onCancelAction={() => {
          abortRef.current?.abort();
          abortRef.current = null;
          setIsStreamComplete(true);
        }}
        readAlways={readAlways}
        autoScroll={autoScroll}
        audioFileDict={audioFileDict}
        currentEditIndex={currentEditIndex!}
        onSpeakAtGroupIndexAction={handleOnSpeakAtGroupIndexAction}
        onToggleReadAlwaysAction={() => toggleReadAlways(!readAlways)}
        onToggleAutoScrollAction={() => toggleAutoScroll(!autoScroll)}
        onRefreshAction={handleRefreshAction}
        onEditAction={handleEditAction}
        onUploadActionToMessages={handleUploadActionToMessages}
        onImageChange={handleImageChange}
        onTrashAction={() => setMessages([])}
      />

      {showSettings && (
        <Settings
          settings={settings}
          onSave={handleSaveSettings}
          onClose={() => setShowSettings(false)}
          lang={lang}
        />
      )}

      {settings.universalApiKey ||
          (settings.apiKey && settings.apiModel && settings.apiUrl)
        ? (
          <div className="relative mt-4 mb-12">
            <textarea
              value={query}
              placeholder={chatIslandContent[lang]["placeholderText"]}
              onInput={(e) => handleComposerChange(e.currentTarget.value)}
              onKeyPress={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  startStream("");
                }
              }}
              class="h-52 w-full py-4 pl-4 pr-16 border border-gray-300 rounded-lg focus:outline-none cursor-text focus:border-orange-200 focus:ring-1 focus:ring-orange-300 shadow-sm resize-none placeholder-gray-400 text-base font-medium"
              // fixed height: h-52; no dynamic resizing
            />

            <ImageUploadButton onImagesUploaded={handleImagesUploaded} />

            <PdfUploadButton onPdfsUploaded={handlePdfsUploaded} />

            <VoiceRecordButton
              resetTranscript={resetTranscript}
              sttUrl={settings.sttUrl}
              sttKey={settings.sttKey}
              sttModel={settings.sttModel}
              universalApiKey={settings.universalApiKey}
              onFinishRecording={(finalTranscript) => {
                startStream(finalTranscript);
              }}
              onInterimTranscript={(interimTranscript) => {
                setQuery((q) => (q ? q + " " : "") + interimTranscript);
              }}
            />

            <ChatSubmitButton
              onClick={() => startStream("")}
              disabled={!query && images.length === 0 && pdfs.length === 0}
            />
          </div>
        )
        : (
          <div className="relative mt-4 mb-12 bg-gray-700 rounded-md">
            <div className="text-center text-md p-4 text-white">
              {chatIslandContent[lang]["noSettings"]}
            </div>
          </div>
        )}
    </div>
  );
}
