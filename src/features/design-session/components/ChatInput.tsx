'use client';

import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';

const MIN_HEIGHT_PX = 48;
const MAX_HEIGHT_PX = 256;

function resizeTextarea(textarea: HTMLTextAreaElement) {
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, MIN_HEIGHT_PX), MAX_HEIGHT_PX)}px`;
}

/**
 * Free-text reply line for the conversation. Space Mono body text — the
 * design system has no form-input pattern yet, so this stays minimal:
 * hairline border, pink focus, hard edges. 16px body: anything smaller
 * makes iOS Safari zoom the viewport on focus.
 *
 * `prefill` seeds the input with a correction opener (the notepad's
 * tap-to-fix, TAT-48) and focuses it — the nonce lets the same prefix be
 * applied twice in a row. The user finishes the sentence and sends through
 * the normal path.
 */
export function ChatInput({
  placeholder,
  ariaLabel,
  onSubmit,
  disabled = false,
  prefill,
}: {
  placeholder: string;
  ariaLabel: string;
  onSubmit: (text: string) => void;
  disabled?: boolean;
  prefill?: { text: string; nonce: number };
}) {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Adopt a new prefill during render (the React "adjust state when props
  // change" pattern — no cascading effect render); focus is the one true
  // side effect and stays in the effect below.
  const [adoptedNonce, setAdoptedNonce] = useState<number | undefined>();
  if (prefill && prefill.nonce !== adoptedNonce) {
    setAdoptedNonce(prefill.nonce);
    setValue(prefill.text);
  }

  useEffect(() => {
    if (prefill) inputRef.current?.focus();
  }, [prefill]);

  // `scrollHeight` reflects typed text, a pasted paragraph, and a tap-to-fix
  // prefill. Resize after each committed value so no input event is special.
  // The cap keeps a long paste from pushing the send button off a small screen;
  // beyond it the textarea scrolls normally.
  useLayoutEffect(() => {
    if (inputRef.current) resizeTextarea(inputRef.current);
  }, [value]);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const text = value.trim();
    if (!text || disabled) return;
    onSubmit(text);
    setValue('');
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Preserve the chat's Enter-to-send convention, while Shift+Enter gives
    // people an intentional line break in longer prompts.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      e.currentTarget.form?.requestSubmit();
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex gap-2">
      <textarea
        ref={inputRef}
        rows={1}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        aria-label={ariaLabel}
        disabled={disabled}
        className="flex-1 min-w-0 resize-none overflow-y-auto bg-transparent border hairline-white px-4 py-3 font-body text-[16px] leading-6 text-white placeholder:text-white/30 focus:outline-none focus:border-pink"
      />
      <button
        type="submit"
        disabled={disabled}
        className="press bg-pink text-black font-display text-[16px] tracking-[0.02em] uppercase px-5 py-3 disabled:opacity-40"
      >
        Send&nbsp;▸
      </button>
    </form>
  );
}
