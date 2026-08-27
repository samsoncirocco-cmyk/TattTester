/**
 * The guardrails, armed.
 *
 * Two modules landed on main built, tested and called by nothing: the prompt
 * contract (does the rendered prompt still say what the state says?) and the
 * render guard (are the pixels flash art, or a photograph of somebody's
 * skin?). "Merged" is not "armed", and neither could refuse or even notice a
 * bad render while their call sites lived in a file another workstream owned.
 *
 * This file measures the wiring — not the modules, which have their own
 * tests. It asks the three questions a call site has to get right:
 *
 *   1. Does a contradiction on a blocking field actually stop the money?
 *   2. Does a CORRECT render still go through? This is the one that matters.
 *      Term-level matching cannot tell which clause a word belongs to, and
 *      the fixed presentation lead opens every prompt with "a flat scan of
 *      the artwork alone" — so a state excluding 'flat cel-shaded outlines',
 *      rendered perfectly as "Avoid: flat cel-shaded outlines.", reports a
 *      contradiction on "flat". Had exclusions been in the blocking set, that
 *      customer's re-cut would throw. #388.
 *   3. Do the pixels get measured when we hold them, and is the gap reported
 *      when we do not?
 *
 * Module boundaries are mocked exactly as in ./astronautSession.test.ts — no
 * live provider call, no network, no image codec.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { critique } from '../index';
import { memorySessionStore, clearMemorySessions } from '../internal/store';
import type { StoredSession } from '../internal/store';
import { generate } from '../../generation';
import {
  copyImageToPath,
  recoverImageAtPath,
  uploadImageToPath,
} from '@/services/storage/imageStorageService';
import { recordSpend } from '@/lib/budget-tracker';
import { guardRenderBytes } from '@/lib/renderGuard';
import { renderStatePrompt } from '../internal/designState';
import type { Variation } from '../types';

vi.mock('../../intake', () => ({ extractIntake: vi.fn() }));
vi.mock('../../council', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  enhanceStructured: vi.fn(),
  enhanceRound: vi.fn(),
}));
vi.mock('../../generation', () => ({ generate: vi.fn(), routeGeneration: vi.fn() }));
vi.mock('@/lib/firebase-admin', () => ({ ensureAdminApp: vi.fn(() => false) }));
vi.mock('@/services/storage/imageStorageService', () => ({
  recoverImageAtPath: vi.fn(),
  copyImageToPath: vi.fn(),
  uploadImageToPath: vi.fn(),
}));
vi.mock('@/lib/budget-tracker', () => ({
  recordSpend: vi.fn(),
  VERTEX_IMAGEN_COST_CENTS: 4,
}));
// Partial: the wiring calls guardRenderBytes, and what this file measures is
// WHETHER and WITH WHAT — the verdict arithmetic is renderGuard's own test.
vi.mock('@/lib/renderGuard', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  guardRenderBytes: vi.fn(),
}));
// Partial: every export is real except renderStatePrompt, which one test
// below overrides to produce a prompt that contradicts the state. There is no
// honest way to reach the refusal through the real renderer — it does not
// produce contradicting prompts, which is the point of the guard.
vi.mock('../internal/designState', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  renderStatePrompt: vi.fn(),
}));

const mockGenerate = vi.mocked(generate);
const mockRenderStatePrompt = vi.mocked(renderStatePrompt);
const mockGuardRenderBytes = vi.mocked(guardRenderBytes);
const mockRecoverImageAtPath = vi.mocked(recoverImageAtPath);
const mockCopyImageToPath = vi.mocked(copyImageToPath);
const mockUploadImageToPath = vi.mocked(uploadImageToPath);
const mockRecordSpend = vi.mocked(recordSpend);

const SESSION_ID = 'sess-guardrail';
const durableUrl = (objectPath: string) =>
  `https://storage.googleapis.com/tatt-pro-assets/${objectPath}`;

function revealCuts(): Variation[] {
  return [
    {
      id: 'v1',
      axisPosition: { 'bold-fine': 'bold' },
      prompt: 'a bold koi fish',
      negativePrompt: 'n1',
      imageUrl: 'https://img/koi-bold.png',
    },
    {
      id: 'v2',
      axisPosition: { 'bold-fine': 'fine' },
      prompt: 'a fine-line koi fish',
      negativePrompt: 'n2',
      imageUrl: 'https://img/koi-fine.png',
    },
  ];
}

async function seedReveal(): Promise<void> {
  const session: StoredSession = {
    id: SESSION_ID,
    phase: 'revealed',
    intake: {
      placement: 'forearm',
      styleTags: ['color'],
      subject: 'a koi fish',
      meaning: 'perseverance through the current',
      references: [],
      ambiguousAxes: [],
    },
    axisSelection: { mode: 'questionnaire', axes: ['bold-fine'], rationale: 'r' },
    provider: 'vertex',
    pinnedModelId: 'imagen-4',
    pinnedAspectRatio: '1:1',
    variations: revealCuts(),
    rounds: [{ round: 1, axis: 'bold-fine', variationIds: ['v1', 'v2'], pickedId: 'v1' }],
    createdAt: '2026-08-27T00:00:00.000Z',
    updatedAt: '2026-08-27T00:00:00.000Z',
  };
  await memorySessionStore.save(session);
}

beforeEach(async () => {
  vi.clearAllMocks();
  clearMemorySessions();
  delete process.env.NEXT_PUBLIC_DEMO_MODE;
  mockGenerate.mockResolvedValue({ images: ['https://img/recut.png'] } as never);
  mockRecoverImageAtPath.mockResolvedValue(null);
  mockCopyImageToPath.mockImplementation(async (objectPath) => durableUrl(objectPath));
  mockUploadImageToPath.mockImplementation(async (objectPath) => durableUrl(objectPath));
  mockRecordSpend.mockResolvedValue(undefined);
  mockGuardRenderBytes.mockResolvedValue({
    passed: true,
    kind: 'transparent',
    borderBackdropFraction: 0.98,
    reason: 'flash art on a clean backdrop',
  } as never);
  // The real renderer by default; individual tests override.
  const real = await vi.importActual<typeof import('../internal/designState')>(
    '../internal/designState'
  );
  mockRenderStatePrompt.mockImplementation(real.renderStatePrompt);
  await seedReveal();
});

describe('prompt contract at the pre-spend point', () => {
  it('refuses the render when the prompt contradicts a blocking field', async () => {
    // A colour session whose rendered prompt commands monochrome. The state
    // and the prompt disagree about the design itself — the eagle failure's
    // shape, one field over — and it is detectable for free.
    mockRenderStatePrompt.mockReturnValue(
      'Flash art tattoo design on a pure white background. A tattoo design ' +
        'depicting a koi fish. Palette: no color at all, black ink only. ' +
        'Composed for a tattoo on the forearm.'
    );

    await expect(critique(SESSION_ID, { message: 'make it bigger' })).rejects.toThrow(
      /refusing to spend a render/
    );
    // The point of a PRE-spend guard: the money was never spent.
    expect(mockGenerate).not.toHaveBeenCalled();
    expect(mockRecordSpend).not.toHaveBeenCalled();
  });

  it('lets a correct render through even when a log-only field reports a contradiction', async () => {
    // "unreal engine" is a real translated style word; its exclusion is
    // 'flat cel-shaded outlines', and the prompt carries it correctly as
    // "Avoid: flat cel-shaded outlines." The presentation lead independently
    // says "a flat scan of the artwork alone", so the contract reports
    // contradicted:["flat"] on a prompt that is doing exactly the right
    // thing. exclusions is log-only for precisely this reason (#388) — if it
    // ever joins CONTRACT_BLOCKING_FIELDS, this customer stops being able to
    // re-cut at all.
    const result = await critique(SESSION_ID, { message: 'make it unreal engine 5' });

    expect(result.generated).toBe(true);
    expect(mockGenerate).toHaveBeenCalledTimes(1);

    // The collision is real and still present — this test is not passing
    // because the prompt got clean.
    const prompt = mockGenerate.mock.calls[0][0].prompt;
    expect(prompt).toContain('Avoid: flat cel-shaded outlines');
    expect(prompt).toContain('a flat scan of the artwork alone');
  });
});

describe('render guard at the acceptance point', () => {
  it('measures the pixels of an inline render, from the bytes already in hand', async () => {
    const pngBytes = Buffer.from('pretend-png-bytes');
    mockGenerate.mockResolvedValue({
      images: [`data:image/png;base64,${pngBytes.toString('base64')}`],
    } as never);

    await critique(SESSION_ID, { message: 'make it bigger' });

    expect(mockGuardRenderBytes).toHaveBeenCalledTimes(1);
    // The decoded bytes, not the data URL — no network, no re-fetch of an
    // image we are holding.
    const passed = mockGuardRenderBytes.mock.calls[0][0];
    expect(Buffer.from(passed).toString()).toBe('pretend-png-bytes');
  });

  it('does not fetch a hosted render, and does not report it as measured', async () => {
    // Replicate hands back a URL. Measuring it would mean an HTTP GET inside
    // a paid render path for an image we are about to copy anyway. The lane
    // is skipped — and skipping is logged rather than passed off as green.
    mockGenerate.mockResolvedValue({ images: ['https://img/recut.png'] } as never);

    const result = await critique(SESSION_ID, { message: 'make it bigger' });

    expect(result.generated).toBe(true);
    expect(mockGuardRenderBytes).not.toHaveBeenCalled();
  });

  it('never lets a guard failure cost the customer a paid render', async () => {
    mockGenerate.mockResolvedValue({
      images: [`data:image/png;base64,${Buffer.from('x').toString('base64')}`],
    } as never);
    mockGuardRenderBytes.mockRejectedValue(new Error('sharp exploded'));

    const result = await critique(SESSION_ID, { message: 'make it bigger' });

    // The render was bought. A guard that swallows it is worse than no guard.
    expect(result.generated).toBe(true);
    expect(result.session.critiqueCuts?.[0].imageUrl).toBeTruthy();
  });
});
