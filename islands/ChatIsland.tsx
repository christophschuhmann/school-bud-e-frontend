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

// ---- API result types (kept minimal & safe) ----
interface WikipediaResult {
  Title: string;
  URL: string;
  content: string;
  score: number;
}
interface BildungsplanHit {
  text: string;
  score: number;
}
interface BildungsplanResponse {
  results: BildungsplanHit[];
}
interface PapersItem {
  title: string;
  authors?: string[];
  subjects?: string[];
  abstract?: string;
  doi?: string;
}
interface PapersResponse {
  payload?: { items?: PapersItem[] };
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

  // ---------- DEBUG helper (sendet Logs an den Server) ----------
  const DEBUG = true;
  const serverLog = async (stage: string, detail?: unknown) => {
    if (!DEBUG) return;
    try {
      await fetch("/api/debug", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stage,
          chat: currentChatSuffix,
          detail,
        }),
      });
    } catch {
      // debug darf niemals den Flow stören
    }
  };
  // -------------------------------------------------------------

  // dictionary containing audio files for each groupIndex for the current chat
  const [audioFileDict, setAudioFileDict] = useState<AudioFileDict>({});

  // used for STT in VoiceRecordButton
  const [resetTranscript, setResetTranscript] = useState(0);

  // General settings
  const [readAlways, setReadAlways] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  // The concrete “Image” type depends on your uploader; keep as any[] to avoid collisions with DOM Image
  const [images, setImages] = useState([] as any[]);
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

  // handy ref for async closures
  const messagesRef = useRef<Message[]>(messages);
  useEffect(() => { messagesRef.current = messages; }, [messages]);

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

  // ---------- TTS concurrency pool ----------
  const TTS_POOL_LIMIT = 6;
  const ttsActiveRef = useRef(0);
  const ttsQueueRef = useRef<(() => Promise<void>)[]>([]);
  const pumpTtsQueue = () => {
    while (ttsActiveRef.current < TTS_POOL_LIMIT && ttsQueueRef.current.length) {
      const job = ttsQueueRef.current.shift()!;
      ttsActiveRef.current++;
      job()
        .catch((e) => console.error("TTS job error:", e))
        .finally(() => {
          ttsActiveRef.current--;
          pumpTtsQueue();
        });
    }
  };
  const scheduleTTSJob = (fn: () => Promise<void>) => {
    ttsQueueRef.current.push(fn);
    pumpTtsQueue();
  };

  // ---------- Persistence helper ----------
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
  const persistThrottleRef = useRef<{ timer?: number; pending?: { msgs: Message[]; suffix: string } }>({});
  const safePersistThrottled = (msgs: Message[], suffix: string) => {
    persistThrottleRef.current.pending = { msgs, suffix };
    if (persistThrottleRef.current.timer) return;
    persistThrottleRef.current.timer = window.setTimeout(() => {
      const p = persistThrottleRef.current.pending;
      if (p) safePersist(p.msgs, p.suffix);
      if (persistThrottleRef.current.timer) clearTimeout(persistThrottleRef.current.timer);
      persistThrottleRef.current.timer = undefined;
      persistThrottleRef.current.pending = undefined;
    }, 250);
  };
  const flushPersistThrottle = () => {
    const p = persistThrottleRef.current.pending;
    if (p) safePersist(p.msgs, p.suffix);
    if (persistThrottleRef.current.timer) clearTimeout(persistThrottleRef.current.timer);
    persistThrottleRef.current.timer = undefined;
    persistThrottleRef.current.pending = undefined;
  };

  // Fixed-height composer helpers
  const resetComposerHeight = () => {
    const textarea = document.querySelector<HTMLTextAreaElement>("textarea");
    if (textarea) {
      textarea.style.height = ""; // ensure default height from CSS applies
      textarea.scrollTop = 0;
    }
  };
  const handleComposerChange = (val: string) => setQuery(val);

  // Load settings on mount
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
    localStorage.setItem("bud-e-universal-api-key", newSettings.universalApiKey);
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
    localStorage.setItem("bud-e-vlm-correction-model", newSettings.vlmCorrectionModel);
    setShowSettings(false);
  };

  // #################
  // ### useEffect ###
  // #################

  // 1) First load from localStorage
  useEffect(() => {
    let lsKeys: string[] = Object.keys(localStorage).filter((key) =>
      key.startsWith("bude-chat-")
    );
    lsKeys = lsKeys.length > 0 ? lsKeys : ["bude-chat-0"];
    lsKeys.sort((a, b) => Number(a.slice(10)) - Number(b.slice(10)));
    const currSuffix = lsKeys.length > 0 ? String(lsKeys[0].slice(10)) : "0";
    let lsMsgs = JSON.parse(String(localStorage.getItem("bude-chat-" + currSuffix)));
    lsMsgs = lsMsgs || [{ role: "assistant", content: [chatIslandContent[lang]["welcomeMessage"]] }];
    setLocalStorageKeys(lsKeys);
    setMessages(lsMsgs);
    setCurrentChatSuffix(currSuffix);
  }, []);

  // 2) Persist last assistant message when stream completes
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
            setLocalStorageKeys([...localStorageKeys, "bude-chat-" + currentChatSuffix]);
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

  // 3) Auto-scroll & persist messages on change
  useEffect(() => {
    if (autoScroll) {
      const chatContainer = document.querySelector(".chat-history");
      if (chatContainer) {
        (chatContainer as HTMLElement).scrollTo({
          top: (chatContainer as HTMLElement).scrollHeight,
          behavior: "smooth",
        });
      }
    }
    if (!firstLoad) {
      safePersist(messages, currentChatSuffix);
      setLocalStorageKeys(Object.keys(localStorage).filter((key) => key.startsWith("bude-chat-")));
    }
    if (firstLoad) setFirstLoad(false);
  }, [messages, autoScroll]);

  // 4) Switch chat
  useEffect(() => {
    const lsMsgs = JSON.parse(String(localStorage.getItem("bude-chat-" + currentChatSuffix))) || [
      { role: "assistant", content: [chatIslandContent[lang]["welcomeMessage"]] },
    ];
    if (lsMsgs.length === 1) {
      if (lsMsgs[0].content[0] !== chatIslandContent[lang]["welcomeMessage"]) {
        lsMsgs[0].content[0] = chatIslandContent[lang]["welcomeMessage"];
      }
    }
    setMessages(lsMsgs);
    stopAndResetAudio();
    setStopList([]);
    resetComposerHeight();
  }, [currentChatSuffix]);

  // 5) Auto-Play queue if readAlways
  useEffect(() => {
    if (!readAlways) return;
    Object.entries(audioFileDict).forEach(([groupIndex, groupAudios]) => {
      const nextUnplayedIndex = findNextUnplayedAudio(groupAudios);
      if (nextUnplayedIndex === null) return;

      const isLatestGroup =
        Math.max(...Object.keys(audioFileDict).map(Number)) <= Number(groupIndex);

      if (
        isLatestGroup &&
        canPlayAudio(Number(groupIndex), nextUnplayedIndex, groupAudios, stopList)
      ) {
        playAudio(groupAudios[nextUnplayedIndex].audio, Number(groupIndex), nextUnplayedIndex);
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

  // 6) Flush throttled persist on unload/hidden
  useEffect(() => {
    const flush = () => { flushPersistThrottle(); safePersist(messages, currentChatSuffix); };
    const vis = () => { if (document.visibilityState === "hidden") flush(); };
    window.addEventListener("beforeunload", flush);
    document.addEventListener("visibilitychange", vis);
    return () => {
      window.removeEventListener("beforeunload", flush);
      document.removeEventListener("visibilitychange", vis);
    };
  }, [messages, currentChatSuffix]);

  // ---------- Audio helpers ----------
  const findNextUnplayedAudio = (groupAudios: Record<number, AudioItem>): number | null => {
    const [nextUnplayed] = Object.entries(groupAudios)
      .sort(([a], [b]) => Number(a) - Number(b))
      .find(([_, item]) => !item.played) || [];
    return nextUnplayed !== undefined ? Number(nextUnplayed) : null;
  };

  const canPlayAudio = (
    groupIndex: number,
    audioIndex: number,
    groupAudios: Record<number, AudioItem>,
    stopList_: number[],
  ): boolean => {
    if (stopList_.includes(Number(groupIndex))) return false;
    const previousAudio = groupAudios[audioIndex - 1];
    return audioIndex === 0 || (previousAudio?.played && previousAudio?.audio.paused);
  };

  const playAudio = async (audio: HTMLAudioElement, groupIndex: number, audioIndex: number) => {
    try {
      await audio.play();
      setAudioFileDict((prev) => {
        const next = { ...prev };
        const group = { ...(next[groupIndex] || {}) };
        const item = { ...(group[audioIndex] || {}) } as AudioItem;
        item.played = true;
        group[audioIndex] = item;
        next[groupIndex] = group;
        return next;
      });
    } catch (err) {
      console.warn("Audio play() rejected:", err);
    }
  };

  // ---------- Smart Chunking ----------
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

  // ordered playback starter
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

    // Play first (or next-unplayed) and attach chaining
    const group = audioFileDict[groupIndex];
    if (!group) return;
    const nextIdx = findNextUnplayedAudio(group);
    const first = (nextIdx !== null ? group[nextIdx]?.audio : group[0]?.audio);
    if (!first) return;

    first.play().catch((err) => console.warn("Audio play() rejected on start:", err));
  };

  // connect manual chunks to their neighbors as they arrive (so late arrivals still chain)
  const wireNeighborChaining = (groupIndex: number, idx: number) => {
    const prev = audioFileDict[groupIndex]?.[idx - 1]?.audio;
    const curr = audioFileDict[groupIndex]?.[idx]?.audio;
    if (!curr) return;

    if (prev) {
      prev.onended = () => {
        const next = audioFileDict[groupIndex]?.[idx]?.audio;
        if (next) {
          next.play().catch((err) => console.warn("Audio play() rejected in chain:", err));
        }
        setAudioFileDict((p) => ({ ...p }));
      };

      const prevItem = audioFileDict[groupIndex][idx - 1];
      if (prevItem?.played && prevItem.audio.paused && !stopList.includes(groupIndex)) {
        curr.play().catch((err) => console.warn("Audio play() rejected (prev-ended):", err));
      }
    }

    // clean up blob URL after play ends
    const src = curr.src;
    curr.onended = (() => {
      const old = curr.onended;
      return () => {
        try { if (src?.startsWith("blob:")) URL.revokeObjectURL(src); } catch {}
        if (old) old.call(curr);
      };
    })();
  };

  // ---------- Trigger helpers (legacy hashtags for USER only) ----------
  const normalizeForTrigger = (raw: string) =>
    raw
      .replace(/[`]/g, " ")
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/\s+/g, " ")
      .trim();

  type AutoTrigger =
    | { kind: "wikipedia"; q: string; n?: number; collection?: string; autoSummarize?: boolean }
    | { kind: "papers"; q: string; n?: number; autoSummarize?: boolean }
    | { kind: "bildungsplan"; q: string; n?: number; autoSummarize?: boolean };

  // Legacy hashtag parsing – kept for USER requests only (no !! support)
  const findHashtagTriggersInUserText = (raw: string): AutoTrigger[] => {
    const t = normalizeForTrigger(raw);

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
      if (q) triggers.push({ kind: "wikipedia", q, n, collection, autoSummarize: false });
    }

    const mP = t.match(rxPapers);
    if (mP) {
      const q = (mP[1] || "").trim();
      const n = mP[2] ? parseInt(mP[2], 10) : undefined;
      if (q) triggers.push({ kind: "papers", q, n, autoSummarize: false });
    }

    const mB = t.match(rxBP);
    if (mB) {
      const q = (mB[1] || "").trim();
      const n = mB[2] ? parseInt(mB[2], 10) : undefined;
      if (q) triggers.push({ kind: "bildungsplan", q, n, autoSummarize: false });
    }

    // DEBUG
    serverLog("hashtag.detect.done", { raw, triggers });

    return triggers;
  };

  // ---------- NEW: JSON-based trigger extraction (user & assistant) ----------

  // Findet nur TOP-LEVEL JSON-Objekte, deren Klammern *balanciert* sind.
  const extractCompletedJsonSearchBlocks = (s: string): string[] => {
    const blocks: string[] = [];
    let depth = 0, start = -1;
    let inString = false, quote: string | null = null, escape = false;

    for (let i = 0; i < s.length; i++) {
      const ch = s[i];

      if (inString) {
        if (escape) { escape = false; continue; }
        if (ch === "\\") { escape = true; continue; }
        if (ch === quote) { inString = false; quote = null; continue; }
        continue;
      }

      if (ch === '"' || ch === "'") { inString = true; quote = ch; continue; }
      if (ch === "{") {
        if (depth === 0) start = i;
        depth++;
      } else if (ch === "}") {
        if (depth > 0) depth--;
        if (depth === 0 && start !== -1) {
          const block = s.slice(start, i + 1);
          if (/^\s*{\s*./.test(block) && /}\s*$/.test(block)) {
            blocks.push(block);
            // DEBUG für jedes abgeschlossene Objekt
            serverLog("json.block.closed", { block });
          }
          start = -1;
        }
      }
    }
    return blocks;
  };

  const isValidSearchJson = (obj: any): boolean => {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
    const allowed = new Set(["wikipedia", "wikipedia_de", "wikipedia_en", "papers", "bildungsplan"]);
    const keys = Object.keys(obj);
    if (keys.length !== 1) return false;
    const key = keys[0];
    if (!allowed.has(key)) return false;

    const v = obj[key];
    if (typeof v === "string") return v.trim().length > 0;

    if (v && typeof v === "object") {
      const q = (v.q ?? v.query ?? v.text ?? "").toString().trim();
      if (!q) return false;
      if ("n" in v || "limit" in v || "top_n" in v) {
        const n = Number(v.n ?? v.limit ?? v.top_n);
        if (!Number.isFinite(n) || n <= 0) return false;
      }
      return true;
    }
    return false;
  };

  // JSON-Trigger Finder
  const findJsonTriggersInText = (raw: string): AutoTrigger[] => {
    // DEBUG: Start
    serverLog("json.detect.start", { sampleTail: raw.slice(-250) });

    const blocks = extractCompletedJsonSearchBlocks(raw);
    const all: AutoTrigger[] = [];

    for (const b of blocks) {
      let obj: any = null;
      try { obj = JSON.parse(b); } catch { obj = null; }
      if (!obj) {
        const normalized = b
          .replace(/([{,\s])'([^']+?)'\s*:/g, '$1"$2":')
          .replace(/:\s*'([^']*?)'/g, ':"$1"')
          .replace(/,(\s*[}\]])/g, "$1");
        try { obj = JSON.parse(normalized); } catch { obj = null; }
      }
      if (!obj || !isValidSearchJson(obj)) continue;
      all.push(...jsonObjToTriggers(obj));
    }

    // DEBUG: Done
    serverLog("json.detect.done", { triggers: all });

    return all;
  };

  // Lenient JSON parse (unused externally but kept)
  const tryParseJsonLenient = (raw: string): any | null => {
    try { return JSON.parse(raw); } catch {}
    let s = raw.trim();
    s = s.replace(/([{,\s])'([^']+?)'\s*:/g, '$1"$2":').replace(/:\s*'([^']*?)'/g, ':"$1"');
    s = s.replace(/,(\s*[}\]])/g, "$1");
    try { return JSON.parse(s); } catch { return null; }
  };

  const jsonObjToTriggers = (obj: any): AutoTrigger[] => {
    const triggers: AutoTrigger[] = [];
    if (!obj || typeof obj !== "object") return triggers;

    const normQ = (v: any) => {
      if (typeof v === "string") return v.trim();
      if (v && typeof v === "object") {
        return (v.q ?? v.query ?? v.text ?? "").toString().trim();
      }
      return "";
    };
    const normN = (v: any) => {
      if (v && typeof v === "object") {
        const n = v.n ?? v.limit ?? v.top_n;
        const nn = Number(n);
        return Number.isFinite(nn) && nn > 0 ? nn : undefined;
      }
      return undefined;
    };

    const keys = Object.keys(obj);
    for (const key of keys) {
      const k = key.toLowerCase();
      const val = obj[key];
      if (["wikipedia", "wikipedia_de", "wikipedia_en", "papers", "bildungsplan"].includes(k)) {
        const q = normQ(val);
        const n = normN(val);
        if (!q) continue;

        if (k === "wikipedia" || k === "wikipedia_de" || k === "wikipedia_en") {
          let collection =
            lang === "en" ? "English-ConcatX-Abstract" : "German-ConcatX-Abstract";
          if (k.endsWith("_de")) collection = "German-ConcatX-Abstract";
          if (k.endsWith("_en")) collection = "English-ConcatX-Abstract";
          triggers.push({ kind: "wikipedia", q, n, collection, autoSummarize: true });
        } else if (k === "papers") {
          triggers.push({ kind: "papers", q, n, autoSummarize: true });
        } else if (k === "bildungsplan") {
          triggers.push({ kind: "bildungsplan", q, n, autoSummarize: true });
        }
      }
    }
    return triggers;
  };

  // Build a summarization prompt (with i18n + safe encoding + local overrides)
  const buildAutoSummaryPrompt = (trigs: AutoTrigger[]) => {
    const topics = trigs.map(t => `${t.kind}: "${t.q}"`).join(", ");

    // 1) Optional per-language localStorage override (no UI needed):
    //    Put "{topics}" where you want the joined topics.
    //    Example (in DevTools console):
    //    localStorage.setItem('bud-e-summary-template-de', 'Bitte fasse ({topics}) ...');
    //    localStorage.setItem('bud-e-summary-template-en', 'Please summarize ({topics}) ...');
    const overrideKey =
      lang === "de" ? "bud-e-summary-template-de" : "bud-e-summary-template-en";
    const override = (typeof localStorage !== "undefined")
      ? localStorage.getItem(overrideKey)
      : null;
    if (override && override.includes("{topics}")) {
      return override.replaceAll("{topics}", topics);
    }

    // 2) Defaults (ASCII-safe via \u escapes to avoid mojibake on non-UTF-8 builds)
    if (lang === "de") {
      return (
  `Bitte fasse die oben angezeigten Suchergebnisse (${topics}) pr\u00E4gnant zusammen:
  - Nenne die Kernaussagen in klaren Stichpunkten.
  - Hebe ggf. Relevanz f\u00FCr Unterricht/Kontext hervor.
  - F\u00FCge am Ende 3\u20135 kurze Bulletpoints mit Quellen/URLs und falls vorhanden auch Setienangaben aus den gezeigten Ergebnissen an.
  Sei absolut faktengetreu und nutze nur die sichtbaren Ergebnisse als Grundlage.`
      );
    }

    // English default
    return (
  `Please summarize the search results shown above (${topics}) concisely:
  - Provide key takeaways in clear bullet points.
  - Highlight relevance to the user's context if applicable.
  - Add 3\u20135 short bullets with sources/URLs and if available also page numbers from the shown results. Be absolutely factual-
  Use only the visible results as your basis.`
    );
  };

  // ---------- Chat list actions ----------
  const handleRefreshAction = (groupIndex: number) => {
    if (!(groupIndex >= 0 && groupIndex < messages.length)) return;

    // Cancel any running stream
    abortRef.current?.abort();
    abortRef.current = null;
    setIsStreamComplete(true);

    // We want to re-run from this assistant turn’s *preceding user* turn (if present)
    let sliceStart = groupIndex;
    if (messages[groupIndex - 1]?.role === "user") {
      sliceStart = groupIndex - 1;
    }

    const prev = messages.slice(0, sliceStart) as Message[];

    // Extract the most recent user text to re-send
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
    setMessages(prev);
    safePersist(prev, currentChatSuffix);
    startStream(userText, prev);
  };

  const handleEditAction = (groupIndex: number) => {
    const message = messages[groupIndex];
    let contentToEdit = "";

    if (typeof message.content === "string") {
      contentToEdit = message.content;
    } else if (Array.isArray(message.content)) {
      if (typeof message.content[0] === "string") {
        contentToEdit = message.content.join("");
      } else {
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

  // helper – parse index from "streamN" or "manual_streamN"
  const indexFromSourceFunction = (sourceFunction: string): number => {
    const m = sourceFunction.match(/(?:^|_)stream(\d+)/);
    return m ? Math.max(0, Number(m[1]) - 1) : 0;
  };

  // send smart chunks in parallel
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

    // fire *all* chunks concurrently (queued in TTS pool)
    chunks.forEach((chunk, i) => {
      getTTS(chunk, groupIndex, `manual_stream${i + 1}`);
    });
  };

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
      speakMessageInSmartChunks(groupIndex, text);
      return;
    }

    const firstItem = audioFileDict[groupIndex][0];
    const prevText = firstItem?.audio?.__text ?? "";
    if (text !== String(prevText).trim()) {
      speakMessageInSmartChunks(groupIndex, text);
      return;
    }

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

  const handleUploadActionToMessages = (uploadedMessages: Message[]) => {
    const newMessages = uploadedMessages.map((msg) => [msg]).flat();
    setMessages(newMessages);
    safePersist(newMessages, currentChatSuffix);
    const textarea = document.querySelector("textarea");
    textarea?.focus();
  };

  const handleImagesUploaded = (newImages: any[]) => {
    setImages((prevImages) => [...prevImages, ...newImages]);
  };

  const handlePdfsUploaded = (newPdfs: PdfFile[]) => {
    setPdfs((prevPdfs) => [...prevPdfs, ...newPdfs]);
  };

  const handleImageChange = (images_: any[]) => {
    setImages(images_);
  };

  // ======= TTS CLEANING =======
  const cleanForTTS = (s: string) =>
    s
      .replace(/\*/g, "")
      .replace(
        /[\u{1F1E6}-\u{1F1FF}\u{1F300}-\u{1F5FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FAFF}\u2600-\u26FF\u2700-\u27BF\uFE0F\u200D]/gu,
        ""
      )
      .replace(/\s{2,}/g, " ");

  // ======= THINK TAG STREAM FILTER =======
  type ThinkState = { inThink: boolean; carry: string };
  const makeThinkFilter = () => {
    const CARRY_OPEN = 16;
    const CARRY_CLOSE = 16;
    const state: ThinkState = { inThink: false, carry: "" };

    const consume = (chunk: string): string => {
      let s = state.carry + chunk;
      let out = "";
      let i = 0;

      const lowerAt = (from: number) => s.slice(from).toLowerCase();

      while (i < s.length) {
        if (!state.inThink) {
          const L = lowerAt(i);
          const rel = L.indexOf("<think");
          if (rel === -1) {
            const keepTail = Math.max(0, s.length - CARRY_OPEN);
            out += s.slice(i, keepTail);
            state.carry = s.slice(keepTail);
            break;
          } else {
            const j = i + rel;
            out += s.slice(i, j);
            const end = s.indexOf(">", j);
            if (end === -1) {
              state.carry = s.slice(j);
              break;
            }
            state.inThink = true;
            i = end + 1;
          }
        } else {
          const L = lowerAt(i);
          const rel = L.indexOf("</think");
          if (rel === -1) {
            const keepTail = Math.max(0, s.length - CARRY_CLOSE);
            state.carry = s.slice(i >= s.length ? s.length : keepTail);
            break;
          } else {
            const j = i + rel;
            const end = s.indexOf(">", j);
            if (end === -1) {
              state.carry = s.slice(j);
              break;
            }
            state.inThink = false;
            i = end + 1;
          }
        }
      }
      return out;
    };

    const flush = (): string => {
      if (!state.inThink && state.carry) {
        const tail = state.carry;
        state.carry = "";
        return tail;
      }
      state.carry = "";
      return "";
    };

    return { consume, flush };
  };

  // ---- API helpers ----
  const fetchBildungsplan = async (query_: string, top_n: number) => {
    try {
      // DEBUG req
      await serverLog("api.fetch.bildungsplan.req", { query: query_, top_n });

      const response = await fetch("/api/bildungsplan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: query_,
          top_n,
          universalApiKey: settings.universalApiKey,
        }),
      });

      await serverLog("api.fetch.bildungsplan.rsp", {
        ok: response.ok,
        status: response.status,
      });

      if (!response.ok) {
        console.error("bildungsplan API HTTP", response.status, await response.text().catch(() => ""));
        return { results: [] as { text: string; score: number }[] };
      }

      const data = (await response.json()) as BildungsplanResponse | null;

      await serverLog("api.fetch.bildungsplan.parsed", {
        count: data?.results?.length ?? 0,
      });

      return data ?? { results: [] };
    } catch (error) {
      console.error("Error in bildungsplan API:", error);
      await serverLog("api.fetch.bildungsplan.error", { error: String(error) });
      return { results: [] };
    }
  };

  const fetchWikipedia = async (text: string, collection: string, n: number) => {
    try {
      // DEBUG req
      await serverLog("api.fetch.wikipedia.req", { text, collection, n });

      const response = await fetch("/api/wikipedia", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          collection,
          n,
          universalApiKey: settings.universalApiKey,
        }),
      });

      await serverLog("api.fetch.wikipedia.rsp", {
        ok: response.ok,
        status: response.status,
      });

      if (!response.ok) {
        console.error("wikipedia API HTTP", response.status, await response.text().catch(() => ""));
        return [] as WikipediaResult[];
      }

      const data = (await response.json()) as WikipediaResult[] | null;

      await serverLog("api.fetch.wikipedia.parsed", { count: data?.length ?? 0 });

      return data ?? [];
    } catch (error) {
      console.error("Error in wikipedia API:", error);
      await serverLog("api.fetch.wikipedia.error", { error: String(error) });
      return [] as WikipediaResult[];
    }
  };

  const fetchPapers = async (query_: string, limit: number) => {
    try {
      // DEBUG req
      await serverLog("api.fetch.papers.req", { query: query_, limit });

      const response = await fetch("/api/papers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: query_,
          limit,
          universalApiKey: settings.universalApiKey,
        }),
      });

      await serverLog("api.fetch.papers.rsp", {
        ok: response.ok,
        status: response.status,
      });

      if (!response.ok) {
        console.error("papers API HTTP", response.status, await response.text().catch(() => ""));
        return { payload: { items: [] as PapersItem[] } } as PapersResponse;
      }

      const data = (await response.json()) as PapersResponse | null;

      await serverLog("api.fetch.papers.parsed", {
        count: data?.payload?.items?.length ?? 0,
      });

      return data ?? { payload: { items: [] } };
    } catch (error) {
      console.error("Error in papers API:", error);
      await serverLog("api.fetch.papers.error", { error: String(error) });
      return { payload: { items: [] } } as PapersResponse;
    }
  };

  // ---------- PRIMARY: startStream ----------
  const startStream = async (transcript: string, prevMessages?: Message[]) => {
    // If we're editing a previous user message
    if (currentEditIndex !== undefined && currentEditIndex !== -1) {
      const updated = [...messages];
      updated[currentEditIndex] = { ...updated[currentEditIndex], content: query };
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

    // Cancel previous stream
    abortRef.current?.abort();
    abortRef.current = new AbortController();

    setIsStreamComplete(false);
    setResetTranscript((n) => n + 1);

    // Build outbound user content
    const userText = transcript && transcript.trim() !== "" ? transcript : query;
    let previousMessages = prevMessages || messages;

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

    // Clear composer state
    setImages([]);
    setPdfs([]);
    setMessages(newMessagesArr);
    safePersist(newMessagesArr, currentChatSuffix);
    setQuery("");
    resetComposerHeight();

    // DEBUG: Beginn des Flows
    serverLog("stream.begin", {
      userText,
      prevCount: previousMessages.length,
      images: images.length,
      pdfs: pdfs.length,
    });

    // ======= SHORT-CIRCUITS for USER input =======

    // (A) JSON triggers in USER message — with auto-summary
    const jsonUserTriggers = findJsonTriggersInText(userText);
    if (jsonUserTriggers.length) {
      serverLog("json.user.detect", { triggers: jsonUserTriggers });

      let accumulated: Message[] = [...newMessagesArr];
      let anyResults = false;
      const successTrigs: AutoTrigger[] = [];
      for (const trig of jsonUserTriggers) {
        if (trig.kind === "wikipedia") {
          serverLog("wikipedia.call", { q: trig.q, n: trig.n ?? 5, collection: trig.collection });
          const n = trig.n ?? 5;
          const collection =
            trig.collection ??
            (lang === "en" ? "English-ConcatX-Abstract" : "German-ConcatX-Abstract");
          const res = await fetchWikipedia(trig.q, collection, n);
          const out = (res || []).map((r: WikipediaResult, i: number) =>
            `**${chatIslandContent[lang].result} ${i + 1} ${chatIslandContent[lang].of} ${(res || []).length}**\n**${chatIslandContent[lang].wikipediaTitle}**: ${r.Title}\n**${chatIslandContent[lang].wikipediaURL}**: ${r.URL}\n**${chatIslandContent[lang].wikipediaContent}**: ${r.content}\n**${chatIslandContent[lang].wikipediaScore}**: ${r.score}`
          ).join("\n\n");
          serverLog("wikipedia.result", { length: out.length, empty: !out.trim() });
          if (out.trim()) { anyResults = true; successTrigs.push(trig); }
          accumulated = [...accumulated, { role: "assistant", content: out.trim() || (lang === "de" ? "Entschuldigung, die Suche hat keine Ergebnisse geliefert oder ist fehlgeschlagen." : "Sorry, the search returned no results or failed.") }];
          setMessages(accumulated); safePersist(accumulated, currentChatSuffix);
        } else if (trig.kind === "papers") {
          serverLog("papers.call", { q: trig.q, n: trig.n ?? 5 });
          const limit = trig.n ?? 5;
          const res = await fetchPapers(trig.q, limit);
          const items = res?.payload?.items || [];
          const out = items.map((it: PapersItem, i: number) => {
            const authors = it.authors?.join(", ") || "";
            const subjs = it.subjects?.join(", ") || "";
            const T = chatIslandContent[lang].papersTitle ?? "Title";
            const A = chatIslandContent[lang].papersAuthors ?? "Authors";
            const S = chatIslandContent[lang].papersSubjects ?? "Subjects";
            const AB = chatIslandContent[lang].papersAbstract ?? "Abstract";
            const doiLabel = "DOI";
            return `**${chatIslandContent[lang].result} ${i + 1} ${chatIslandContent[lang].of} ${items.length}**\n**${T}**: ${it.title}\n**${A}**: ${authors}\n**${S}**: ${subjs}\n**${doiLabel}**: ${it.doi}\n**${AB}**: ${it.abstract}`;
          }).join("\n\n");
          serverLog("papers.result", { length: out.length, empty: !out.trim() });
          if (out.trim()) { anyResults = true; successTrigs.push(trig); }
          accumulated = [...accumulated, { role: "assistant", content: out.trim() || (lang === "de" ? "Entschuldigung, die Suche hat keine Ergebnisse geliefert oder ist fehlgeschlagen." : "Sorry, the search returned no results or failed.") }];
          setMessages(accumulated); safePersist(accumulated, currentChatSuffix);
        } else if (trig.kind === "bildungsplan") {
          serverLog("bildungsplan.call", { q: trig.q, n: trig.n ?? 5 });
          const top_n = trig.n ?? 5;
          const res = await fetchBildungsplan(trig.q, top_n);
          const results = res?.results || [];
          const out = results.map((r, i) =>
            `**${chatIslandContent[lang].result} ${i + 1} ${chatIslandContent[lang].of} ${results.length}**\n${r.text}\n\n**Score**: ${r.score}`
          ).join("\n\n");
          serverLog("bildungsplan.result", { length: out.length, empty: !out.trim() });
          if (out.trim()) { anyResults = true; successTrigs.push(trig); }
          accumulated = [...accumulated, { role: "assistant", content: out.trim() || (lang === "de" ? "Entschuldigung, die Suche hat keine Ergebnisse geliefert oder ist fehlgeschlagen." : "Sorry, the search returned no results or failed.") }];
          setMessages(accumulated); safePersist(accumulated, currentChatSuffix);
        }
      }
      setIsStreamComplete(true);
      serverLog("triggers.summary.maybe", { anyResults, successCount: successTrigs.length });
      if (anyResults && successTrigs.length) {
        const summaryPrompt = buildAutoSummaryPrompt(successTrigs);
        startStream(summaryPrompt, accumulated);
      }
      return;
    }

    // (B) Legacy hashtags in USER message
    const hashUserTriggers = findHashtagTriggersInUserText(userText);
    if (hashUserTriggers.length) {
      serverLog("hashtag.user.detect", { triggers: hashUserTriggers });

      let accumulated: Message[] = [...newMessagesArr];
      for (const trig of hashUserTriggers) {
        if (trig.kind === "wikipedia") {
          serverLog("wikipedia.call", { q: trig.q, n: trig.n ?? 5, collection: trig.collection });
          const n = trig.n ?? 5;
          const collection =
            trig.collection ??
            (lang === "en" ? "English-ConcatX-Abstract" : "German-ConcatX-Abstract");
          const res = await fetchWikipedia(trig.q, collection, n);
          const out = (res || []).map((r: WikipediaResult, i: number) =>
            `**${chatIslandContent[lang].result} ${i + 1} ${chatIslandContent[lang].of} ${(res || []).length}**\n**${chatIslandContent[lang].wikipediaTitle}**: ${r.Title}\n**${chatIslandContent[lang].wikipediaURL}**: ${r.URL}\n**${chatIslandContent[lang].wikipediaContent}**: ${r.content}\n**${chatIslandContent[lang].wikipediaScore}**: ${r.score}`
          ).join("\n\n");
          serverLog("wikipedia.result", { length: out.length, empty: !out.trim() });
          accumulated = [...accumulated, { role: "assistant", content: out.trim() || (lang === "de" ? "Entschuldigung, die Suche hat keine Ergebnisse geliefert oder ist fehlgeschlagen." : "Sorry, the search returned no results or failed.") }];
        } else if (trig.kind === "papers") {
          serverLog("papers.call", { q: trig.q, n: trig.n ?? 5 });
          const limit = trig.n ?? 5;
          const res = await fetchPapers(trig.q, limit);
          const items = res?.payload?.items || [];
          const out = items.map((it: PapersItem, i: number) => {
            const authors = it.authors?.join(", ") || "";
            const subjs = it.subjects?.join(", ") || "";
            const T = chatIslandContent[lang].papersTitle ?? "Title";
            const A = chatIslandContent[lang].papersAuthors ?? "Authors";
            const S = chatIslandContent[lang].papersSubjects ?? "Subjects";
            const AB = chatIslandContent[lang].papersAbstract ?? "Abstract";
            const doiLabel = "DOI";
            return `**${chatIslandContent[lang].result} ${i + 1} ${chatIslandContent[lang].of} ${items.length}**\n**${T}**: ${it.title}\n**${A}**: ${authors}\n**${S}**: ${subjs}\n**${doiLabel}**: ${it.doi}\n**${AB}**: ${it.abstract}`;
          }).join("\n\n");
          serverLog("papers.result", { length: out.length, empty: !out.trim() });
          accumulated = [...accumulated, { role: "assistant", content: out.trim() || (lang === "de" ? "Entschuldigung, die Suche hat keine Ergebnisse geliefert oder ist fehlgeschlagen." : "Sorry, the search returned no results or failed.") }];
        } else if (trig.kind === "bildungsplan") {
          serverLog("bildungsplan.call", { q: trig.q, n: trig.n ?? 5 });
          const top_n = trig.n ?? 5;
          const res = await fetchBildungsplan(trig.q, top_n);
          const results = res?.results || [];
          const out = results.map((r, i) =>
            `**${chatIslandContent[lang].result} ${i + 1} ${chatIslandContent[lang].of} ${results.length}**\n${r.text}\n\n**Score**: ${r.score}`
          ).join("\n\n");
          serverLog("bildungsplan.result", { length: out.length, empty: !out.trim() });
          accumulated = [...accumulated, { role: "assistant", content: out.trim() || (lang === "de" ? "Entschuldigung, die Suche hat keine Ergebnisse geliefert oder ist fehlgeschlagen." : "Sorry, the search returned no results or failed.") }];
        }
      }
      setMessages(accumulated); safePersist(accumulated, currentChatSuffix);
      setIsStreamComplete(true);
      return;
    }

    // ======= Streaming path (LLM) =======
    let assistantDraftIndex = -1;
    const ongoingStream: string[] = [];
    let currentAudioIndex = 1;

    let assistantAccum = "";
    let gotAnyText = false;

    const seenTriggerKeys = new Set<string>();
    let endFinalized = false;
    let interruptedForTrigger = false;
    let pendingInstreamTriggers: AutoTrigger[] = [];

    const filterThink = makeThinkFilter();

    const ensureDraft = () => {
      if (assistantDraftIndex !== -1) return;
      setMessages((prev) => {
        assistantDraftIndex = prev.length;
        const next = [...prev, { role: "assistant", content: "" }];
        safePersist(next, currentChatSuffix);
        return next;
      });
    };

    const appendToAssistant = (txt: string) => {
      if (!txt) return;
      setMessages((prev) => {
        if (assistantDraftIndex === -1) {
          assistantDraftIndex = prev.length;
          const next = [...prev, { role: "assistant", content: txt }];
          safePersist(next, currentChatSuffix);
          return next;
        }
        const idx = assistantDraftIndex;
        const last = prev[idx];
        const prevText =
          typeof last.content === "string"
            ? last.content
            : Array.isArray(last.content)
              ? (last.content as string[]).join("")
              : "";
        const updated = { ...last, content: prevText + txt };
        const next = [...prev];
        next[idx] = updated;
        safePersistThrottled(next, currentChatSuffix);
        return next;
      });
    };

    const keyOf = (t: AutoTrigger) =>
      `${t.kind}|${t.q}|${t.kind === "wikipedia" ? (t as any).collection ?? "" : ""}|${t.n ?? ""}`;

    // Triggers ausführen und (nur bei Erfolg) später zusammenfassen
    const handleTriggers = async (trigs: AutoTrigger[]): Promise<{ anyResults: boolean; accumulated: Message[]; successTrigs: AutoTrigger[] }> => {
      if (!trigs.length) return { anyResults: false, accumulated: messagesRef.current, successTrigs: [] };

      // Dedupe
      const fresh: AutoTrigger[] = [];
      for (const t of trigs) {
        const k = keyOf(t);
        if (!seenTriggerKeys.has(k)) {
          seenTriggerKeys.add(k);
          fresh.push(t);
        }
      }
      if (!fresh.length) return { anyResults: false, accumulated: messagesRef.current, successTrigs: [] };

      await serverLog("triggers.begin", { requested: trigs, deduped: fresh });

      let accumulated: Message[] = messagesRef.current;
      let anyResults = false;
      const successTrigs: AutoTrigger[] = [];

      for (const trig of fresh) {
        if (trig.kind === "wikipedia") {
          await serverLog("wikipedia.call", { q: trig.q, n: trig.n ?? 5, collection: trig.collection });
          const n = trig.n ?? 5;
          const collection =
            trig.collection ??
            (lang === "en" ? "English-ConcatX-Abstract" : "German-ConcatX-Abstract");
          const res = await fetchWikipedia(trig.q, collection, n);
          const out = (res || []).map((r: WikipediaResult, i: number) =>
            `**${chatIslandContent[lang].result} ${i + 1} ${chatIslandContent[lang].of} ${(res || []).length}**\n**${chatIslandContent[lang].wikipediaTitle}**: ${r.Title}\n**${chatIslandContent[lang].wikipediaURL}**: ${r.URL}\n**${chatIslandContent[lang].wikipediaContent}**: ${r.content}\n**${chatIslandContent[lang].wikipediaScore}**: ${r.score}`
          ).join("\n\n");
          await serverLog("wikipedia.result", { length: out.length, empty: !out.trim() });
          if (out.trim()) { anyResults = true; successTrigs.push(trig); }
          accumulated = [...accumulated, { role: "assistant", content: out.trim() || (lang === "de" ? "Entschuldigung, die Suche hat keine Ergebnisse geliefert oder ist fehlgeschlagen." : "Sorry, the search returned no results or failed.") }];
          setMessages(accumulated); safePersist(accumulated, currentChatSuffix);
        } else if (trig.kind === "papers") {
          await serverLog("papers.call", { q: trig.q, n: trig.n ?? 5 });
          const limit = trig.n ?? 5;
          const res = await fetchPapers(trig.q, limit);
          const items = res?.payload?.items || [];
          const out = items.map((it: PapersItem, i: number) => {
            const authors = it.authors?.join(", ") || "";
            const subjs = it.subjects?.join(", ") || "";
            const T = chatIslandContent[lang].papersTitle ?? "Title";
            const A = chatIslandContent[lang].papersAuthors ?? "Authors";
            const S = chatIslandContent[lang].papersSubjects ?? "Subjects";
            const AB = chatIslandContent[lang].papersAbstract ?? "Abstract";
            const doiLabel = "DOI";
            return `**${chatIslandContent[lang].result} ${i + 1} ${chatIslandContent[lang].of} ${items.length}**\n**${T}**: ${it.title}\n**${A}**: ${authors}\n**${S}**: ${subjs}\n**${doiLabel}**: ${it.doi}\n**${AB}**: ${it.abstract}`;
          }).join("\n\n");
          await serverLog("papers.result", { length: out.length, empty: !out.trim() });
          if (out.trim()) { anyResults = true; successTrigs.push(trig); }
          accumulated = [...accumulated, { role: "assistant", content: out.trim() || (lang === "de" ? "Entschuldigung, die Suche hat keine Ergebnisse geliefert oder ist fehlgeschlagen." : "Sorry, the search returned no results or failed.") }];
          setMessages(accumulated); safePersist(accumulated, currentChatSuffix);
        } else if (trig.kind === "bildungsplan") {
          await serverLog("bildungsplan.call", { q: trig.q, n: trig.n ?? 5 });
          const top_n = trig.n ?? 5;
          const res = await fetchBildungsplan(trig.q, top_n);
          const results = res?.results || [];
          const out = results.map((r, i) =>
            `**${chatIslandContent[lang].result} ${i + 1} ${chatIslandContent[lang].of} ${results.length}**\n${r.text}\n\n**Score**: ${r.score}`
          ).join("\n\n");
          await serverLog("bildungsplan.result", { length: out.length, empty: !out.trim() });
          if (out.trim()) { anyResults = true; successTrigs.push(trig); }
          accumulated = [...accumulated, { role: "assistant", content: out.trim() || (lang === "de" ? "Entschuldigung, die Suche hat keine Ergebnisse geliefert oder ist fehlgeschlagen." : "Sorry, the search returned no results or failed.") }];
          setMessages(accumulated); safePersist(accumulated, currentChatSuffix);
        }
      }

      return { anyResults, accumulated, successTrigs };
    };

    // Zusammenfassung nach Triggern (nur bei Erfolg)
    const runTriggersAndMaybeSummarize = async (trigs: AutoTrigger[]) => {
      await serverLog("triggers.summary.maybe", { requested: trigs.length });
      const { anyResults, accumulated, successTrigs } = await handleTriggers(trigs);
      setIsStreamComplete(true);
      await serverLog("triggers.summary.result", { anyResults, successCount: successTrigs.length });
      if (anyResults && successTrigs.length) {
        const summaryPrompt = buildAutoSummaryPrompt(successTrigs);
        startStream(summaryPrompt, accumulated);
      }
    };

    const finalizeStream = async () => {
      if (endFinalized) return;
      endFinalized = true;

      setIsStreamComplete(true);
      setQuery("");

      const flushed = filterThink.flush();
      if (flushed) {
        appendToAssistant(flushed);
        ongoingStream.push(flushed);
        assistantAccum += flushed;
      }

      flushPersistThrottle();

      if (!gotAnyText) {
        setMessages((prev) => {
          if (!prev.length) return prev;
          const last = prev[assistantDraftIndex === -1 ? prev.length - 1 : assistantDraftIndex];
          const txt =
            typeof last?.content === "string"
              ? last.content
              : Array.isArray(last?.content)
                ? (last.content as string[]).join("")
                : "";
          if (last?.role === "assistant" && (!txt || txt.trim() === "")) {
            const next = [...prev];
            next.splice(assistantDraftIndex === -1 ? prev.length - 1 : assistantDraftIndex, 1);
            safePersist(next, currentChatSuffix);
            return next;
          }
          return prev;
        });
      } else {
        const remaining = ongoingStream.join("").trim();
        if (remaining) {
          const groupIndex = assistantDraftIndex === -1 ? messagesRef.current.length - 1 : assistantDraftIndex;
          getTTS(remaining, groupIndex, `stream${currentAudioIndex}`);
        }
      }

      // Nach regulärem Stream-Ende: Trigger (falls vorhanden) ausführen und ggf. zusammenfassen
      const finalTriggers = findJsonTriggersInText(assistantAccum);
      await serverLog("stream.finalize", { gotAnyText, assistantAccumLen: assistantAccum.length, triggersFound: finalTriggers.length });
      if (finalTriggers.length) {
        await serverLog("json.poststream.detect", { triggers: finalTriggers });
        await runTriggersAndMaybeSummarize(finalTriggers);
      }

      abortRef.current = null;
    };

    await serverLog("sse.request", {
      url: "/api/chat",
      model: settings.apiModel,
      apiUrl: settings.apiUrl,
      images: images.length,
      pdfs: pdfs.length,
    });

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
        await serverLog("sse.open", { ok: response.ok, status: response.status });
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
          rawChunk = JSON.parse(ev.data) as string;
        } catch {
          return;
        }
        if (!rawChunk) return;

        // DEBUG: chunklen
        serverLog("sse.chunk", { len: rawChunk.length });

        // Early end marker
        if (rawChunk === "[DONE]") {
          setTimeout(() => abortRef.current?.abort(), 0);
          finalizeStream();
          return;
        }

        // THINK filter
        const chunk = filterThink.consume(rawChunk);
        if (!chunk) return;

        gotAnyText = true;
        ensureDraft();

        assistantAccum += chunk;

        // TTS buffer
        ongoingStream.push(chunk);
        const combined = ongoingStream.join("");
        const re = /(?<!\d)[.!?]/g;
        let lastIdx = -1, m: RegExpExecArray | null;
        while ((m = re.exec(combined)) !== null) lastIdx = m.index;
        if (lastIdx !== -1) {
          const split = lastIdx + 1;
          const toSpeak = combined.slice(0, split).trim();
          const remaining = combined.slice(split);
          if (toSpeak) {
            const groupIndex = assistantDraftIndex === -1 ? newMessagesArr.length : assistantDraftIndex;
            getTTS(toSpeak, groupIndex, `stream${currentAudioIndex}`);
            currentAudioIndex++;
          }
          ongoingStream.length = 0;
          if (remaining.trim()) ongoingStream.push(remaining);
        }

        // Append to chat
        appendToAssistant(chunk);

        // -------- HARTER In-Stream-Stop bei vollständigem JSON-Trigger ----------
        if (chunk.includes("}")) {
          const maybeTriggers = findJsonTriggersInText(assistantAccum);
          const fresh: AutoTrigger[] = [];
          for (const t of maybeTriggers) {
            const k = keyOf(t);
            if (!seenTriggerKeys.has(k)) fresh.push(t);
          }
          if (fresh.length) {
            // DEBUG
            serverLog("json.instream.detect", {
              braceSeen: true,
              accLen: assistantAccum.length,
              triggers: fresh,
            });

            // Stop the stream *after* the closing brace is visible
            interruptedForTrigger = true;
            pendingInstreamTriggers = fresh;
            setTimeout(() => abortRef.current?.abort(), 0);
            return;
          }
        }
      },

      async onerror(err: FatalError) {
        await serverLog("sse.error", { message: String(err?.message || err) });
        setIsStreamComplete(true);
        ensureDraft();
        appendToAssistant(`\n\n${String(err?.message || err)}`);
        throw err;
      },

      onclose() {
        serverLog("sse.close", { interruptedForTrigger });
        // Wenn wir bewusst gestoppt haben, führe erst die Recherche aus und ggf. danach Zusammenfassung.
        if (interruptedForTrigger) {
          runTriggersAndMaybeSummarize(pendingInstreamTriggers);
          abortRef.current = null;
          return;
        }
        // Sonst normal finalisieren
        finalizeStream();
      },
    });
  };

  // ---------- 2) getTTS ----------
  const getTTS = async (
    text: string,
    groupIndex: number,
    sourceFunction: string,
  ) => {
    // Only return early if readAlways is false AND this is a *pure streaming* request (not manual)
    if (!readAlways && /^stream\d+$/.test(sourceFunction)) return;

    const ttsText = cleanForTTS(text);

    if (text === chatIslandContent[lang]["welcomeMessage"]) {
      const audioFile = text === chatIslandContent["de"]["welcomeMessage"]
        ? "./intro.mp3"
        : "./intro-en.mp3";
      const audio = new Audio(audioFile) as HTMLAudioElement & { __text?: string };
      audio.__text = text;

      const sourceFunctionIndex = indexFromSourceFunction(sourceFunction);

      setAudioFileDict((prev) => {
        const next = { ...prev };
        const group = { ...(next[groupIndex] || {}) };
        group[sourceFunctionIndex] = { audio, played: false };
        next[groupIndex] = group;
        return next;
      });

      // pause other groups
      const newStopList = stopList.slice();
      for (let i = 0; i < groupIndex; i++) {
        const g = audioFileDict[i];
        if (g) {
          (Object.values(g) as AudioItem[]).forEach((item) => {
            if (!item.audio.paused) {
              item.audio.pause();
              item.audio.currentTime = 0;
              if (!newStopList.includes(i)) newStopList.push(i);
            }
          });
        }
      }
      setStopList(newStopList);

      return;
    }

    // Queue the TTS fetch
    scheduleTTSJob(async () => {
      try {
        const response = await fetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: ttsText,
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

        const contentType = response.headers.get("Content-Type") || "audio/mpeg";
        const audioData = await response.arrayBuffer();
        const audioBlob = new Blob([audioData], { type: contentType });
        const audioUrl = URL.createObjectURL(audioBlob);
        const audio = new Audio(audioUrl) as HTMLAudioElement & { __text?: string };
        audio.__text = text;

        // ensure group slot
        const idx = indexFromSourceFunction(sourceFunction);
        setAudioFileDict((prev) => {
          const next = { ...prev };
          const group = { ...(next[groupIndex] || {}) };
          group[idx] = { audio, played: false };
          next[groupIndex] = group;
          return next;
        });

        // dynamic chaining
        wireNeighborChaining(groupIndex, idx);

        audio.addEventListener("ended", () => {
          setAudioFileDict((prev) => {
            const next = { ...prev };
            const group = { ...(next[groupIndex] || {}) };
            const item = { ...(group[idx] || {}) } as AudioItem;
            item.played = true;
            group[idx] = item;
            next[groupIndex] = group;
            return next;
          });
        });
      } catch (error) {
        console.error("Error fetching TTS:", error);
      }
    });
  };

  // ---------- General toggles ----------
  const toggleAutoScroll = (value: boolean) => {
    setAutoScroll(value);
  };

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
    setAudioFileDict({});
  };

  // ---------- Chat management ----------
  const startNewChat = () => {
    const maxValueInChatSuffix = Math.max(
      ...localStorageKeys.map((key) => Number(key.slice(10))),
    );
    const newChatSuffix = String(Number(maxValueInChatSuffix) + 1);

    const welcome = [
      { role: "assistant", content: [chatIslandContent[lang]["welcomeMessage"]] },
    ] as Message[];

    setMessages(welcome);
    setCurrentChatSuffix(newChatSuffix);
    safePersist(welcome, newChatSuffix);
    resetComposerHeight();
  };

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
        { role: "assistant", content: [chatIslandContent[lang]["welcomeMessage"]] },
      ] as Message[];
      setMessages(welcome);
      safePersist(welcome, "0");
    }
    stopAndResetAudio();
  };

  const deleteAllChats = () => {
    localStorage.clear();
    const welcome = [
      { role: "assistant", content: [chatIslandContent[lang]["welcomeMessage"]] },
    ] as Message[];
    setMessages(welcome);
    setLocalStorageKeys([]);
    setCurrentChatSuffix("0");
    safePersist(welcome, "0");
    stopAndResetAudio();
  };

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

  // ---------- RENDER ----------
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
            <path d="M440-200h80v-167l64 64 56-57-160-160-160 160 57 56 63-63v167ZM240-80q-33 0-56.5-23.5T160-160v-640q0-33 23.5-56.5T240-880h320l240 240v480q0 33-23.5 56.5T720-80H240Zm280-520v-200H240v640h480v-440H520ZM240-800v-200 200-640-640Z" />
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
          <div class="relative mt-4 mb-12 w-full">
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
