'use client';

import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';

/**
 * Free-text reply line for the conversation. Space Mono body text — the
 * design system has no form-input pattern yet, so this stays minimal:
 * hairline border, pink focus, hard edges. 16px body: anything smaller
 * makes iOS Safari zoom the viewport on focus.
 *
 * A textarea rather than a single-line input: a customer's brief is often a
 * full sentence or a pasted paragraph, and a one-line box scrolls it out of
 * view sideways while they are still composing it. The box grows with its
 * content (the `NeuralPromptEditor` scrollHeight pattern) up to a bounded
 * height, then scrolls vertically. Enter still sends — this is a chat reply
 * line, not a document editor — and Shift+Enter makes a newline.
 *
 * `prefill` seeds the input with a correction opener (the notepad's
 * tap-to-fix, TAT-48) and focuses it — the nonce lets the same prefix be
 * applied twice in a row. The user finishes the sentence and sends through
 * the normal path.
 */

/** One text row plus padding; the collapsed height, matching the old input. */
const MIN_HEIGHT_PX = 50;
/** ~6 text rows. Past this the box scrolls instead of pushing the page. */
const MAX_HEIGHT_PX = 160;

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

  // Fit the box to its content before paint: collapse to measure, then take
  // scrollHeight, so deleting text shrinks it rather than ratcheting up.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(MAX_HEIGHT_PX, Math.max(MIN_HEIGHT_PX, el.scrollHeight))}px`;
  }, [value]);

  const submit = () => {
    const text = value.trim();
    if (!text || disabled) return;
    onSubmit(text);
    setValue('');
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit();
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex items-end gap-2">
      <textarea
        ref={inputRef}
        rows={1}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        aria-label={ariaLabel}
        disabled={disabled}
        className="flex-1 min-w-0 resize-none overflow-y-auto bg-transparent border hairline-white px-4 py-3 font-body text-[16px] leading-relaxed text-white placeholder:text-white/30 focus:outline-none focus:border-pink"
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
