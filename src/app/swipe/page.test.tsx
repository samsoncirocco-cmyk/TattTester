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
