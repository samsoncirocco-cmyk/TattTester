import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { describeGenerationError, useImageGeneration } from './useImageGeneration';
import { generateHighResDesign } from '../services/replicateService';

vi.mock('../services/replicateService', () => ({
  generateHighResDesign: vi.fn()
}));

vi.mock('@/services/imageProcessingService', () => ({
  optimizeForAR: vi.fn().mockResolvedValue({
    url: 'blob:ar-ready',
    size: 1024
  })
}));

const generateMock = vi.mocked(generateHighResDesign);

describe('describeGenerationError moderation', () => {
  it('shows the server message for a blocked prompt and does not offer a retry', () => {
    const details = describeGenerationError(Object.assign(
      new Error("We can't generate this design. It looks like it depicts or names a real person."),
      { code: 'PROMPT_BLOCKED' },
    ));
    expect(details.retryable).toBe(false);
    expect(details.message).toMatch(/can't generate/i);
    expect(details.guidance).toMatch(/nothing was generated/i);
  });

  it('shows the server message when the prompt is waiting on a person', () => {
    const details = describeGenerationError(Object.assign(
      new Error('This design needs a person to look at it before we can generate it.'),
      { code: 'PROMPT_IN_REVIEW' },
    ));
    expect(details.retryable).toBe(false);
    expect(details.title).toMatch(/person/i);
    expect(details.message).toMatch(/person to look/i);
  });
});

describe('useImageGeneration recovery', () => {
  beforeEach(() => {
    localStorage.clear();
    generateMock.mockReset();
  });

  it('coalesces rapid duplicate requests into one paid generation', async () => {
    let finish!: (value: { images: string[] }) => void;
    generateMock.mockImplementationOnce(() => new Promise(resolve => {
      finish = resolve;
    }));

    const { result } = renderHook(() => useImageGeneration({
      userInput: {
        subject: 'fine-line raven',
        style: 'fine-line',
        bodyPart: 'forearm'
      }
    }));

    let first!: Promise<unknown>;
    let second!: Promise<unknown>;
    await act(async () => {
      first = result.current.generateHighRes();
      second = result.current.generateHighRes();
      await Promise.resolve();
    });

    expect(generateMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      finish({ images: ['https://example.com/raven.png'] });
      await Promise.all([first, second]);
    });

    expect(generateMock).toHaveBeenCalledTimes(1);
  });

  it('does not queue a second paid intent while a render is active', async () => {
    let finish!: (value: { images: string[] }) => void;
    generateMock.mockImplementationOnce(() => new Promise(resolve => {
      finish = resolve;
    }));

    const { result } = renderHook(() => useImageGeneration({
      userInput: { subject: 'first design' }
    }));

    let first!: Promise<unknown>;
    let blocked!: unknown;
    await act(async () => {
      first = result.current.generateHighRes();
      blocked = await result.current.generateHighRes({
        userInputOverride: { subject: 'different design' }
      });
    });

    expect(blocked).toBeNull();
    expect(generateMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      finish({ images: ['https://example.com/first.png'] });
      await first;
    });
  });

  it('retries the exact failed intent even after the live form changes', async () => {
    generateMock
      .mockRejectedValueOnce(Object.assign(new Error('network disconnected'), {
        code: 'NETWORK_ERROR'
      }))
      .mockResolvedValueOnce({ images: ['https://example.com/recovered.png'] });

    const { result, rerender } = renderHook(
      ({ subject }) => useImageGeneration({
        userInput: {
          subject,
          style: 'blackwork',
          bodyPart: 'calf',
          negativePrompt: 'color'
        }
      }),
      { initialProps: { subject: 'blackwork wolf' } }
    );

    await act(async () => {
      await result.current.generateHighRes({ finalize: true });
    });

    expect(result.current.canRetry).toBe(true);
    rerender({ subject: 'completely different dragon' });

    await act(async () => {
      await result.current.retryLastFailed();
    });

    expect(generateMock).toHaveBeenCalledTimes(2);
    expect(generateMock.mock.calls[1][0]).toEqual({
      subject: 'blackwork wolf',
      style: 'blackwork',
      bodyPart: 'calf',
      negativePrompt: 'color'
    });
    expect(generateMock.mock.calls[1][1]).toMatchObject({ finalize: true });
  });

  it('turns rate limits into an actionable, retryable state', async () => {
    generateMock.mockRejectedValueOnce(Object.assign(new Error('Too many requests'), {
      code: 'RATE_LIMIT'
    }));

    const { result } = renderHook(() => useImageGeneration({
      userInput: { subject: 'ornamental moth' }
    }));

    await act(async () => {
      await result.current.generateHighRes();
    });

    expect(result.current.errorDetails).toMatchObject({
      title: 'The Studio is busy',
      retryable: true
    });
    expect(result.current.errorDetails?.guidance).toMatch(/retry the same request/i);
  });

  it('does not offer a blind retry for prompt policy failures', async () => {
    generateMock.mockRejectedValueOnce(new Error('Content policy safety rejection'));

    const { result } = renderHook(() => useImageGeneration({
      userInput: { subject: 'blocked prompt' }
    }));

    await act(async () => {
      await result.current.generateHighRes();
    });

    expect(result.current.errorDetails).toMatchObject({
      title: 'This prompt needs a small edit',
      retryable: false
    });
    expect(result.current.canRetry).toBe(false);
  });

  it('does not offer a dead retry while generation budget is paused', async () => {
    generateMock.mockRejectedValueOnce(new Error('Budget limit reached'));

    const { result } = renderHook(() => useImageGeneration({
      userInput: { subject: 'fine-line crane' }
    }));

    await act(async () => {
      await result.current.generateHighRes();
    });

    expect(result.current.errorDetails).toMatchObject({
      title: 'Generation is paused',
      retryable: false
    });
    expect(result.current.errorDetails?.guidance).toMatch(/retrying now will not help/i);
    expect(result.current.canRetry).toBe(false);
  });
});
