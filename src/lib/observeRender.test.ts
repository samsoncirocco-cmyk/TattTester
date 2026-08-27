/**
 * The shared render observation — who gets measured, and what gets said when
 * they cannot be.
 *
 * `renderGuard` has its own tests for the arithmetic. This file is about the
 * wrapper's three promises: it never throws into a paid render path, it says
 * `measured: false` WITH A REASON rather than reporting a quiet green, and the
 * lane decides whether a failing verdict is a warning or an observation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { observeRenderedImage } from '@/lib/observeRender';
import { guardRenderBytes } from '@/lib/renderGuard';
import { logger } from '@/lib/logger';

vi.mock('@/lib/renderGuard', () => ({ guardRenderBytes: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockGuard = vi.mocked(guardRenderBytes);
const mockInfo = vi.mocked(logger.info);
const mockWarn = vi.mocked(logger.warn);

const dataUrl = (body: string) =>
  `data:image/png;base64,${Buffer.from(body).toString('base64')}`;

const LANE = { eventType: 'test_lane.render_guard', fields: { session_id: 's1' } };

beforeEach(() => {
  vi.clearAllMocks();
  mockGuard.mockResolvedValue({
    passed: true,
    kind: 'transparent',
    borderBackdropFraction: 0.97,
    reason: 'flash art on a clean backdrop',
  } as never);
});

describe('observeRenderedImage', () => {
  it('measures inline bytes and logs the fraction beside the verdict', async () => {
    await observeRenderedImage(dataUrl('png-bytes'), LANE);

    expect(Buffer.from(mockGuard.mock.calls[0][0]).toString()).toBe('png-bytes');
    expect(mockInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'test_lane.render_guard',
        session_id: 's1',
        measured: true,
        passed: true,
        // The number is the point: "obviously a photograph" and "a design that
        // bleeds off two edges" are both failures and are not the same problem.
        border_backdrop_fraction: 0.97,
      })
    );
  });

  it('says it could not measure a hosted URL, and why', async () => {
    await observeRenderedImage('https://replicate.delivery/pbxt/out.png', LANE);

    expect(mockGuard).not.toHaveBeenCalled();
    const line = mockInfo.mock.calls[0][0] as Record<string, unknown>;
    expect(line.measured).toBe(false);
    // A guard that cannot see something has to say so. An unmeasured render
    // reported without a reason is indistinguishable from a clean one, which
    // is the roster-only silence that shipped the astronaut bug.
    expect(line.reason).toMatch(/hosted URL/);
  });

  it('distinguishes "no image" from "could not measure this image"', async () => {
    await observeRenderedImage(undefined, LANE);

    const line = mockInfo.mock.calls[0][0] as Record<string, unknown>;
    expect(line.measured).toBe(false);
    expect(line.reason).toMatch(/no image/);
  });

  it('warns on a failure for a lane that pins the flash-art presentation', async () => {
    mockGuard.mockResolvedValue({
      passed: false,
      kind: 'opaque-scene',
      borderBackdropFraction: 0.04,
      reason: 'looks like a photograph',
    } as never);

    await observeRenderedImage(dataUrl('x'), LANE);

    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({ measured: true, passed: false, kind: 'opaque-scene' })
    );
  });

  it('records the same failure as an observation for a lane that does not', async () => {
    // An endpoint rendering an arbitrary caller-supplied prompt never asserted
    // the backdrop, so a low fraction is not a defect. Still measured — only
    // the level differs, because a warning nobody can act on is a warning
    // people learn to skip.
    mockGuard.mockResolvedValue({
      passed: false,
      kind: 'opaque-scene',
      borderBackdropFraction: 0.04,
      reason: 'looks like a photograph',
    } as never);

    await observeRenderedImage(dataUrl('x'), { ...LANE, warnOnFail: false });

    expect(mockWarn).not.toHaveBeenCalled();
    expect(mockInfo).toHaveBeenCalledWith(
      expect.objectContaining({ measured: true, passed: false })
    );
  });

  it('never throws into a paid render path', async () => {
    mockGuard.mockRejectedValue(new Error('sharp exploded'));

    await expect(observeRenderedImage(dataUrl('x'), LANE)).resolves.toBeUndefined();
    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'test_lane.render_guard_errored' })
    );
  });
});
