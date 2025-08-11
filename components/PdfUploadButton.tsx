import { useRef, useState } from "preact/hooks";
import { IS_BROWSER } from "$fresh/runtime.ts";

export interface PdfFile {
  type: "pdf";
  name: string;
  mime_type: string;
  data: string; // base64
}

export function PdfUploadButton({
  onPdfsUploaded,
}: {
  onPdfsUploaded: (pdfs: PdfFile[]) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const clearInput = () => {
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const onButtonClick = () => {
    // ganz wichtig: Input vor Öffnen leeren, sonst feuert onChange bei gleicher Datei nicht
    clearInput();
    fileInputRef.current?.click();
  };

  // Hilfsfunktion: File -> base64 (DataURL sicher splitten)
  const fileToBase64 = (file: File) =>
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result || "");
        const commaIdx = dataUrl.indexOf(",");
        if (commaIdx === -1) return reject(new Error("Invalid DataURL"));
        resolve(dataUrl.slice(commaIdx + 1));
      };
      reader.onerror = () => reject(reader.error || new Error("FileReader error"));
      reader.onabort = () => reject(new Error("File read aborted"));
      reader.readAsDataURL(file);
    });

  const handlePdfUpload = async (event: Event) => {
    try {
      if (busy) return; // simple Reentrancy-Guard
      setBusy(true);

      const target = event.target as HTMLInputElement;
      const filesList = target?.files;
      if (!filesList || filesList.length === 0) {
        clearInput(); // Dialog abgebrochen o.ä.
        setBusy(false);
        return;
      }

      // Dedupliziere (Name|Size|LastModified); filtere alles Nicht-PDF
      const seen = new Set<string>();
      const files = Array.from(filesList).filter((f) => {
        const key = `${f.name}|${f.size}|${f.lastModified}`;
        const isPdf = f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf");
        if (!isPdf || seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      const uploadedPdfs: PdfFile[] = [];
      // SEQUENZIELL lesen -> stabilere Reihenfolge & weniger Memory-Peaks
      for (const file of files) {
        const base64 = await fileToBase64(file);
        uploadedPdfs.push({
          type: "pdf",
          name: file.name,
          mime_type: file.type || "application/pdf",
          data: base64,
        });
      }

      if (uploadedPdfs.length > 0) onPdfsUploaded(uploadedPdfs);
    } catch (err) {
      console.error("PDF upload failed:", err);
      // bewusst kein throw – UX-ruhig bleiben
    } finally {
      // immer leeren, damit dieselbe Datei erneut wählbar ist
      clearInput();
      setBusy(false);
    }
  };

  return (
    <>
      <input
        type="file"
        ref={fileInputRef}
        onChange={handlePdfUpload}
        accept="application/pdf"
        multiple
        class="hidden"
      />
      <button
        onClick={onButtonClick}
        disabled={!IS_BROWSER || busy}
        class="absolute right-3 bottom-[9.7rem] disabled:opacity-50 disabled:cursor-not-allowed rounded-md p-2 bg-gray-100 text-blue-600/50"
        title={busy ? "Lade PDFs..." : "PDF(s) auswählen"}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg" width="24" height="24"
          viewBox="0 0 24 24" fill="none" stroke="currentColor"
          stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"
          class="icon icon-tabler icon-tabler-file-type-pdf"
        >
          <path stroke="none" d="M0 0h24v24H0z" fill="none"/>
          <path d="M14 3v4a1 1 0 0 0 1 1h4" />
          <path d="M5 12v-7a2 2 0 0 1 2 -2h7l5 5v4" />
          <path d="M5 18h1.5a1.5 1.5 0 0 0 0 -3h-1.5v6" />
          <path d="M17 18h2" />
          <path d="M20 15h-3v6" />
          <path d="M11 15v6h1a2 2 0 0 0 2 -2v-2a2 2 0 0 0 -2 -2h-1z" />
        </svg>
      </button>
    </>
  );
}

export default PdfUploadButton;
