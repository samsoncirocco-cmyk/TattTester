// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { useMatchStore } from "./useMatchStore";

describe("useMatchStore hydration", () => {
  beforeEach(() => {
    localStorage.clear();
    useMatchStore.setState({
      matches: [],
      broadened: [],
      broadenedReason: null,
      currentMatchId: null,
      isLoading: false,
      error: null,
      lastUpdated: null,
      hasHydrated: false,
    });
  });

  it("starts unhydrated with an empty matches array", () => {
    const { matches, hasHydrated } = useMatchStore.getState();
    expect(hasHydrated).toBe(false);
    expect(matches).toEqual([]);
  });

  it("marks hasHydrated after persist rehydration finishes", async () => {
    localStorage.setItem(
      "tatt-match-storage",
      JSON.stringify({
        state: {
          matches: [
            {
              artistId: "a1",
              artistName: "Ink Nova",
              matchScore: 90,
              tags: ["neo-trad"],
            },
          ],
          currentMatchId: null,
          lastUpdated: 1,
        },
        version: 0,
      }),
    );

    await useMatchStore.persist.rehydrate();

    const { matches, hasHydrated } = useMatchStore.getState();
    expect(hasHydrated).toBe(true);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.artistName).toBe("Ink Nova");
  });

  it("marks hasHydrated even when storage is empty", async () => {
    await useMatchStore.persist.rehydrate();
    expect(useMatchStore.getState().hasHydrated).toBe(true);
    expect(useMatchStore.getState().matches).toEqual([]);
  });

  it("does not persist the hasHydrated flag", async () => {
    useMatchStore.setState({ hasHydrated: true });
    useMatchStore.getState().setMatches([
      {
        artistId: "a1",
        artistName: "Ink Nova",
        matchScore: 80,
        tags: [],
      },
    ]);

    // Give persist a tick to write
    await Promise.resolve();

    const raw = localStorage.getItem("tatt-match-storage");
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!);
    expect(parsed.state.hasHydrated).toBeUndefined();
    expect(parsed.state.matches).toHaveLength(1);
  });
});

describe("useMatchStore second deck (spec 14)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("migrates a v0 persisted deck to one with no alternatives", async () => {
    localStorage.setItem(
      "tatt-match-storage",
      JSON.stringify({
        state: {
          matches: [{ artistId: "a1", artistName: "Ink Nova", matchScore: 90, tags: [] }],
          currentMatchId: null,
          lastUpdated: 1,
        },
        version: 0,
      }),
    );
    await useMatchStore.persist.rehydrate();
    const { matches, broadened, broadenedReason, hasHydrated } = useMatchStore.getState();
    expect(hasHydrated).toBe(true);
    expect(matches).toHaveLength(1);
    expect(broadened).toEqual([]);
    expect(broadenedReason).toBeNull();
  });

  it("persists the second deck and its reason, and clears both with the primary deck", async () => {
    useMatchStore.setState({ hasHydrated: true });
    useMatchStore.getState().setMatches([
      { artistId: "a1", artistName: "Ink Nova", matchScore: 80, tags: [] },
    ]);
    useMatchStore.getState().setBroadened(
      [{ artistId: "b1", artistName: "Near Miss", matchScore: 40, tags: [], deck: "broadened" }],
      "fewer than a handful of exact matches",
    );
    await Promise.resolve();
    const parsed = JSON.parse(localStorage.getItem("tatt-match-storage")!);
    expect(parsed.version).toBe(1);
    expect(parsed.state.broadened).toHaveLength(1);
    expect(parsed.state.broadenedReason).toBe("fewer than a handful of exact matches");

    useMatchStore.getState().clearMatches();
    expect(useMatchStore.getState().broadened).toEqual([]);
    expect(useMatchStore.getState().broadenedReason).toBeNull();
  });

  it("drops the reason when the alternatives list is empty", () => {
    useMatchStore.getState().setBroadened([], "stale reason");
    expect(useMatchStore.getState().broadenedReason).toBeNull();
  });
});
