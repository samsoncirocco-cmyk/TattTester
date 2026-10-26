/**
 * Firestore storage for artist-written policies, FAQ and travel dates
 * (spec 16): `artist_profile_extras/{artistId}`, server only (firebase-admin;
 * denied to clients in firestore.rules).
 *
 * Firestore rather than Neo4j node properties (spec 16 open question 1,
 * recommendation taken): structured lists that the matcher never queries do
 * not belong on the graph node, and this needs no graph migration.
 *
 * THE HONESTY RULE lives here as well as on the page: `readClaimedArtistExtras`
 * returns nothing for an unclaimed artist and does not even read the doc, so a
 * value left behind by a revoked claim can never render.
 */
import { ensureAdminApp } from "./firebase-admin";
import {
  EMPTY_EXTRAS,
  normalizeStoredExtras,
  type ArtistProfileExtras,
} from "./artist-profile-extras";

export const EXTRAS_COLLECTION = "artist_profile_extras";

async function collection() {
  if (!ensureAdminApp()) return null;
  const { getFirestore } = await import("firebase-admin/firestore");
  return getFirestore().collection(EXTRAS_COLLECTION);
}

/** The artist's own read (editor). Throws on a store failure so the editor can say so. */
export async function readArtistExtras(artistId: string): Promise<ArtistProfileExtras> {
  const col = await collection();
  if (!col) return EMPTY_EXTRAS;
  const snap = await col.doc(artistId).get();
  return snap.exists ? normalizeStoredExtras(snap.data()) : EMPTY_EXTRAS;
}

/**
 * The public read. Unclaimed → undefined without touching the store. Any
 * failure → undefined: the profile renders without the block rather than
 * failing.
 */
export async function readClaimedArtistExtras(artist: {
  id: string;
  claimed: boolean;
}): Promise<ArtistProfileExtras | undefined> {
  if (!artist.claimed) return undefined;
  try {
    return await readArtistExtras(artist.id);
  } catch (err) {
    console.warn(
      `[profile-extras] read failed for ${artist.id}:`,
      err instanceof Error ? err.message : err,
    );
    return undefined;
  }
}

/** Replace the given groups (merge at the group level). Throws on failure. */
export async function writeArtistExtras(
  artistId: string,
  patch: Partial<ArtistProfileExtras>,
  editedByUid: string,
): Promise<ArtistProfileExtras> {
  const col = await collection();
  if (!col) throw new Error("Profile extras store is not configured.");
  await col.doc(artistId).set(
    { ...patch, updatedAtEpochMs: Date.now(), updatedByUid: editedByUid },
    { merge: true },
  );
  return readArtistExtras(artistId);
}
