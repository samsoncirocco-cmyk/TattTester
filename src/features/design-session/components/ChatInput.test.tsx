// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ChatInput } from './ChatInput';

function renderInput(onSubmit = vi.fn()) {
  render(
    <ChatInput
      placeholder="Tell it straight…"
      ariaLabel="Test reply"
      onSubmit={onSubmit}
    />
  );
  return { onSubmit, input: screen.getByLabelText('Test reply') as HTMLTextAreaElement };
}

describe('ChatInput', () => {
  it('uses an auto-growing textarea and caps a very long paste without hiding send', () => {
    const { input } = renderInput();
    Object.defineProperty(input, 'scrollHeight', { configurable: true, value: 480 });

    fireEvent.change(input, { target: { value: 'A long pasted design brief.' } });

    expect(input.tagName).toBe('TEXTAREA');
    expect(input.style.height).toBe('256px');
    expect(input.className).toContain('overflow-y-auto');
  });

  it('sends on Enter and preserves Shift+Enter for a line break', () => {
    const { input, onSubmit } = renderInput();

    fireEvent.change(input, { target: { value: 'a moon over a lake' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledWith('a moon over a lake');

    fireEvent.change(input, { target: { value: 'line one' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
