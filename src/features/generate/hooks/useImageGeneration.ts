import { useCallback, useEffect, useRef, useState } from 'react';
import { generateHighResDesign } from '../services/replicateService';
import { createAbortController } from '@/services/fetchWithAbort';
import { optimizeForAR } from '@/services/imageProcessingService';

// Types
export type ProgressStatus = 'idle' | 'running' | 'completed' | 'error';
export type GenerationMode = 'refine' | 'final';

export interface GenerationProgress {
  status: ProgressStatus;
  percent: number;
  etaSeconds: number | null;
  elapsedSeconds: number;
  phase: 'idle' | 'preparing' | 'rendering' | 'finishing' | 'completed' | 'error';
}

export interface UserInput {
  subject?: string;
  style?: string;
  bodyPart?: string;
  vibes?: string[];
  negativePrompt?: string;
  aiModel?: string;
  [key: string]: unknown;
}

export interface GenerationResult {
  images?: string[];
  metadata?: Record<string, unknown>;
  userInput?: UserInput | null;
  [key: string]: unknown;
}

export interface ARAsset {
  url: string;
  size: number;
  sourceId: string;
}

export interface SessionEntry {
  id: string;
  parentId: string | null;
  mode: GenerationMode;
  images: string[];
  metadata: Record<string, unknown>;
  userInput: UserInput | null;
  createdAt: string;
}

export interface GenerateHighResOptions {
  finalize?: boolean;
  parentId?: string | null;
  userInputOverride?: UserInput | null;
}

export interface UseImageGenerationOptions {
  userInput?: UserInput;
}

export interface UseImageGenerationReturn {
  result: GenerationResult | null;
  arAsset: ARAsset | null;
  isGenerating: boolean;
  error: string | null;
  errorDetails: GenerationErrorDetails | null;
  progress: GenerationProgress;
  queueLength: number;
  generateHighRes: (options?: GenerateHighResOptions) => Promise<GenerationResult | null>;
  retryLastFailed: () => Promise<GenerationResult | null>;
  canRetry: boolean;
  cancelCurrent: () => void;
}

export interface GenerationErrorDetails {
  title: string;
  message: string;
  guidance: string;
  retryable: boolean;
}

interface GenerationAttempt {
  finalize: boolean;
  parentId: string | null;
  userInput: UserInput;
}

interface QueueTask<T> {
  task: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

const GENERATION_STORAGE_KEY = 'tattester_generation_session';

function snapshotInput(input: UserInput): UserInput {
  try {
    return JSON.parse(JSON.stringify(input));
  } catch {
    return { ...input };
  }
}

function stableRequestKey(attempt: GenerationAttempt): string {
  const sortValue = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sortValue);
    if (value && typeof value === 'object') {
      return Object.keys(value)
        .sort()
        .reduce((sorted, key) => {
          sorted[key] = sortValue((value as Record<string, unknown>)[key]);
          return sorted;
        }, {} as Record<string, unknown>);
    }
    return value;
  };

  return JSON.stringify(sortValue(attempt));
}

export function describeGenerationError(error: unknown): GenerationErrorDetails {
  const errorRecord = error && typeof error === 'object'
    ? error as Record<string, unknown>
    : {};
  const code = String(errorRecord.code || '').toUpperCase();
  const message = String(
    error instanceof Error ? error.message : errorRecord.message || ''
  ).toLowerCase();

  if (code === 'PROMPT_BLOCKED' || code === 'PROMPT_IN_REVIEW') {
    const original = String(
      error instanceof Error ? error.message : errorRecord.message || ''
    );
    return {
      title: code === 'PROMPT_BLOCKED' ? "We can't generate this" : 'A person needs to look first',
      message: original || 'This design needs a change before we can draw it.',
      guidance: 'Nothing was generated. Edit the prompt and try a different idea.',
      retryable: false
    };
  }

  if (code.includes('AUTH') || message.includes('sign in') || message.includes('authentication')) {
    return {
      title: 'Sign in to keep creating',
      message: 'Your design details are still here.',
      guidance: 'Sign in, then return to the Studio and try again.',
      retryable: false
    };
  }

  if (
    message.includes('safety') ||
    message.includes('content policy') ||
    message.includes('invalid input') ||
    message.includes('moderation')
  ) {
    return {
      title: 'This prompt needs a small edit',
      message: 'Your prompt and settings are preserved.',
      guidance: 'Remove explicit or ambiguous wording, then generate again.',
      retryable: false
    };
  }

  if (
    code === 'PAYMENT_REQUIRED' ||
    message.includes('budget limit') ||
    message.includes('insufficient credit') ||
    message.includes('payment required') ||
    message.includes('not configured') ||
    message.includes('configuration')
  ) {
    return {
      title: 'Generation is paused',
      message: 'Your prompt and settings are preserved.',
      guidance: 'Retrying now will not help. Come back later and your design request will still be here.',
      retryable: false
    };
  }

  if (code === 'RATE_LIMIT' || message.includes('rate limit') || message.includes('too many requests')) {
    return {
      title: 'The Studio is busy',
      message: 'Your exact design request is kept ready.',
      guidance: 'Wait a moment, then retry the same request.',
      retryable: true
    };
  }

  if (
    code === 'NETWORK_ERROR' ||
    code === 'TIMEOUT' ||
    message.includes('network') ||
    message.includes('timed out') ||
    message.includes('timeout')
  ) {
    return {
      title: 'Connection interrupted',
      message: 'Your prompt and settings are safe.',
      guidance: 'Check your connection, then retry the same request.',
      retryable: true
    };
  }

  return {
    title: 'The render did not finish',
    message: 'Your prompt and settings are safe.',
    guidance: 'Retry the same request. If it happens again, wait a minute before trying once more.',
    retryable: true
  };
}

function safeStorageGet<T>(key: string, fallback: T): T {
  try {
    const stored = localStorage.getItem(key);
    return stored ? JSON.parse(stored) : fallback;
  } catch (error) {
    console.warn('[ImageGeneration] Failed to read storage:', error);
    return fallback;
  }
}

function safeStorageSet(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (error) {
    console.warn('[ImageGeneration] Failed to write storage:', error);
    return false;
  }
}

function createId(prefix: string = 'gen'): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}

function buildSessionEntry(
  result: GenerationResult,
  mode: GenerationMode,
  parentId: string | null
): SessionEntry {
  return {
    id: createId(mode),
    parentId: parentId || null,
    mode,
    images: result.images || [],
    metadata: result.metadata || {},
    userInput: result.userInput || null,
    createdAt: new Date().toISOString()
  };
}

export function useImageGeneration(
  { userInput }: UseImageGenerationOptions = {}
): UseImageGenerationReturn {
  const [result, setResult] = useState<GenerationResult | null>(null);
  const [arAsset, setArAsset] = useState<ARAsset | null>(null);
  const [isGenerating, setIsGenerating] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [errorDetails, setErrorDetails] = useState<GenerationErrorDetails | null>(null);
  const [canRetry, setCanRetry] = useState<boolean>(false);
  const [queueLength, setQueueLength] = useState<number>(0);
  const [progress, setProgress] = useState<GenerationProgress>({
    status: 'idle',
    percent: 0,
    etaSeconds: null,
    elapsedSeconds: 0,
    phase: 'idle'
  });

  const queueRef = useRef<QueueTask<GenerationResult | null>[]>([]);
  const processingRef = useRef<boolean>(false);
  const abortRef = useRef<AbortController | null>(null);
  const progressTimerRef = useRef<NodeJS.Timeout | null>(null);
  const pendingRequestsRef = useRef<Map<string, Promise<GenerationResult | null>>>(new Map());
  const lastFailedAttemptRef = useRef<GenerationAttempt | null>(null);

  const storeResult = useCallback((entry: SessionEntry) => {
    const existing = safeStorageGet<SessionEntry[]>(GENERATION_STORAGE_KEY, []);
    const updated = [...existing, entry].slice(-50);
    safeStorageSet(GENERATION_STORAGE_KEY, updated);
  }, []);

  const startProgressTimer = useCallback((expectedSeconds: number) => {
    const startTime = Date.now();
    setProgress({
      status: 'running',
      percent: 0,
      etaSeconds: expectedSeconds,
      elapsedSeconds: 0,
      phase: 'preparing'
    });

    if (progressTimerRef.current) {
      clearInterval(progressTimerRef.current);
    }

    progressTimerRef.current = setInterval(() => {
      const elapsed = (Date.now() - startTime) / 1000;
      const remaining = Math.max(0, expectedSeconds - elapsed);
      const percent = Math.min(0.95, elapsed / expectedSeconds);
      setProgress({
        status: 'running',
        percent,
        etaSeconds: remaining > 0 ? Math.ceil(remaining) : null,
        elapsedSeconds: Math.floor(elapsed),
        phase: elapsed < 3
          ? 'preparing'
          : elapsed < expectedSeconds * 0.8
            ? 'rendering'
            : 'finishing'
      });
    }, 1000);
  }, []);

  const stopProgressTimer = useCallback((status: ProgressStatus = 'idle') => {
    if (progressTimerRef.current) {
      clearInterval(progressTimerRef.current);
      progressTimerRef.current = null;
    }
    setProgress(prev => ({
      status,
      percent: status === 'completed' ? 1 : 0,
      etaSeconds: status === 'completed' ? 0 : null,
      elapsedSeconds: status === 'idle' ? 0 : prev.elapsedSeconds,
      phase: status === 'completed' ? 'completed' : status === 'error' ? 'error' : 'idle'
    }));
  }, []);

  const processQueue = useCallback(async () => {
    if (processingRef.current) return;
    const next = queueRef.current.shift();
    if (!next) {
      setQueueLength(0);
      return;
    }

    processingRef.current = true;
    setQueueLength(queueRef.current.length);

    try {
      const response = await next.task();
      next.resolve(response);
    } catch (err) {
      next.reject(err);
    } finally {
      processingRef.current = false;
      processQueue();
    }
  }, []);

  const enqueue = useCallback((
    task: () => Promise<GenerationResult | null>
  ): Promise<GenerationResult | null> => {
    return new Promise((resolve, reject) => {
      queueRef.current.push({ task, resolve, reject });
      setQueueLength(queueRef.current.length);
      processQueue();
    });
  }, [processQueue]);

  const cancelCurrent = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
    }
  }, []);

  const generateHighRes = useCallback(async (
    options: GenerateHighResOptions = {}
  ): Promise<GenerationResult | null> => {
    const { finalize = false, parentId = null, userInputOverride = null } = options;
    const resolvedInput = userInputOverride || userInput;
    if (!resolvedInput || !resolvedInput.subject?.trim()) {
      setError('Please provide a prompt before generating.');
      setErrorDetails({
        title: 'Describe your tattoo first',
        message: 'Add the main subject you want to create.',
        guidance: 'Your style and placement settings will stay selected.',
        retryable: false
      });
      setCanRetry(false);
      return null;
    }

    const attempt: GenerationAttempt = {
      finalize,
      parentId,
      userInput: snapshotInput(resolvedInput)
    };
    const requestKey = stableRequestKey(attempt);
    const pendingRequest = pendingRequestsRef.current.get(requestKey);
    if (pendingRequest) {
      return pendingRequest;
    }
    // A second, different request fired before React has painted the disabled
    // controls should not become another paid render. The customer can submit
    // the new intent once the current render settles.
    if (pendingRequestsRef.current.size > 0) {
      return null;
    }

    const request = enqueue(async () => {
      if (abortRef.current) {
        abortRef.current.abort();
      }

      const controller = createAbortController();
      abortRef.current = controller;

      setIsGenerating(true);
      setError(null);
      setErrorDetails(null);
      setCanRetry(false);
      startProgressTimer(finalize ? 28 : 20);

      try {
        const response = await generateHighResDesign(attempt.userInput, {
          finalize,
          signal: controller.signal
        }) as GenerationResult;
        setResult(response);
        lastFailedAttemptRef.current = null;
        stopProgressTimer('completed');

        const entry = buildSessionEntry(response, finalize ? 'final' : 'refine', parentId);
        storeResult(entry);

        if (response.images?.length) {
          optimizeForAR(response.images[0])
            .then((asset: { url: string; size: number }) => {
              setArAsset({
                url: asset.url,
                size: asset.size,
                sourceId: entry.id
              });
            })
            .catch((assetError: Error) => {
              console.warn('[ImageGeneration] AR optimization failed:', assetError);
            });
        }

        return response;
      } catch (err: unknown) {
        const errorRecord = err && typeof err === 'object'
          ? err as Record<string, unknown>
          : {};
        const wasCancelled = controller.signal.aborted ||
          errorRecord.code === 'ABORTED' ||
          /cancelled|canceled/i.test(String(errorRecord.message || ''));
        if (!wasCancelled) {
          const details = describeGenerationError(err);
          lastFailedAttemptRef.current = attempt;
          setError(details.message);
          setErrorDetails(details);
          setCanRetry(details.retryable);
        }
        stopProgressTimer(wasCancelled ? 'idle' : 'error');
        return null;
      } finally {
        setIsGenerating(false);
        abortRef.current = null;
      }
    });

    pendingRequestsRef.current.set(requestKey, request);
    request.finally(() => {
      if (pendingRequestsRef.current.get(requestKey) === request) {
        pendingRequestsRef.current.delete(requestKey);
      }
    });
    return request;
  }, [enqueue, startProgressTimer, stopProgressTimer, storeResult, userInput]);

  const retryLastFailed = useCallback((): Promise<GenerationResult | null> => {
    const attempt = lastFailedAttemptRef.current;
    if (!attempt || !canRetry) {
      return Promise.resolve(null);
    }
    return generateHighRes({
      finalize: attempt.finalize,
      parentId: attempt.parentId,
      userInputOverride: snapshotInput(attempt.userInput)
    });
  }, [canRetry, generateHighRes]);

  useEffect(() => {
    return () => {
      cancelCurrent();
      stopProgressTimer('idle');
    };
  }, [cancelCurrent, stopProgressTimer]);

  return {
    result,
    arAsset,
    isGenerating,
    error,
    errorDetails,
    progress,
    queueLength,
    generateHighRes,
    retryLastFailed,
    canRetry,
    cancelCurrent
  };
}
