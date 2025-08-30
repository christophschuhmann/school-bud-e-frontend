import { useRef, useState } from "preact/hooks";
import { IS_BROWSER } from "$fresh/runtime.ts";

type Variant = "floating" | "inline";

function ImageUploadButton({
  onImagesUploaded,
  variant = "floating",
}: {
  onImagesUploaded: (images: Image[]) => void;
  variant?: Variant;
}) {
  const [previewImages, setPreviewImages] = useState<any[]>([]);
  const [_imageFiles, _setImageFiles] = useState([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const onButtonClick = () => fileInputRef.current?.click();

  const handleImageUpload = (event: any) => {
    const files = Array.from(event.target.files);
    const newImages = files.map((file) => ({
      file, preview: URL.createObjectURL(file as Blob),
    }));
    setPreviewImages([ ...previewImages, ...newImages ]);

    const newPreviewImages: any[] = [];
    const promises = files.map((file) => new Promise<void>((resolve) => {
      const FR = new FileReader();
      FR.onload = (e) => {
        const data_url = e.target!.result as string;
        newPreviewImages.push({
          type: "image_url",
          image_url: { url: data_url, detail: "high" },
        });
        resolve();
      };
      FR.readAsDataURL(file as Blob);
    }));

    Promise.all(promises).then(() => onImagesUploaded([ ..._imageFiles as any, ...newPreviewImages ]));
  };

  const pos = variant === "floating"
    ? "md:absolute md:right-3 md:bottom-[6.7rem]"
    : "relative";

  return (
    <>
      <input type="file" ref={fileInputRef} onChange={handleImageUpload}
             accept="image/*" multiple class="hidden" />
      <button onClick={onButtonClick} disabled={!IS_BROWSER}
              class={`${pos} disabled:opacity-50 disabled:cursor-not-allowed rounded-md p-2 bg-gray-100 text-blue-600/50`}>
        {/* camera icon */}
        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"
             viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"
             stroke-linecap="round" stroke-linejoin="round"
             class="icon icon-tabler icons-tabler-outline icon-tabler-photo-up">
          <path stroke="none" d="M0 0h24v24H0z" fill="none"/>
          <path d="M15 8h.01" />
          <path d="M12.5 21h-6.5a3 3 0 0 1 -3 -3v-12a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v6.5" />
          <path d="M3 16l5 -5c.928 -.893 2.072 -.893 3 0l3.5 3.5" />
          <path d="M14 14l1 -1c.679 -.653 1.473 -.829 2.214 -.526" />
          <path d="M19 22v-6" />
          <path d="M22 19l-3 -3l-3 3" />
        </svg>
      </button>
    </>
  );
}

export default ImageUploadButton;
