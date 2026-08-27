/**
 * Render guard — check the PIXELS of what the provider actually sent back,
 * at the moment it comes back, before anything downstream accepts it.
 *
 * `@/lib/designBackdrop` already knows how to tell flash art on white from a
 * photograph of a tattoo on skin, and its own docstring states the reason it
 * exists: "a prompt is a request, not a guarantee, and the provider is free to
 * ignore it. So we measure the actual pixels rather than trusting the
 * session's intent." Today that measurement only runs DOWNSTREAM — in the
 * browser at AR/placement preview time (PlacementPreview.tsx,
 * services/ar/designSource.ts) and server-side in the SMS composite
 * (services/sketchbotSms/internal/placement.ts). All three are minutes to days
 * after the render was paid for, and all three are opt-in surfaces a user may
 * never open. A re-cut whose prompt opens "A tattoo on the back." and comes
 * back as a photo of somebody's skin therefore sails through the session,
 * lands in the reveal grid, and is only caught if the user happens to tap
 * "see it on me".
 *
 * This module moves that same check to the acceptance point. It adds nothing
 * to the analysis — it IMPORTS `assessBackdrop` rather than restating the
 * thresholds, exactly as designBackdrop.ts demands ("If you need this in
 * another surface, import it — do not write a second copy that drifts from
 * this one"). Everything here is the DECODE step: turning an image URL or a
 * byte buffer into the plain RGBA `PixelBuffer` that `assessBackdrop` already
 * consumes, plus a structured verdict a caller can log.
 *
 * WHY A STRUCTURED VERDICT AND NOT A BOOLEAN. Rejecting a render is a
 * money-shaped decision — the bytes in hand were already billed against
 * BUDGET_MAX_SPEND_CENTS, and re-cutting costs again. Whoever wires this in
 * has to be able to read the log line and answer "what did the guard actually
 * measure, and how close was it to the line?" without re-fetching the image.
 * So the verdict carries the measured border fraction and a human reason, not
 * just a pass bit.
 *
 * WHY DECODE AND FETCH ARE INJECTED. The analysis is pure arithmetic over a
 * pixel buffer and must stay testable with a hand-built array — no fixture
 * files, no network, no image codec in the test path. The default decoder uses
 * `sharp`, which is already a production dependency and already the decoder of
 * record for this exact job in placement.ts; it is imported lazily so that a
 * caller who supplies its own decoder (an Edge runtime, a browser canvas, a
 * test) never drags a native binary in. The default fetcher is global `fetch`,
 * which is fine for our own bucket URLs but is the one part of this module
 * that touches the network, so it is a parameter rather than a hard call.
 *
 * FAIL-OPEN ON UNDECODABLE, DELIBERATELY. If the bytes cannot be decoded we
 * report `undecodable` with `passed: true`. That looks backwards for a guard,
 * but the alternative is discarding a render we already paid for on the
 * strength of a codec error, and then paying again — trading a possible bad
 * image for a certain double charge. The verdict says plainly that nothing was
 * measured; a caller that wants to be strict can branch on `kind` itself.
 *
 * "Undecodable" includes a decode that SUCCEEDED but produced a buffer whose
 * length is not `width * height * 4`. That is not pedantry: a decoder that
 * skipped `.ensureAlpha()` returns three channels per pixel, every helper in
 * designBackdrop indexes by four, and the resulting read is off by a growing
 * stride — a pure white sheet measures 0.63 instead of 1.0, and a short buffer
 * measures 0.005 and is confidently rejected as a photograph. A misaligned
 * decode is exactly the codec quirk this module promises never to turn into a
 * lost generation, so it is checked explicitly rather than trusted.
 *
 * ## WHERE THIS RUNS, AND WHAT IT IS ALLOWED TO DO THERE
 *
 * `guardRenderBytes` is called from `renderDurably`'s render closure
 * (`services/designSession/internal/orchestrator.ts`) the moment a provider
 * answers — the single choke point every PAID render in that file passes
 * through, reveal and re-cut alike, and inside the closure so a reused staged
 * image is not re-measured. It MEASURES AND LOGS; it does not reject.
 *
 * Only inline renders are measured. Vertex hands back `data:` URLs, so the
 * bytes are already in memory and the check costs a decode and no network;
 * Replicate hands back a hosted URL, and `guardRenderUrl` on it would mean
 * fetching an image the caller is about to copy anyway, from inside a paid
 * render path. That lane logs `measured: false` with the reason rather than a
 * quiet green — a guard that cannot see something has to say so.
 *
 * That is the fail-open argument above taken to its conclusion rather than a
 * half-arming. The bytes in hand were already billed; discarding them on this
 * verdict buys a certain double charge against a possible bad image. What the
 * call site changes is WHEN the measurement exists: at acceptance, in a log
 * line carrying `borderBackdropFraction` beside the threshold, instead of
 * whenever a customer happens to open an opt-in preview surface — or never.
 * Turning the verdict into a refusal is a separate, evidence-led decision,
 * and the logged fractions are the evidence it needs.
 */
import {
  assessBackdrop,
  BACKDROP_BORDER_THRESHOLD,
  OPAQUE_SCENE_MESSAGE,
  type BackdropVerdict,
  type PixelBuffer,
} from '@/lib/designBackdrop';

/** Re-exported so a caller can type its own decoder without a second import. */
export type { PixelBuffer } from '@/lib/designBackdrop';

/**
 * Why a render passed or failed. `transparent` and `strippable` mirror
 * `BackdropVerdict`; `undecodable` is this module's own — the bytes never
 * became pixels, so no measurement exists.
 */
export type RenderGuardKind = BackdropVerdict['kind'] | 'undecodable';

export interface RenderGuardVerdict {
  /** False only for `opaque-scene`. See the fail-open note in the header. */
  passed: boolean;
  kind: RenderGuardKind;
  /**
   * The measured outer-ring backdrop fraction, 0..1, straight from
   * `borderBackdropFraction`. 0 when nothing could be measured. Log this: it
   * is the difference between "obviously a photograph" (near 0) and "a design
   * that bleeds off two edges" (just under the threshold).
   */
  borderBackdropFraction: number;
  /** One line, safe to put in a server log. Not user-facing copy. */
  reason: string;
  /**
   * User-facing copy for a failure, borrowed from designBackdrop so the
   * wording stays identical to the preview surfaces. Absent on a pass.
   */
  message?: string;
}

/** Decode image bytes to raw RGBA. Must return 4 channels per pixel. */
export type ImageDecoder = (bytes: Uint8Array) => Promise<PixelBuffer>;

/** Fetch an image URL to bytes. Isolated so the core stays network-free. */
export type ImageFetcher = (url: string) => Promise<Uint8Array>;

export interface RenderGuardOptions {
  decode?: ImageDecoder;
  fetchImage?: ImageFetcher;
}

/**
 * The whole judgement, over pixels that are already in hand. Pure: no I/O, no
 * codec, no clock. Everything else in this file exists to feed this function.
 */
export function inspectRenderPixels(pixels: PixelBuffer): RenderGuardVerdict {
  if (!pixels || !pixels.data || pixels.width <= 0 || pixels.height <= 0) {
    return {
      passed: true,
      kind: 'undecodable',
      borderBackdropFraction: 0,
      reason: 'render guard could not measure: empty pixel buffer',
    };
  }

  // The buffer must be exactly four channels per pixel, because every helper
  // in designBackdrop indexes it that way. A three-channel or truncated buffer
  // still measures — it just measures the wrong bytes, and produces a verdict
  // that looks authoritative and means nothing. Refusing to measure is the
  // only honest answer, and fail-open keeps the paid render.
  const expected = pixels.width * pixels.height * 4;
  if (pixels.data.length !== expected) {
    return {
      passed: true,
      kind: 'undecodable',
      borderBackdropFraction: 0,
      reason:
        `render guard could not measure: pixel buffer is ${pixels.data.length} bytes for ` +
        `${pixels.width}x${pixels.height}, expected ${expected} (RGBA, 4 channels — did the ` +
        'decoder skip ensureAlpha?)',
    };
  }

  const verdict = assessBackdrop(pixels);
  const fraction = verdict.borderBackdropFraction;
  const measured = fraction.toFixed(3);

  if (verdict.kind === 'opaque-scene') {
    return {
      passed: false,
      kind: 'opaque-scene',
      borderBackdropFraction: fraction,
      reason:
        `render rejected: opaque scene, border backdrop ${measured} < ` +
        `${BACKDROP_BORDER_THRESHOLD} — this is a photograph, not flash art on white`,
      message: OPAQUE_SCENE_MESSAGE,
    };
  }

  if (verdict.kind === 'transparent') {
    return {
      passed: true,
      kind: 'transparent',
      borderBackdropFraction: fraction,
      reason: `render accepted: real alpha channel present (border backdrop ${measured})`,
    };
  }

  return {
    passed: true,
    kind: 'strippable',
    borderBackdropFraction: fraction,
    reason:
      `render accepted: flash art on white, border backdrop ${measured} >= ` +
      `${BACKDROP_BORDER_THRESHOLD}`,
  };
}

/**
 * Decode with `sharp`, the same call placement.ts makes.
 *
 * `.ensureAlpha()` is not optional: a raw decode of an opaque JPEG yields
 * THREE channels, and every helper in designBackdrop indexes by 4. Without it
 * the guard silently reads the wrong bytes as alpha and produces a confident,
 * meaningless verdict — which is worse than no guard at all.
 */
export const sharpDecoder: ImageDecoder = async (bytes) => {
  const { default: sharp } = await import('sharp');
  const { data, info } = await sharp(Buffer.from(bytes))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
};

/** Read an image URL into bytes with the platform `fetch`. */
export const fetchImageBytes: ImageFetcher = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`image fetch failed: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
};

/**
 * Guard a render we already hold the bytes for — the cheap path, and the one
 * to prefer. A decode failure is reported, never thrown: this sits directly in
 * a paid render path and must not be able to turn a codec quirk into a lost
 * generation.
 */
export async function guardRenderBytes(
  bytes: Uint8Array,
  options: RenderGuardOptions = {}
): Promise<RenderGuardVerdict> {
  const decode = options.decode ?? sharpDecoder;
  let pixels: PixelBuffer;
  try {
    pixels = await decode(bytes);
  } catch (err) {
    return {
      passed: true,
      kind: 'undecodable',
      borderBackdropFraction: 0,
      reason: `render guard could not decode image: ${(err as Error)?.message ?? err}`,
    };
  }
  return inspectRenderPixels(pixels);
}

/**
 * Guard a render we only have a URL for. Costs one HTTP GET, normally against
 * our own bucket after `renderDurably`. A fetch failure is reported the same
 * way a decode failure is, and for the same reason.
 */
export async function guardRenderUrl(
  url: string,
  options: RenderGuardOptions = {}
): Promise<RenderGuardVerdict> {
  const fetchImage = options.fetchImage ?? fetchImageBytes;
  let bytes: Uint8Array;
  try {
    bytes = await fetchImage(url);
  } catch (err) {
    return {
      passed: true,
      kind: 'undecodable',
      borderBackdropFraction: 0,
      reason: `render guard could not fetch image: ${(err as Error)?.message ?? err}`,
    };
  }
  return guardRenderBytes(bytes, options);
}
