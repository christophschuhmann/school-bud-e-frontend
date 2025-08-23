import { useEffect, useState } from "preact/hooks";
import { chatTemplateContent } from "../internalization/content.ts";

function downloadAudioFiles(
  items: { [key: string]: { audio: HTMLAudioElement } },
) {
  const timestamp = new Date().getTime();
  const nicelyFormattedTimestamp = new Date(timestamp).toISOString().slice(0, 19)
    .replace(/[-:]/g, "-");

  // If there's only one item, download it directly
  if (Object.keys(items).length === 1) {
    const singleAudio = Object.values(items)[0].audio;
    fetch(singleAudio.src)
      .then(response => response.blob())
      .then(blob => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `audio-${nicelyFormattedTimestamp}.mp3`;
        a.click();
        URL.revokeObjectURL(url);
      });
    return;
  }

  // For multiple items, download all MP3s first
  const mp3Promises = Object.values(items).map(item =>
    fetch(item.audio.src)
      .then(response => response.blob())
  );

  Promise.all(mp3Promises)
    .then(blobs => {
      // Combine all MP3 blobs into a single blob
      const combinedBlob = new Blob(blobs, { type: 'audio/mp3' });

      // Create download link for combined file
      const url = URL.createObjectURL(combinedBlob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `audio-${nicelyFormattedTimestamp}.mp3`;
      a.click();
      URL.revokeObjectURL(url);
    });
}

function convertDoiToUrl(doi: string): string {
  // Remove 'DOI: ' if present and handle null DOIs
  const cleanDoi = doi.replace(/^DOI:\s*/, '');
  return cleanDoi === 'null' ? '#' : `https://doi.org/${cleanDoi}`;
}

function renderTextWithLinksAndBold(text: string) {
  // Updated regex to catch DOIs in the format "DOI: 10.1234/xxx" or just "10.1234/xxx"
  const parts = text.split(/((?:\*\*.*?\*\*)|(?:https?:\/\/[^\s]+)|(?:www\.[^\s]+)|(?:DOI:\s*(?:null|[\d.]+\/[^\s]+))|(?:(?<![\w/])\b10\.\d+\/[^\s]+))/g);

  return parts.map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    } else if (part.startsWith('DOI:') || part.match(/^10\.\d+\//)) {
      return (
        <a
          key={index}
          href={convertDoiToUrl(part)}
          target="_blank"
          rel="noopener noreferrer"
          class="text-blue-600 hover:text-blue-800 underline"
        >
          {part}
        </a>
      );
    } else if (part.startsWith('http://') || part.startsWith('https://') || part.startsWith('www.')) {
      const url = part.startsWith('www.') ? `https://${part}` : part;
      return (
        <a
          key={index}
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          class="text-blue-600 hover:text-blue-800 underline"
        >
          {part}
        </a>
      );
    }
    return <span key={index}>{part}</span>;
  });
}
// components/ChatTemplate.tsx
// Hook-freie Variante mit fixierter Toolbar über dem Chatverlauf (nicht mitscrollend)

type AnyMsg = any;
type AnyImg = any;
type AnyPdf = any;
type AnyAudio = any;

export default function ChatTemplate(props: {
  lang: string;
  parentImages: AnyImg[];
  parentPdfs: AnyPdf[];
  messages: AnyMsg[];
  isComplete: boolean;
  readAlways: boolean;
  autoScroll: boolean;
  currentEditIndex: number;
  audioFileDict: AnyAudio;
  onToggleAutoScrollAction: () => void;
  onToggleReadAlwaysAction: () => void;
  onSpeakAtGroupIndexAction: (groupIndex: number) => void;
  onRefreshAction: (groupIndex: number) => void;
  onEditAction: (groupIndex: number) => void;
  onUploadActionToMessages: (uploadedMessages: AnyMsg[]) => void;
  onImageChange: (images: AnyImg[]) => void;
  onPdfChange: (pdfs: AnyPdf[]) => void;
  onTrashAction: () => void;
}) {
  const {
    lang,
    parentImages,
    parentPdfs,
    messages,
    readAlways,
    autoScroll,
    onToggleAutoScrollAction,
    onToggleReadAlwaysAction,
    onImageChange,
    onPdfChange,
  } = props;

  const deleteImage = (indexToDelete: number) => {
    const newImages = parentImages.filter((_: AnyImg, i: number) => i !== indexToDelete);
    onImageChange(newImages);
  };
  const deletePdf = (indexToDelete: number) => {
    const newPdfs = parentPdfs.filter((_: AnyPdf, i: number) => i !== indexToDelete);
    onPdfChange(newPdfs);
  };

  const renderContentPart = (content: any, idx: number) => {
    if (content?.type === "text") {
      return <span key={idx}>{renderTextWithLinksAndBold(content.text)}</span>;
    }
    if (content?.type === "image_url") {
      // Bilder im Chatverlauf begrenzen
      return (
        <img
          key={idx}
          src={content.image_url.url}
          alt="User uploaded image"
          class="max-w-[300px] w-full h-auto rounded-lg shadow-sm"
        />
      );
    }
    if (content?.type === "pdf") {
      return (
        <div key={idx} class="flex items-center gap-2 p-2 bg-gray-200 rounded-md">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"
            viewBox="0 0 24 24" fill="none" stroke="currentColor"
            stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
            class="text-red-700">
            <path stroke="none" d="M0 0h24v24H0z" fill="none"/>
            <path d="M14 3v4a1 1 0 0 0 1 1h4" />
            <path d="M5 12v-7a2 2 0 0 1 2 -2h7l5 5v4" />
            <path d="M5 18h1.5a1.5 1.5 0 0 0 0 -3h-1.5v6" />
            <path d="M17 18h2" />
            <path d="M20 15h-3v6" />
            <path d="M11 15v6h1a2 2 0 0 0 2 -2v-2a2 2 0 0 0 -2 -2h-1z" />
          </svg>
          <span class="font-mono text-sm">{content.name}</span>
        </div>
      );
    }
    if (typeof content === "string") {
      return <span key={idx}>{renderTextWithLinksAndBold(content)}</span>;
    }
    return null;
  };

  return (
    <div class="relative">
      {/* ==== FIXIERTE TOOLBAR (schwebt über dem Chat, scrollt nicht mit) ==== */}
      <div
        class="
          absolute -top-12 right-0 z-20
          flex items-center gap-2
        "
      >
        <button
          type="button"
          onClick={onToggleReadAlwaysAction}
          class={`px-3 py-1 rounded text-sm border transition
            ${readAlways ? "bg-blue-600 text-white border-blue-600" : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50"}`}
          title={chatTemplateContent[lang]?.readOutText ?? "Vorlesen"}
        >
          {readAlways ? (chatTemplateContent[lang]?.silent ?? "Stumm")
                      : (chatTemplateContent[lang]?.readOutText ?? "Vorlesen")}
        </button>

        <button
          type="button"
          onClick={onToggleAutoScrollAction}
          class={`px-3 py-1 rounded text-sm border transition
            ${autoScroll ? "bg-green-600 text-white border-green-600" : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50"}`}
          title={autoScroll
            ? (chatTemplateContent[lang]?.autoScrollOn ?? "Automatisch scrollen: AN")
            : (chatTemplateContent[lang]?.autoScrollOff ?? "Automatisch scrollen: AUS")}
        >
          {autoScroll
            ? (chatTemplateContent[lang]?.autoScrollOn ?? "Automatisch scrollen")
            : (chatTemplateContent[lang]?.autoScrollOff ?? "Manuell scrollen")}
        </button>
      </div>
      {/* ==== /FIXIERTE TOOLBAR ==== */}

      <div
        class={messages?.length === 0
          ? `bg-transparent`
          : `chat-history flex flex-col space-y-4 p-4 mx-auto rounded-lg shadow bg-white/75 max-h-[60vh] overflow-y-auto`}
      >
        {messages?.map((item: AnyMsg, groupIndex: number) => (
          <div key={groupIndex} class={`message-group flex flex-col ${item.role === "user" ? "items-end" : "items-start"}`}>
            <div class={`message mt-1 whitespace-pre-wrap [overflow-wrap:anywhere] ${item.role === "user" ? "bg-blue-100 sm:ml-20 md:ml-40" : "bg-gray-100 sm:mr-20 md:mr-40"} p-3 rounded-lg ${item.role === "user" ? "rounded-tr-none" : "rounded-tl-none"} shadow`}>
              {typeof item.content === "string"
                ? <span>{renderTextWithLinksAndBold(item.content)}</span>
                : (
                  <div class="flex flex-col gap-2">
                    {(item.content as any[]).map((content, contentIndex) =>
                      renderContentPart(content, contentIndex)
                    )}
                  </div>
                )}
            </div>
          </div>
        ))}

        {(parentImages?.length > 0 || parentPdfs?.length > 0) && (
          <div class="w-full flex justify-center">
            <div class="p-2 flex flex-wrap max-w-xs gap-4">
              {parentImages.map((image: AnyImg, index: number) => (
                <div class="relative group" key={`img-${index}`}>
                  <img
                    src={image.image_url.url}
                    alt={`Thumbnail ${index + 1}`}
                    class="w-32 h-32 object-cover rounded-lg shadow-xl bg-white/50"
                  />
                  <button
                    onClick={() => deleteImage(index)}
                    class="absolute top-1 right-1 bg-red-500 text-white rounded-full p-1 opacity-0 group-hover:opacity-100 transition-opacity"
                    title="Entfernen"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"
                      viewBox="0 0 24 24" fill="none" stroke="currentColor">
                      <path d="M18 6l-12 12"/><path d="M6 6l12 12"/>
                    </svg>
                  </button>
                </div>
              ))}
              {parentPdfs.map((pdf: AnyPdf, index: number) => (
                <div key={`pdf-${index}`} class="relative group w-32 h-32 flex flex-col items-center justify-center bg-gray-200 rounded-lg shadow-xl p-2 text-center">
                  <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"
                    viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    class="text-red-700 mb-2">
                    <path stroke="none" d="M0 0h24v24H0z" fill="none"/>
                    <path d="M14 3v4a1 1 0 0 0 1 1h4" />
                    <path d="M5 12v-7a2 2 0 0 1 2 -2h7l5 5v4" />
                    <path d="M5 18h1.5a1.5 1.5 0 0 0 0 -3h-1.5v6" />
                    <path d="M17 18h2" />
                    <path d="M20 15h-3v6" />
                    <path d="M11 15v6h1a2 2 0 0 0 2 -2v-2a2 2 0 0 0 -2 -2h-1z" />
                  </svg>
                  <span class="text-xs font-mono break-all overflow-hidden">{pdf.name}</span>
                  <button
                    onClick={() => deletePdf(index)}
                    class="absolute top-1 right-1 bg-red-500 text-white rounded-full p-1 opacity-0 group-hover:opacity-100 transition-opacity"
                    title="Entfernen"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"
                      viewBox="0 0 24 24" fill="none" stroke="currentColor">
                      <path d="M18 6l-12 12"/><path d="M6 6l12 12"/>
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

