// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import SmartMatchClient from "./SmartMatchClient";

const push = vi.fn();
let searchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  useSearchParams: () => searchParams,
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

vi.mock("@/lib/client-api-auth", () => ({
  getApiAuthHeaders: vi.fn(async () => ({ Authorization: "Bearer test-token" })),
}));

let savedStylePreferences: string[] = [];
vi.mock("@/lib/tattStorage", () => ({
  useStylePreferences: () => ({
    stylePreferences: savedStylePreferences,
    hydrated: true,
  }),
}));

const setMatches = vi.fn();
const setBroadened = vi.fn();
vi.mock("@/store/useMatchStore", () => ({
  useMatchStore: (
    selector: (s: { setMatches: typeof setMatches; setBroadened: typeof setBroadened }) => unknown
  ) => selector({ setMatches, setBroadened }),
}));

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as Response;
}

const completeSessionEnvelope = {
  success: true,
  session: {
    id: "sess-1",
    phase: "complete",
    brief: {
      placement: "inner forearm",
      // fine-line + blackwork map to canonical pills; surrealism is
      // explicitly unmapped and must be dropped, not guessed at.
      styleTags: ["fine-line", "blackwork", "surrealism"],
      meaning: "strength after a rough year",
      references: [],
      axisSelection: { mode: "compositional", axes: [], rationale: "resolved" },
      placementNotes: [],
    },
  },
};

const liveMatchResponse = {
  success: true,
  query_info: { graphSource: "live" },
  matches: [
    { id: "a1", name: "Ink Nova", score: 88, styles: ["Fine Line"], location: "LA" },
  ],
};

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  push.mockClear();
  setMatches.mockClear();
  setBroadened.mockClear();
  searchParams = new URLSearchParams();
  savedStylePreferences = [];
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("SmartMatchClient design-session prefill", () => {
  it("loads the brief, pre-selects mapped pills, enriches the query, auto-runs, and threads ds to /swipe", async () => {
    searchParams = new URLSearchParams("ds=sess-1");
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).startsWith("/api/v1/design-session/")) {
        return jsonResponse(completeSessionEnvelope);
      }
      if (String(url) === "/api/v1/match/semantic") {
        return jsonResponse(liveMatchResponse);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<SmartMatchClient />);

    await waitFor(() => expect(push).toHaveBeenCalledWith("/swipe?ds=sess-1"));

    // Session fetched with auth, per the frozen contract path.
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/design-session/sess-1",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer test-token" }),
      })
    );

    // Auto-run search body: mapped canonical styles + brief-enriched query.
    const matchCall = fetchMock.mock.calls.find(
      ([url]) => String(url) === "/api/v1/match/semantic"
    );
    expect(matchCall).toBeTruthy();
    const body = JSON.parse((matchCall![1] as RequestInit).body as string);
    expect(body.style_preferences).toEqual(["Fine Line", "Blackwork"]);
    expect(body.query).toContain("inner forearm");
    expect(body.query).toContain("strength after a rough year");
    expect(body.query).toContain("Fine Line");

    // Pills pre-selected (and the unmapped tag dropped, not guessed).
    expect(
      screen.getByRole("button", { name: "Fine Line" }).getAttribute("aria-pressed")
    ).toBe("true");
    expect(
      screen.getByRole("button", { name: "Blackwork" }).getAttribute("aria-pressed")
    ).toBe("true");
    expect(
      screen.getByRole("button", { name: "Realism" }).getAttribute("aria-pressed")
    ).toBe("false");

    // Results landed in the store for /swipe.
    expect(setMatches).toHaveBeenCalledWith([
      expect.objectContaining({ artistId: "a1", artistName: "Ink Nova" }),
    ]);
  });

  it("keeps the brief context when the user edits and re-runs", async () => {
    searchParams = new URLSearchParams("ds=sess-1");
    // Auto-run finds nothing (error state re-enables the form — in the happy
    // path the page navigates away); the user's edited re-run then succeeds.
    let matchCallCount = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).startsWith("/api/v1/design-session/")) {
        return jsonResponse(completeSessionEnvelope);
      }
      matchCallCount += 1;
      return matchCallCount === 1
        ? jsonResponse({ success: true, query_info: { graphSource: "live" }, matches: [] })
        : jsonResponse(liveMatchResponse);
    });

    render(<SmartMatchClient />);
    await screen.findByText(/no artists match that combination yet/i);

    // User adds a style and re-runs manually.
    fireEvent.click(screen.getByRole("button", { name: "Realism" }));
    fireEvent.click(screen.getByRole("button", { name: /find artists/i }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/swipe?ds=sess-1"));
    const matchCalls = fetchMock.mock.calls.filter(
      ([url]) => String(url) === "/api/v1/match/semantic"
    );
    expect(matchCalls).toHaveLength(2);
    const body = JSON.parse((matchCalls[1][1] as RequestInit).body as string);
    expect(body.style_preferences).toEqual(["Fine Line", "Blackwork", "Realism"]);
    expect(body.query).toContain("inner forearm");
    expect(body.query).toContain("strength after a rough year");
  });

  it("falls back silently to the blank form when the session is missing", async () => {
    searchParams = new URLSearchParams("ds=sess-gone");
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).startsWith("/api/v1/design-session/")) {
        return jsonResponse({ error: "Session not found" }, false, 404);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<SmartMatchClient />);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/v1/design-session/sess-gone",
        expect.anything()
      )
    );

    // No auto-search, no navigation, no error surfaced — just the blank form.
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url) === "/api/v1/match/semantic")
    ).toHaveLength(0);
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /find artists/i })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Fine Line" }).getAttribute("aria-pressed")
    ).toBe("false");
    expect(screen.queryByText(/unreachable|failed|not found/i)).toBeNull();
  });

  it("falls back silently when the session fetch throws", async () => {
    searchParams = new URLSearchParams("ds=sess-err");
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).startsWith("/api/v1/design-session/")) {
        throw new Error("network down");
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<SmartMatchClient />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /find artists/i })).toBeTruthy();
  });

  it("pre-selects pills from a ?styles= signal without auto-running", async () => {
    searchParams = new URLSearchParams("styles=Traditional,Blackwork,not-a-style");
    fetchMock.mockImplementation(async () => jsonResponse(liveMatchResponse));

    render(<SmartMatchClient />);

    // Valid styles land pressed; garbage is dropped, nothing fetched or pushed.
    expect(
      screen.getByRole("button", { name: "Traditional" }).getAttribute("aria-pressed")
    ).toBe("true");
    expect(
      screen.getByRole("button", { name: "Blackwork" }).getAttribute("aria-pressed")
    ).toBe("true");
    expect(
      screen.getByRole("button", { name: "Realism" }).getAttribute("aria-pressed")
    ).toBe("false");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();

    // The user still owns the search — submitting uses the pre-selected pills.
    fireEvent.click(screen.getByRole("button", { name: /find artists/i }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/swipe"));
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.style_preferences).toEqual(["Traditional", "Blackwork"]);
  });

  it("derives reason chips from the payload against what the user asked for", async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse({
        success: true,
        query_info: { graphSource: "live" },
        matches: [
          {
            id: "a2",
            name: "Iron Quill",
            score: 91,
            styles: ["Blackwork", "Minimalist"],
            city: "Austin",
            location: "Austin, TX",
            rating: 4.8,
            reviewCount: 120,
          },
        ],
      })
    );

    render(<SmartMatchClient />);
    fireEvent.click(screen.getByRole("button", { name: "Blackwork" }));
    fireEvent.change(screen.getByLabelText(/location/i), {
      target: { value: "Austin" },
    });
    fireEvent.click(screen.getByRole("button", { name: /find artists/i }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/swipe"));
    expect(setMatches).toHaveBeenCalledWith([
      expect.objectContaining({
        artistId: "a2",
        reasonChips: [
          "Blackwork — your pick",
          "Austin — near you",
          "Shop 4.8★, 120 reviews",
        ],
      }),
    ]);
  });

  it("fabricates no chips from a sparse payload", async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse({
        success: true,
        query_info: { graphSource: "live" },
        matches: [
          // Style only — one honest chip, nothing padded.
          { id: "a3", name: "Bare Data", score: 70, styles: ["Blackwork"] },
          // Nothing derivable at all — zero chips, never invented ones.
          { id: "a4", name: "No Data", score: 65 },
        ],
      })
    );

    render(<SmartMatchClient />);
    fireEvent.click(screen.getByRole("button", { name: "Blackwork" }));
    fireEvent.change(screen.getByLabelText(/location/i), {
      target: { value: "Austin" },
    });
    fireEvent.click(screen.getByRole("button", { name: /find artists/i }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/swipe"));
    expect(setMatches).toHaveBeenCalledWith([
      expect.objectContaining({
        artistId: "a3",
        reasonChips: ["Blackwork — your pick"],
      }),
      expect.objectContaining({ artistId: "a4", reasonChips: [] }),
    ]);
  });

  it("does not touch the design-session API without a ds param", async () => {
    fetchMock.mockImplementation(async () => jsonResponse(liveMatchResponse));

    render(<SmartMatchClient />);

    // Manual search still works and routes to plain /swipe.
    fireEvent.click(screen.getByRole("button", { name: "Blackwork" }));
    fireEvent.click(screen.getByRole("button", { name: /find artists/i }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/swipe"));

    expect(
      fetchMock.mock.calls.filter(([url]) =>
        String(url).startsWith("/api/v1/design-session/")
      )
    ).toHaveLength(0);
  });

  it("prefills a sessionless search from the customer's saved taste", async () => {
    savedStylePreferences = ["Fine Line", "Blackwork", "not-a-style"];
    fetchMock.mockImplementation(async () => jsonResponse(liveMatchResponse));

    render(<SmartMatchClient />);

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Fine Line" }).getAttribute("aria-pressed"),
      ).toBe("true"),
    );
    expect(
      screen.getByRole("button", { name: "Blackwork" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.getByText(/saved taste is already dialed in/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /find artists/i }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/swipe"));
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.style_preferences).toEqual(["Fine Line", "Blackwork"]);
  });

  it("treats an empty ?styles= handoff as explicit instead of restoring saved taste", () => {
    searchParams = new URLSearchParams("styles=");
    savedStylePreferences = ["Fine Line"];

    render(<SmartMatchClient />);

    expect(
      screen.getByRole("button", { name: "Fine Line" }).getAttribute("aria-pressed"),
    ).toBe("false");
    expect(screen.queryByText(/saved taste is already dialed in/i)).toBeNull();
  });

  it("does not claim invalid saved values were applied", () => {
    savedStylePreferences = ["not-a-style"];

    render(<SmartMatchClient />);

    expect(screen.queryByText(/saved taste is already dialed in/i)).toBeNull();
    expect(
      screen.getByRole("button", { name: "Fine Line" }).getAttribute("aria-pressed"),
    ).toBe("false");
  });
});

describe("SmartMatchClient second deck (spec 14)", () => {
  it("maps broadened results with the same shape as primary ones and stores them apart", async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse({
        success: true,
        query_info: { graphSource: "live" },
        matches: [
          { id: "a1", name: "Ink Nova", score: 88, styles: ["Blackwork"], heroImage: "https://img/a1.jpg" },
        ],
        broadened: [
          { id: "b1", name: "Near Miss", score: 40, styles: ["Fine Line"], heroImage: null },
          // Server already excludes primary ids; the client de-dupes too.
          { id: "a1", name: "Ink Nova", score: 88, styles: ["Blackwork"] },
        ],
        broadened_reason: "Also nearby / similar — fewer than a handful of exact matches for your filters",
      })
    );
    render(<SmartMatchClient />);
    fireEvent.click(screen.getByRole("button", { name: "Blackwork" }));
    fireEvent.click(screen.getByRole("button", { name: /find artists/i }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/swipe"));

    expect(setMatches).toHaveBeenCalledWith([
      expect.objectContaining({ artistId: "a1", deck: "primary", heroImage: "https://img/a1.jpg" }),
    ]);
    expect(setBroadened).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          artistId: "b1",
          artistName: "Near Miss",
          deck: "broadened",
          heroImage: null,
          reasonChips: expect.any(Array),
        }),
      ],
      "Also nearby / similar — fewer than a handful of exact matches for your filters"
    );
  });

  it("goes straight to the alternatives deck when the primary set is empty but near-matches exist", async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse({
        success: true,
        query_info: { graphSource: "live" },
        matches: [],
        broadened: [{ id: "b1", name: "Near Miss", score: 40 }],
        broadened_reason: "fewer than a handful",
      })
    );
    render(<SmartMatchClient />);
    fireEvent.click(screen.getByRole("button", { name: /find artists/i }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/swipe"));
    expect(setMatches).toHaveBeenCalledWith([]);
    expect(setBroadened).toHaveBeenCalledWith(
      [expect.objectContaining({ artistId: "b1" })],
      "fewer than a handful"
    );
    expect(screen.queryByText(/no artists match/i)).toBeNull();
  });

  it("keeps the empty-state message when both decks are empty", async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse({ success: true, query_info: { graphSource: "live" }, matches: [], broadened: [] })
    );
    render(<SmartMatchClient />);
    fireEvent.click(screen.getByRole("button", { name: /find artists/i }));
    await screen.findByText(/no artists match that combination yet/i);
    expect(push).not.toHaveBeenCalled();
    expect(setMatches).not.toHaveBeenCalled();
  });
});

describe("SmartMatchClient intent and rate pills (spec 15)", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/smart-match");
    fetchMock.mockImplementation(async () => jsonResponse(liveMatchResponse));
  });

  it("sends has_portfolio false and no budget by default", async () => {
    render(<SmartMatchClient />);
    fireEvent.click(screen.getByRole("button", { name: /find artists/i }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/swipe"));
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.has_portfolio).toBe(false);
    expect("budget" in body).toBe(false);
    expect("radius" in body).toBe(false);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("maps a big piece to has_portfolio and a rate pill to budget, says so, and keeps them in the URL", async () => {
    render(<SmartMatchClient />);
    fireEvent.click(screen.getByRole("button", { name: "Big piece or sleeve" }));
    fireEvent.click(screen.getByRole("button", { name: "Up to $250/hr" }));
    expect(screen.getByRole("status").textContent).toBe(
      "Showing artists with portfolios. Rates are a guide — artists who haven't listed one are still shown."
    );
    expect(window.location.search).toBe("?intent=big&rate=250");

    fireEvent.click(screen.getByRole("button", { name: /find artists/i }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/swipe"));
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.has_portfolio).toBe(true);
    expect(body.budget).toBe(250);
  });

  it("restores the pills from URL params and ignores unknown values", () => {
    searchParams = new URLSearchParams("intent=coverup&rate=9999");
    render(<SmartMatchClient />);
    expect(
      screen.getByRole("button", { name: "Cover-up" }).getAttribute("aria-pressed")
    ).toBe("true");
    expect(
      screen.getByRole("button", { name: "No limit" }).getAttribute("aria-pressed")
    ).toBe("true");
  });

  it("leaves the pills untouched by a ?ds= prefill and sends them with the auto-run", async () => {
    searchParams = new URLSearchParams("ds=sess-1&intent=big");
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).startsWith("/api/v1/design-session/")) {
        return jsonResponse(completeSessionEnvelope);
      }
      return jsonResponse(liveMatchResponse);
    });
    render(<SmartMatchClient />);
    await waitFor(() => expect(push).toHaveBeenCalledWith("/swipe?ds=sess-1"));
    expect(
      screen.getByRole("button", { name: "Big piece or sleeve" }).getAttribute("aria-pressed")
    ).toBe("true");
    const matchCall = fetchMock.mock.calls.find(([url]) => String(url) === "/api/v1/match/semantic");
    const body = JSON.parse((matchCall![1] as RequestInit).body as string);
    expect(body.has_portfolio).toBe(true);
    expect(body.style_preferences).toEqual(["Fine Line", "Blackwork"]);
  });

  it("shows the route's validation message instead of a bare HTTP 400", async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse({ error: "budget must be a number between 1 and 2000 (dollars per hour).", code: "INVALID_PREFERENCES" }, false, 400)
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<SmartMatchClient />);
    fireEvent.click(screen.getByRole("button", { name: /find artists/i }));
    expect(await screen.findByText(/budget must be a number between 1 and 2000/i)).toBeTruthy();
    expect(screen.queryByText(/HTTP 400/)).toBeNull();
  });

  it("names the filters in play when a selection removes everyone", async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse({ success: true, query_info: { graphSource: "live" }, matches: [], broadened: [] })
    );
    render(<SmartMatchClient />);
    fireEvent.click(screen.getByRole("button", { name: "Cover-up" }));
    fireEvent.click(screen.getByRole("button", { name: "Up to $150/hr" }));
    fireEvent.click(screen.getByRole("button", { name: /find artists/i }));
    expect(
      await screen.findByText(/no artists match that combination yet \(with portfolios, up to \$150\/hr\)/i)
    ).toBeTruthy();
  });
});
