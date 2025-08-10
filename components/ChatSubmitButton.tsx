// Button.tsx
import { JSX } from "preact";
import { IS_BROWSER } from "$fresh/runtime.ts";

export function ChatSubmitButton(props: JSX.HTMLAttributes<HTMLButtonElement>) {
  // Destructure `class` from props to apply alongside Tailwind classes
  const { class: className, ...buttonProps } = props;

  return (
    <button
      {...buttonProps}
      // Spread the rest of the buttonProps here
      disabled={!IS_BROWSER || props.disabled}
      class={`absolute right-3 bottom-3 disabled:opacity-50 disabled:cursor-not-allowed rounded-md p-2 ${
        props.disabled ? "bg-gray-100" : "bg-gray-400"
      } ${className}`} // Apply external class here
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        class={`icon icon-tabler icons-tabler-outline icon-tabler-arrow-narrow-up ${
          props.disabled ? "text-gray-400" : "text-white"
        }`}
      >
        <path stroke="none" d="M0 0h24v24H0z" fill="none" />
        <path d="M12 5v14" />
        <path d="M16 9l-4 -4l-4 4" />
      </svg>
    </button>
  );
}
