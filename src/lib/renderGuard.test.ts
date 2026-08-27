/**
 * The render guard's job is to tell flash art on white from a photograph of
 * skin, at the moment a paid render comes back. These tests build the two
 * cases as raw RGBA by hand — no fixture images, no codec, no network — so
 * what is under test is the judgement, not sharp.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  guardRenderBytes,
  guardRenderUrl,
  inspectRenderPixels,
  type ImageDecoder,
  type PixelBuffer,
} from './renderGuard';
import {
  BACKDROP_BORDER_THRESHOLD,
  borderBackdropFraction,
  type PixelBuffer as BackdropPixelBuffer,
} from './designBackdrop';

const W = 50;
const H = 50;

function buffer(fill: (x: number, y: number) => [number, number, number, number]): PixelBuffer {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const [r, g, b, a] = fill(x, y);
      const i = (y * W + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    }
  }
  return { data, width: W, height: H };
}

/** Flash art: paper-white sheet with a solid black panel floating in the middle. */
function flashArt(): PixelBuffer {
  return buffer((x, y) => {
    const inInk = x >= 12 && x < 38 && y >= 12 && y < 38;
    return inInk ? [10, 10, 10, 255] : [255, 255, 255, 255];
  });
}

/**
 * On skin: an edge-to-edge photograph. Skin is high-red / much-lower-blue, so
 * its darkest channel sits far below the backdrop threshold even though it is
 * a light colour — the exact case designBackdrop's "darkest channel" rule
 * exists to catch.
 */
function onSkin(): PixelBuffer {
  return buffer((x, y) => [232, 186, 158 + ((x + y) % 8), 255]);
}

/**
 * A buffer whose OUTER RING is `target` white and the rest black — the only
 * fixture shape that can tell the border threshold apart from any other
 * number.
 *
 * The ring geometry is designBackdrop's, restated here because the test has to
 * choose which pixels to whiten; the resulting fraction is then measured with
 * designBackdrop's own `borderBackdropFraction` rather than assumed, so a
 * change to the ring width shows up as a failed pre-condition in the tests
 * below instead of as a silently mis-aimed fixture.
 */
function ringWhite(target: number): PixelBuffer {
  const ring = Math.max(2, Math.round(Math.min(W, H) * 0.04));
  const isRing = (x: number, y: number) =>
    y < ring || y >= H - ring || x < ring || x >= W - ring;

  let ringTotal = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (isRing(x, y)) ringTotal++;

  const quota = Math.round(target * ringTotal);
  let whitened = 0;
  return buffer((x, y) => {
    if (!isRing(x, y)) return [255, 255, 255, 255];
    if (whitened < quota) {
      whitened++;
      return [255, 255, 255, 255];
    }
    // Mid-grey, well under BACKDROP_MIN_CHANNEL, and opaque so the alpha
    // shortcut cannot answer for the border test.
    return [90, 90, 90, 255];
  });
}

/** A provider that did the keying itself: real alpha, no white margin at all. */
function alreadyKeyed(): PixelBuffer {
  return buffer((x, y) => {
    const inInk = x >= 12 && x < 38 && y >= 12 && y < 38;
    return inInk ? [10, 10, 10, 255] : [0, 0, 0, 0];
  });
}

describe('inspectRenderPixels', () => {
  it('accepts flash art on white and reports a near-1 border fraction', () => {
    const verdict = inspectRenderPixels(flashArt());
    expect(verdict.passed).toBe(true);
    expect(verdict.kind).toBe('strippable');
    expect(verdict.borderBackdropFraction).toBe(1);
    expect(verdict.message).toBeUndefined();
  });

  it('rejects an edge-to-edge on-skin render', () => {
    const verdict = inspectRenderPixels(onSkin());
    expect(verdict.passed).toBe(false);
    expect(verdict.kind).toBe('opaque-scene');
    expect(verdict.borderBackdropFraction).toBe(0);
    // The refusal has to be explainable from the log line alone.
    expect(verdict.reason).toContain('0.000');
    expect(verdict.reason).toContain('photograph');
    expect(verdict.message).toBeTruthy();
  });

  it('verdict flips between the two buffers on the same code path', () => {
    expect(inspectRenderPixels(flashArt()).passed).not.toBe(
      inspectRenderPixels(onSkin()).passed
    );
  });

  it('accepts a render that already carries real alpha, despite no white margin', () => {
    const verdict = inspectRenderPixels(alreadyKeyed());
    expect(verdict.passed).toBe(true);
    expect(verdict.kind).toBe('transparent');
  });

  it('accepts a design that bleeds off one edge', () => {
    const bleeding = buffer((x) => (x < 6 ? [10, 10, 10, 255] : [255, 255, 255, 255]));
    const verdict = inspectRenderPixels(bleeding);
    expect(verdict.passed).toBe(true);
    expect(verdict.kind).toBe('strippable');
    // Derived, not a literal restating of the constant: the point of this
    // fixture is that a design touching one edge still clears the bar, wherever
    // the bar is. The bar itself is exercised in the threshold block below.
    expect(verdict.borderBackdropFraction).toBeGreaterThan(BACKDROP_BORDER_THRESHOLD);
    expect(verdict.borderBackdropFraction).toBeLessThan(1);
  });

  it('reports undecodable rather than throwing on a zero-sized buffer', () => {
    const verdict = inspectRenderPixels({ data: new Uint8ClampedArray(0), width: 0, height: 0 });
    expect(verdict.kind).toBe('undecodable');
    expect(verdict.passed).toBe(true);
  });

  it('refuses to measure a buffer that is shorter than its stated size', () => {
    // Before the length check this produced a CONFIDENT REJECTION: it read
    // garbage past the end of the array as border pixels, measured 0.005, and
    // told the user their paid render was a photograph. A partial decode is a
    // codec quirk, and the header promises a codec quirk cannot cost a render.
    const verdict = inspectRenderPixels({ data: new Uint8ClampedArray(10), width: W, height: H });
    expect(verdict.kind).toBe('undecodable');
    expect(verdict.passed).toBe(true);
    expect(verdict.reason).toContain('expected');
  });

  it('refuses to measure a three-channel (no-ensureAlpha) decode', () => {
    // An all-white RGB sheet. Indexed by 4 it measures 0.63 instead of 1.0 —
    // still a pass, but a meaningless one, and the same misalignment on a real
    // image lands anywhere at all. `sharpDecoder` calls `.ensureAlpha()`; an
    // injected decoder is under nobody's control but its author's.
    const rgb = new Uint8ClampedArray(W * H * 3).fill(255);
    const verdict = inspectRenderPixels({ data: rgb, width: W, height: H });
    expect(verdict.kind).toBe('undecodable');
    expect(verdict.passed).toBe(true);
    expect(verdict.reason).toContain('ensureAlpha');
  });
});

describe('the border threshold is the decision rule, and is load-bearing', () => {
  // The verdict strings this module emits advertise "< 0.5" and ">= 0.5" as
  // the rule. Without a fixture on each side of that number the suite cannot
  // tell a working discriminator from one set to 0.01, which would wave
  // through any render with a single white pixel on the ring.

  it('is the documented 0.5 — change it here on purpose or not at all', () => {
    expect(BACKDROP_BORDER_THRESHOLD).toBe(0.5);
  });

  it('rejects a render whose border is only 30% backdrop', () => {
    const pixels = ringWhite(0.3);
    // Pre-condition: the fixture really does sit between 0 and the threshold,
    // measured by the same function the guard uses.
    const measured = borderBackdropFraction(pixels);
    expect(measured).toBeGreaterThan(0.25);
    expect(measured).toBeLessThan(BACKDROP_BORDER_THRESHOLD);

    const verdict = inspectRenderPixels(pixels);
    expect(verdict.passed).toBe(false);
    expect(verdict.kind).toBe('opaque-scene');
  });

  it('flips on either side of the threshold, wherever the threshold is set', () => {
    // Derived from the constant rather than from a literal, so this pair
    // tracks a deliberate threshold change and still fails on an accidental
    // one — the fixtures move with the number, the flip must survive.
    const below = ringWhite(BACKDROP_BORDER_THRESHOLD - 0.1);
    const above = ringWhite(BACKDROP_BORDER_THRESHOLD + 0.1);
    expect(borderBackdropFraction(below)).toBeLessThan(BACKDROP_BORDER_THRESHOLD);
    expect(borderBackdropFraction(above)).toBeGreaterThanOrEqual(BACKDROP_BORDER_THRESHOLD);

    expect(inspectRenderPixels(below).kind).toBe('opaque-scene');
    expect(inspectRenderPixels(above).kind).toBe('strippable');
  });
});

describe('guardRenderBytes', () => {
  it('runs the injected decoder and never touches the network', async () => {
    const decode = vi.fn<ImageDecoder>(async () => onSkin());
    const verdict = await guardRenderBytes(new Uint8Array([1, 2, 3]), { decode });
    expect(decode).toHaveBeenCalledTimes(1);
    expect(verdict.passed).toBe(false);
    expect(verdict.kind).toBe('opaque-scene');
  });

  it('fails open with a stated reason when the decoder throws', async () => {
    const decode: ImageDecoder = async () => {
      throw new Error('unsupported image format');
    };
    const verdict = await guardRenderBytes(new Uint8Array([1]), { decode });
    // The bytes were already paid for; a codec error must not discard them.
    expect(verdict.passed).toBe(true);
    expect(verdict.kind).toBe('undecodable');
    expect(verdict.reason).toContain('unsupported image format');
  });
});

describe('guardRenderUrl', () => {
  it('uses the injected fetcher and forwards its bytes to the decoder', async () => {
    const fetchImage = vi.fn(async () => new Uint8Array([9, 9, 9]));
    const decode = vi.fn<ImageDecoder>(async () => flashArt());
    const verdict = await guardRenderUrl('https://storage.example/design.png', {
      fetchImage,
      decode,
    });
    expect(fetchImage).toHaveBeenCalledWith('https://storage.example/design.png');
    expect(decode).toHaveBeenCalledWith(new Uint8Array([9, 9, 9]));
    expect(verdict.kind).toBe('strippable');
  });

  it('fails open when the fetch throws', async () => {
    const fetchImage = async () => {
      throw new Error('image fetch failed: 404');
    };
    const verdict = await guardRenderUrl('https://storage.example/gone.png', { fetchImage });
    expect(verdict.passed).toBe(true);
    expect(verdict.kind).toBe('undecodable');
    expect(verdict.reason).toContain('404');
  });
});

describe('shared threshold', () => {
  it('quotes designBackdrop’s constant in its verdicts rather than a forked copy', () => {
    // The previous version of this test assigned a local fixture to a
    // BackdropPixelBuffer-typed variable and asserted its width against the
    // test's own constant. It imported nothing from renderGuard at runtime and
    // survived gutting inspectRenderPixels to `throw` — a green test named
    // after the exact property it could not observe.
    //
    // This asserts the thing that matters: the number the guard reports to an
    // operator IS designBackdrop's constant, so a fork shows up immediately.
    const pixels: BackdropPixelBuffer = flashArt();
    expect(pixels.width).toBe(W);

    const rejected = inspectRenderPixels(onSkin());
    expect(rejected.reason).toContain(String(BACKDROP_BORDER_THRESHOLD));
    const accepted = inspectRenderPixels(flashArt());
    expect(accepted.reason).toContain(String(BACKDROP_BORDER_THRESHOLD));
  });

  it('measures with designBackdrop’s own function, to the same number', () => {
    const pixels = flashArt();
    expect(inspectRenderPixels(pixels).borderBackdropFraction).toBe(
      borderBackdropFraction(pixels)
    );
  });
});
