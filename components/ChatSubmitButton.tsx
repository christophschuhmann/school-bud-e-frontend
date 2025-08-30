// components/ChatSubmitButton.tsx
import { JSX } from "preact";
import { IS_BROWSER } from "$fresh/runtime.ts";

type Variant = "floating" | "inline";

export function ChatSubmitButton(
  { variant = "floating", class: className = "", disabled, ...rest }:
  JSX.HTMLAttributes<HTMLButtonElement> & { variant?: Variant }
) {
  const pos = variant === "floating"
    ? "md:absolute md:right-3 md:bottom-3"
    : "relative";
  const base = `disabled:opacity-50 disabled:cursor-not-allowed rounded-md p-2 ${
    disabled ? "bg-gray-100" : "bg-gray-400"
  }`;

  return (
    <button
      {...rest}
      disabled={!IS_BROWSER || !!disabled}
      class={`${pos} ${base} ${className}`}
    >
      <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"
        viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
        stroke-linecap="round" stroke-linejoin="round"
        class={`icon icon-tabler icons-tabler-outline icon-tabler-arrow-narrow-up ${
          disabled ? "text-gray-400" : "text-white"
        }`}>
        <path stroke="none" d="M0 0h24v24H0z" fill="none"/>
        <path d="M12 5v14"/><path d="M16 9l-4 -4l-4 4"/>
      </svg>
    </button>
  );
}
