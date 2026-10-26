// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import SwipePage from "./page";
import type { ArtistMatch } from "@/store/useMatchStore";
import { SignInRequiredError } from "@/lib/client-api-auth";

const push = vi.fn();
let searchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  useSearchParams: () => searchParams,
}));

vi.mock("next/dynamic", () => ({
  // Render children so card content is visible without react-tinder-card.
  default: () => {
    const Stub = ({
      children,
      className,
    }: {
      children?: React.ReactNode;
      className?: string;
    }) => <div className={className}>{children}</div>;
    return Stub;
  },
}));

vi.mock("@/components/studio/StudioShell", () => ({
  default: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="shell">{children}</div>
  ),
}));

vi.mock("@/components/punk/SlashHeadline", () => ({
  default: ({ before, slashed }: { before: string; slashed: string }) => (
    <h1>
      {before} {slashed}
    </h1>
  ),
}));

const { fetchDecisions, record, remove, subscribe } = vi.hoisted(() => ({
  fetchDecisions: vi.fn(),
  record: vi.fn(),
  remove: vi.fn(),
  subscribe: vi.fn(),
}));

vi.mock("./decisionsClient", () => ({
  decisionsClient: { fetchDecisions, record, remove, subscribe },
}));

type MatchStoreSlice = {
  matches: ArtistMatch[];
  broadened?: ArtistMatch[];
  hasHydrated: boolean;
};

let storeState: MatchStoreSlice = {
  matches: [],
  hasHydrated: false,
};

vi.mock("@/store/useMatchStore", () => ({
  useMatchStore: (selector: (s: MatchStoreSlice) => unknown) =>
    selector(storeState),
}));

beforeEach(() => {
  fetchDecisions.mockReset().mockResolvedValue([]);
  record.mockReset();
  remove.mockReset();
  subscribe.mockReset().mockImplementation(() => () => {});
});

const sampleMatch: ArtistMatch = {
  artistId: "a1",
  artistName: "Ink Nova",
  matchScore: 88,
  tags: ["blackwork"],
  styles: ["blackwork"],
  location: "LA",
};

describe("SwipePage persist hydration", () => {
  beforeEach(() => {
    push.mockClear();
    searchParams = new URLSearchParams();
    storeState = { matches: [], hasHydrated: false };
  });

  it("does not flash empty-deck copy before the match store has hydrated", () => {
    render(<SwipePage />);
    expect(screen.queryByText(/No deck/i)).toBeNull();
    expect(screen.getByLabelText("Loading swipe deck")).toBeTruthy();
  });

  it("shows empty-deck copy only after hydration when there is no deck", () => {
    storeState = { matches: [], hasHydrated: true };
    render(<SwipePage />);
    expect(screen.getByText(/No deck/i)).toBeTruthy();
    expect(screen.queryByLabelText("Loading swipe deck")).toBeNull();
  });

  it("renders the deck after hydration when matches exist", async () => {
    storeState = { matches: [sampleMatch], hasHydrated: true };
    render(<SwipePage />);
    expect(await screen.findByText("Ink Nova")).toBeTruthy();
    expect(screen.queryByText(/No deck/i)).toBeNull();
    expect(screen.queryByLabelText("Loading swipe deck")).toBeNull();
  });
});

describe("SwipePage reason chips", () => {
  beforeEach(() => {
    push.mockClear();
    searchParams = new URLSearchParams();
  });

  it("leads with the payload-backed reason chips and demotes the raw %", async () => {
    storeState = {
      matches: [
        {
          ...sampleMatch,
          reasonChips: ["Blackwork — your pick", "LA — near you"],
        },
      ],
      hasHydrated: true,
    };
    render(<SwipePage />);

    expect(await screen.findByText("Blackwork — your pick")).toBeTruthy();
    expect(screen.getByText("LA — near you")).toBeTruthy();
    // The % survives, but as a quiet inline figure, not a leading stat.
    expect(screen.getByText("88% match")).toBeTruthy();
    // Chips replace the plain style-tag row when they exist.
    expect(screen.queryByText("blackwork")).toBeNull();
  });

  it("falls back to plain style tags for decks persisted before chips existed", async () => {
    storeState = { matches: [sampleMatch], hasHydrated: true };
    render(<SwipePage />);

    expect(await screen.findByText("blackwork")).toBeTruthy();
    expect(screen.getByText("88% match")).toBeTruthy();
    expect(screen.queryByText(/your pick|near you/i)).toBeNull();
  });
});

describe("SwipePage design-session threading", () => {
  beforeEach(() => {
    push.mockClear();
    searchParams = new URLSearchParams();
    storeState = { matches: [sampleMatch], hasHydrated: true };
  });

  it("threads ds from the URL into the pinned artist's Book CTA", async () => {
    searchParams = new URLSearchParams("ds=sess-1");
    render(<SwipePage />);

    fireEvent.click(await screen.findByRole("button", { name: /pin/i }));

    const bookLink = screen.getByRole("link", { name: /book/i });
    expect(bookLink.getAttribute("href")).toBe("/book?artistId=a1&ds=sess-1");
  });

  it("omits ds from the Book CTA when there is no design session", async () => {
    render(<SwipePage />);

    fireEvent.click(await screen.findByRole("button", { name: /pin/i }));

    const bookLink = screen.getByRole("link", { name: /book/i });
    expect(bookLink.getAttribute("href")).toBe("/book?artistId=a1");
  });
});

const secondMatch: ArtistMatch = {
  artistId: "a2",
  artistName: "Needle Ray",
  matchScore: 70,
  tags: [],
  styles: ["realism"],
};

describe("SwipePage decisions (spec 13)", () => {
  beforeEach(() => {
    push.mockClear();
    searchParams = new URLSearchParams();
    storeState = { matches: [sampleMatch, secondMatch], hasHydrated: true };
  });

  it("records a pin and a pass through the decisions client, threading ds", async () => {
    searchParams = new URLSearchParams("ds=sess-1");
    render(<SwipePage />);
    // Later siblings paint on top, so the top card's buttons are the last ones.
    const pins = await screen.findAllByRole("button", { name: /^pin$/i });
    fireEvent.click(pins[pins.length - 1]);
    expect(record).toHaveBeenCalledWith("a2", "pin", "sess-1");
    fireEvent.click(screen.getByRole("button", { name: /^pass$/i }));
    expect(record).toHaveBeenCalledWith("a1", "pass", "sess-1");
    expect(localStorage.getItem("tattester_swipes")).toBeNull();
  });

  it("hydrates pins and passes so decided cards stay gone after a reload", async () => {
    fetchDecisions.mockResolvedValue([
      { artistId: "a1", decision: "pin", dsId: null, updatedAt: 2 },
      { artistId: "a2", decision: "pass", dsId: null, updatedAt: 1 },
    ]);
    render(<SwipePage />);
    expect(await screen.findByText("Deck complete")).toBeTruthy();
    expect(screen.getByText("1 pinned")).toBeTruthy();
    expect(screen.getByRole("link", { name: /book/i }).getAttribute("href")).toBe(
      "/book?artistId=a1",
    );
    expect(record).not.toHaveBeenCalled();
  });

  it("keeps the counter right from hydrated pins and hides only the decided cards", async () => {
    fetchDecisions.mockResolvedValue([{ artistId: "a1", decision: "pin", dsId: null, updatedAt: 1 }]);
    render(<SwipePage />);
    expect(await screen.findByText("Needle Ray")).toBeTruthy();
    expect(screen.queryByText("Ink Nova")).toBeNull();
    expect(screen.getByText("1")).toBeTruthy();
  });

  it("offers to show passed artists again and puts them back in the deck", async () => {
    fetchDecisions.mockResolvedValue([{ artistId: "a1", decision: "pass", dsId: null, updatedAt: 1 }]);
    render(<SwipePage />);
    expect(await screen.findByText("Needle Ray")).toBeTruthy();
    expect(screen.queryByText("Ink Nova")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /show artists i passed/i }));
    expect(screen.getByText("Ink Nova")).toBeTruthy();
  });

  it("asks a signed-out visitor to sign in instead of swiping a stale deck", async () => {
    fetchDecisions.mockRejectedValue(new SignInRequiredError());
    render(<SwipePage />);
    expect(await screen.findByText(/sign in to/i)).toBeTruthy();
    expect(screen.getByRole("link", { name: /sign in/i }).getAttribute("href")).toBe("/login");
    expect(screen.queryByText("Ink Nova")).toBeNull();
  });

  it("still shows the deck when the decisions read fails for a non-auth reason", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchDecisions.mockRejectedValue(new Error("HTTP 503"));
    render(<SwipePage />);
    expect(await screen.findByText("Ink Nova")).toBeTruthy();
  });

  it("surfaces the not-saved line when the client reports unsaved decisions", async () => {
    subscribe.mockImplementation((listener: (s: { unsaved: boolean }) => void) => {
      listener({ unsaved: true });
      return () => {};
    });
    render(<SwipePage />);
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/not saved yet/i));
  });
});

describe("SwipePage card evidence (spec 14)", () => {
  beforeEach(() => {
    push.mockClear();
    searchParams = new URLSearchParams();
  });

  it("leads with the hero work image when the payload has one", async () => {
    storeState = {
      matches: [{ ...sampleMatch, heroImage: "https://img.example/nova.jpg" }],
      hasHydrated: true,
    };
    render(<SwipePage />);
    const img = (await screen.findByAltText("Work by Ink Nova")) as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("https://img.example/nova.jpg");
    expect(screen.queryByText("IN")).toBeNull();
  });

  it("falls back to the monogram when there is no displayable image", async () => {
    storeState = { matches: [{ ...sampleMatch, heroImage: null }], hasHydrated: true };
    render(<SwipePage />);
    expect(await screen.findByText("IN")).toBeTruthy();
    expect(screen.queryByAltText(/work by/i)).toBeNull();
  });

  it("swaps to the monogram when the image fails to load", async () => {
    storeState = {
      matches: [{ ...sampleMatch, heroImage: "https://img.example/gone.jpg" }],
      hasHydrated: true,
    };
    render(<SwipePage />);
    fireEvent.error(await screen.findByAltText("Work by Ink Nova"));
    expect(screen.getByText("IN")).toBeTruthy();
    expect(screen.queryByAltText(/work by/i)).toBeNull();
  });

  it("links to the artist profile in a new tab and shows city only (no distance)", async () => {
    storeState = { matches: [sampleMatch], hasHydrated: true };
    render(<SwipePage />);
    const link = await screen.findByRole("link", { name: /view profile/i });
    expect(link.getAttribute("href")).toBe("/artists/ink-nova--a1");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener");
    expect(screen.getByText("LA")).toBeTruthy();
    expect(screen.queryByText(/mi away/i)).toBeNull();
    expect(screen.getByText("← pass · → pin · ↑ profile · Z undo")).toBeTruthy();
  });

  it("answers the keyboard shortcuts: ← pass, → pin, ↑ profile", async () => {
    storeState = { matches: [sampleMatch, secondMatch], hasHydrated: true };
    const open = vi.fn();
    vi.stubGlobal("open", open);
    render(<SwipePage />);
    await screen.findByText("Needle Ray");
    fireEvent.keyDown(window, { key: "ArrowUp" });
    expect(open).toHaveBeenCalledWith("/artists/needle-ray--a2", "_blank", "noopener");
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(record).toHaveBeenCalledWith("a2", "pin", null);
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(record).toHaveBeenCalledWith("a1", "pass", null);
    expect(await screen.findByText("Deck complete")).toBeTruthy();
    vi.unstubAllGlobals();
  });
});

describe("SwipePage undo (spec 14)", () => {
  beforeEach(() => {
    push.mockClear();
    searchParams = new URLSearchParams();
    storeState = { matches: [sampleMatch, secondMatch], hasHydrated: true };
  });

  it("brings the last card back, unpins it and removes the server decision", async () => {
    render(<SwipePage />);
    const pins = await screen.findAllByRole("button", { name: /^pin$/i });
    fireEvent.click(pins[pins.length - 1]);
    expect(screen.queryByText("Needle Ray")).toBeNull();
    expect(screen.getByText("1")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /^undo$/i }));
    expect(screen.getByText("Needle Ray")).toBeTruthy();
    expect(remove).toHaveBeenCalledWith("a2");
    expect(screen.getByText("0")).toBeTruthy();
    // One step only.
    expect((screen.getByRole("button", { name: /^undo$/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("returns to the last card from the Deck complete screen, not the interstitial", async () => {
    render(<SwipePage />);
    const passes = await screen.findAllByRole("button", { name: /^pass$/i });
    fireEvent.click(passes[passes.length - 1]);
    fireEvent.click(screen.getByRole("button", { name: /^pass$/i }));
    expect(screen.getByText("Deck complete")).toBeTruthy();
    fireEvent.keyDown(window, { key: "z" });
    expect(screen.getByText("Ink Nova")).toBeTruthy();
    expect(screen.queryByText("Deck complete")).toBeNull();
    expect(remove).toHaveBeenCalledWith("a1");
  });
});

const nearMatch: ArtistMatch = {
  artistId: "b1",
  artistName: "Near Miss",
  matchScore: 40,
  tags: [],
  styles: ["fine line"],
  deck: "broadened",
};

describe("SwipePage second deck (spec 14)", () => {
  beforeEach(() => {
    push.mockClear();
    searchParams = new URLSearchParams();
  });

  it("offers the broadened deck after the main deck and renders it with the reason line", async () => {
    storeState = { matches: [sampleMatch], broadened: [nearMatch], hasHydrated: true };
    render(<SwipePage />);
    fireEvent.click(await screen.findByRole("button", { name: /^pin$/i }));
    expect(screen.getByText("Deck complete")).toBeTruthy();
    expect(screen.getByText(/1 more artist near your filters/i)).toBeTruthy();
    expect(screen.queryByText("Near Miss")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /see close matches/i }));
    expect(screen.getByText("Near Miss")).toBeTruthy();
    expect(screen.getByText(/Close to what/)).toBeTruthy();
    expect(screen.getByText(/fewer than a handful of exact matches/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /^pin$/i }));
    expect(record).toHaveBeenCalledWith("b1", "pin", null);
    expect(screen.getByText("2 pinned")).toBeTruthy();
    expect(screen.getAllByRole("link", { name: /book/i })).toHaveLength(2);
  });

  it("goes straight to the alternatives when the primary deck is empty", async () => {
    storeState = { matches: [], broadened: [nearMatch], hasHydrated: true };
    render(<SwipePage />);
    expect(await screen.findByText("Near Miss")).toBeTruthy();
    expect(screen.getByText(/fewer than a handful of exact matches/i)).toBeTruthy();
    expect(screen.queryByText(/No deck/i)).toBeNull();
  });

  it("hydrates decisions across both decks and de-dupes by id", async () => {
    storeState = {
      matches: [sampleMatch],
      broadened: [nearMatch, { ...sampleMatch, deck: "broadened" }],
      hasHydrated: true,
    };
    fetchDecisions.mockResolvedValue([{ artistId: "b1", decision: "pin", dsId: null, updatedAt: 1 }]);
    render(<SwipePage />);
    fireEvent.click(await screen.findByRole("button", { name: /^pass$/i }));
    expect(screen.getByText("Deck complete")).toBeTruthy();
    // b1 was already pinned on the server: nothing left in the second deck.
    expect(screen.queryByText(/see close matches/i)).toBeNull();
    expect(screen.getByText("1 pinned")).toBeTruthy();
  });
});
