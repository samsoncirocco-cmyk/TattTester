// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { DesignSession } from '@/services/designSession/types';
import { PlacementPreview } from '../components/PlacementPreview';

vi.mock('@/lib/client-api-auth', () => ({
  getApiAuthHeaders: vi.fn(async () => ({ Authorization: 'Bearer test-token' })),
  getOptionalApiAuthHeaders: vi.fn(async () => ({ Authorization: 'Bearer test-token' })),
  SignInRequiredError: class SignInRequiredError extends Error {},
}));

/**
 * The design images every test in this file is really about. `fabric.util.
 * loadImage` is stubbed to hand back a painted <canvas> tagged with
 * naturalWidth/naturalHeight — that satisfies everything prepareDesign()
 * touches (`drawImage` accepts a canvas), so the component runs its real
 * pixel path against pixels we control.
 */
const SIZE = 64;
const inInk = (x: number, y: number) =>
  Math.abs(x - SIZE / 2) < SIZE * 0.2 && Math.abs(y - SIZE / 2) < SIZE * 0.2;

function painted(fn: (x: number, y: number) => [number, number, number]): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = SIZE;
  c.height = SIZE;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(SIZE, SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = (y * SIZE + x) * 4;
      const [r, g, b] = fn(x, y);
      img.data[i] = r;
      img.data[i + 1] = g;
      img.data[i + 2] = b;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  Object.defineProperty(c, 'naturalWidth', { value: SIZE });
  Object.defineProperty(c, 'naturalHeight', { value: SIZE });
  return c;
}

/** Flash art on white — the presentation ADR-0023 pins every render to. */
const flashArt = () => painted((x, y) => (inInk(x, y) ? [10, 10, 10] : [255, 255, 255]));

/** The same design photographed on an arm — no paper anywhere to strip. */
const onSkin = () =>
  painted((x, y) => {
    if (inInk(x, y)) return [18, 14, 12];
    const s = 200 + ((x * 7 + y * 3) % 24);
    return [s, s - 38, s - 62];
  });

/** Which fixture `loadImage` returns next, keyed by the requested URL. */
const imageFor = new Map<string, () => HTMLCanvasElement>();

const canvasObjects: unknown[] = [];

vi.mock('fabric', () => {
  class FabricImage {
    controls: unknown = {};
    width = SIZE;
    height = SIZE;
    scaleX = 1;
    scaleY = 1;
    opacity = 1;
    constructor(
      public source: unknown,
      public options: Record<string, unknown>
    ) {}
    set(props: Record<string, unknown>) {
      Object.assign(this, props);
      return this;
    }
    setCoords() {}
    getCenterPoint() {
      return { x: 0, y: 0 };
    }
  }
  class Control {
    constructor(public options: Record<string, unknown>) {}
  }
  class Canvas {
    backgroundImage: unknown = null;
    constructor(
      public el: unknown,
      public options: Record<string, unknown>
    ) {}
    on() {}
    add(obj: unknown) {
      canvasObjects.push(obj);
    }
    remove(...objs: unknown[]) {
      for (const o of objs) {
        const i = canvasObjects.indexOf(o);
        if (i >= 0) canvasObjects.splice(i, 1);
      }
    }
    getObjects() {
      return canvasObjects;
    }
    getActiveObject() {
      return null;
    }
    setActiveObject() {}
    discardActiveObject() {}
    requestRenderAll() {}
    getWidth() {
      return 320;
    }
    getHeight() {
      return 320;
    }
    toDataURL() {
      return 'data:image/png;base64,QUJD';
    }
    dispose() {}
  }
  return {
    Canvas,
    FabricImage,
    Control,
    util: {
      loadImage: vi.fn(async (url: string) => {
        const make = imageFor.get(url);
        if (!make) throw new Error(`no fixture for ${url}`);
        return make();
      }),
    },
  };
});

function sessionWith(designUrl: string): DesignSession {
  return {
    id: 'sess-1',
    phase: 'complete',
    intake: {} as DesignSession['intake'],
    axisSelection: {} as DesignSession['axisSelection'],
    provider: 'demo',
    variations: [
      { id: 'v1', axisPosition: {}, prompt: 'a compass rose', imageUrl: designUrl },
    ],
    brief: {
      placement: 'forearm',
      styleTags: ['fine-line'],
      meaning: '',
      references: [],
      axisSelection: {} as DesignSession['axisSelection'],
      placementNotes: [],
    },
    createdAt: '2026-07-25T00:00:00.000Z',
    updatedAt: '2026-07-25T00:00:00.000Z',
  };
}

/**
 * Adding a design is an async chain (loadImage → pixel vet → strip → canvas),
 * so every assertion on it has to wait.
 *
 * Headroom is NOT what makes this file stable — every interaction below is
 * gated on the component's own readiness signal, so nothing here races a clock.
 * If one of these waits ever expires, the work genuinely is not happening;
 * raising the number will only make the red run slower. Go read what the wait
 * is gated on instead.
 */
const SETTLE = { timeout: 10_000 };

/** Tap a tray design and wait for the canvas to actually take it. */
async function addDesign(count: number) {
  fireEvent.click(screen.getByRole('button', { name: 'Add Design 1 to the photo' }));
  await waitFor(() => expect(canvasObjects).toHaveLength(count), SETTLE);
}

/**
 * Drive the file input, then wait for the canvas to come up.
 *
 * The wait has to be on the tray BUTTON being enabled, not on the tray merely
 * existing. The tray renders the moment `photoUrl` is set, but its buttons stay
 * `disabled` until the async canvas build (import fabric → loadImage → new
 * Canvas → setCanvasReady) finishes. React does not deliver a click to a
 * disabled button, and `waitFor` re-checks its assertion without re-clicking —
 * so a click fired one macrotask too early is swallowed with no trace and the
 * caller then waits out its entire deadline for a canvas object that will never
 * arrive. Gate on the component's own readiness signal instead of racing it.
 */
async function uploadPhoto() {
  imageFor.set('data:image/png;base64,UEhPVE8=', flashArt);
  const input = screen.getByLabelText('Upload a photo of your body') as HTMLInputElement;
  const file = new File(['x'], 'arm.png', { type: 'image/png' });
  // jsdom's FileReader would hand back a base64 of "x"; pin it instead so the
  // stubbed loadImage has a key it recognises.
  vi.spyOn(FileReader.prototype, 'readAsDataURL').mockImplementation(function (
    this: FileReader
  ) {
    Object.defineProperty(this, 'result', { value: 'data:image/png;base64,UEhPVE8=' });
    this.onload?.({} as ProgressEvent<FileReader>);
  });
  fireEvent.change(input, { target: { files: [file] } });
  await waitFor(() => {
    const add = screen.getByRole('button', { name: 'Add Design 1 to the photo' });
    expect(add.hasAttribute('disabled')).toBe(false);
  }, SETTLE);
}

beforeEach(() => {
  canvasObjects.length = 0;
  imageFor.clear();
  vi.restoreAllMocks();
});

describe('PlacementPreview — the on-skin guard', () => {
  it('refuses a design photographed on skin, and adds nothing to the canvas', async () => {
    imageFor.set('https://cdn.test/on-skin.png', onSkin);
    render(<PlacementPreview session={sessionWith('https://cdn.test/on-skin.png')} />);
    await uploadPhoto();

    fireEvent.click(screen.getByRole('button', { name: 'Add Design 1 to the photo' }));

    await waitFor(() => expect(screen.getByText(/not flash art on white/i)).toBeTruthy(), SETTLE);
    // The whole point: nothing was composited. Without this guard the opaque
    // frame — a stranger's arm — would multiply onto the user's own photo.
    expect(canvasObjects).toHaveLength(0);
  });

  it('accepts flash art on white and composites it with the multiply blend', async () => {
    imageFor.set('https://cdn.test/flash.png', flashArt);
    render(<PlacementPreview session={sessionWith('https://cdn.test/flash.png')} />);
    await uploadPhoto();

    await addDesign(1);
    expect(screen.queryByText(/not flash art on white/i)).toBeNull();

    const placed = canvasObjects[0] as { options: Record<string, unknown> };
    expect(placed.options.globalCompositeOperation).toBe('multiply');
  });

  it('names the placement resolved during intake rather than guessing at the photo', async () => {
    imageFor.set('https://cdn.test/flash.png', flashArt);
    render(<PlacementPreview session={sessionWith('https://cdn.test/flash.png')} />);
    expect(screen.getByText('forearm')).toBeTruthy();
  });
});

describe('PlacementPreview — side-by-side review', () => {
  it('shows the design beside the composite, and only offers sharing once saved', async () => {
    imageFor.set('https://cdn.test/flash.png', flashArt);
    render(<PlacementPreview session={sessionWith('https://cdn.test/flash.png')} />);
    await uploadPhoto();
    await addDesign(1);

    fireEvent.click(screen.getByRole('button', { name: 'See it side by side' }));

    const review = await screen.findByTestId('placement-review', undefined, SETTLE);
    expect(review.querySelector('img[alt="Your design placed on your photo"]')).toBeTruthy();
    expect(review.querySelector('img[alt="Design 1"]')).toBeTruthy();
    expect(screen.getByText('On your forearm')).toBeTruthy();

    // A share link must point at something durable, so it stays disabled
    // until the preview has actually been saved.
    expect(screen.getByRole('button', { name: 'Share a link' }).hasAttribute('disabled')).toBe(
      true
    );
  });

  it('drops the review when the canvas changes, so no stale composite is saved', async () => {
    imageFor.set('https://cdn.test/flash.png', flashArt);
    render(<PlacementPreview session={sessionWith('https://cdn.test/flash.png')} />);
    await uploadPhoto();
    await addDesign(1);
    fireEvent.click(screen.getByRole('button', { name: 'See it side by side' }));
    await screen.findByTestId('placement-review', undefined, SETTLE);

    // Adding a second design invalidates the flattened frame.
    await addDesign(2);

    await waitFor(() => expect(screen.queryByTestId('placement-review')).toBeNull(), SETTLE);
  });
});
