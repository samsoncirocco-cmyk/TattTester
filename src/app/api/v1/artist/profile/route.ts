/**
 * Read and edit the signed-in artist's own public profile.
 *
 * Identity is resolved from the verified Firebase uid and the human-approved
 * claim binding. The client never supplies artistId. Instagram is deliberately
 * immutable here because it is the identity anchor; hosted portfolio images
 * remain outside this endpoint until the licensed-media path in TAT-40 exists.
 *
 * Spec 16 adds three artist-written groups — `policies`, `faqs`,
 * `travelDates` — stored in Firestore (`artist_profile_extras/{artistId}`)
 * but edited here, through the same claim resolution, and recorded in
 * `artistManagedFields` like every other artist-owned field. The Neo4j write
 * runs first and re-checks ownership, so a revoked claim saves nothing.
 */
import { NextRequest, NextResponse } from 'next/server';
import { verifyApiAuth } from '@/lib/api-auth';
import { verifyFirebaseToken } from '@/lib/auth-dal';
import { getArtistByClaimedUid } from '@/lib/artist-stripe';
import { validateArtistProfilePatch } from '@/lib/artist-profile';
import { splitProfilePatch, validateExtrasPatch } from '@/lib/artist-profile-extras';
import { readArtistExtras, writeArtistExtras } from '@/lib/artist-profile-extras-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function runQuery(query: string, params: Record<string, unknown>, write = false) {
  const { getNeo4jDriver, NEO4J_DATABASE, NEO4J_QUERY_TIMEOUT } = await import('@/lib/neo4j');
  const neo4j = (await import('neo4j-driver')).default;
  const driver = getNeo4jDriver();
  if (!driver) throw new Error('Neo4j driver not configured.');
  const session = driver.session(NEO4J_DATABASE ? { database: NEO4J_DATABASE } : undefined);
  try {
    const execute = write ? session.executeWrite.bind(session) : session.executeRead.bind(session);
    const result = await execute(
      (tx: {
        run: (
          q: string,
          p: Record<string, unknown>,
        ) => Promise<{ records: Array<{ toObject(): Record<string, unknown> }> }>;
      }) => tx.run(query, params),
      { timeout: neo4j.int(NEO4J_QUERY_TIMEOUT) },
    );
    return result.records.map(
      (record: { toObject(): Record<string, unknown> }) => record.toObject(),
    );
  } finally {
    await session.close();
  }
}

async function resolveVerifiedArtist(req: NextRequest) {
  const user = await verifyFirebaseToken(req);
  if (!user?.uid) return null;
  return getArtistByClaimedUid(user.uid);
}

const PROFILE_RETURN = `a.id AS id, a.name AS name, a.shopName AS shopName,
  a.bio AS bio, a.bookingUrl AS bookingUrl, a.city AS city, a.state AS state,
  a.instagram AS instagram, a.artistManagedFields AS artistManagedFields,
  a.profileManagedAtEpochMs AS profileManagedAtEpochMs`;

export async function GET(req: NextRequest) {
  const authError = await verifyApiAuth(req);
  if (authError) return authError;
  const artist = await resolveVerifiedArtist(req);
  if (!artist) {
    return NextResponse.json(
      { error: 'No verified artist profile belongs to this account.', code: 'NO_VERIFIED_ARTIST' },
      { status: 403 },
    );
  }
  try {
    const rows = await runQuery(
      `MATCH (a:Artist {
         id: $artistId,
         claimedByUid: $uid,
         claimVerificationStatus: 'verified'
       })
       RETURN ${PROFILE_RETURN}`,
      { artistId: artist.id, uid: artist.claimedByUid },
    );
    if (!rows.length) throw new Error('Verified artist disappeared during lookup.');
    // Extras are additive: a store hiccup must not hide the rest of the profile.
    const extras = await readArtistExtras(artist.id).catch((err) => {
      console.warn('[artist/profile] extras read failed:', err);
      return null;
    });
    return NextResponse.json({ profile: rows[0], extras });
  } catch (err) {
    console.error('[artist/profile] read failed:', err);
    return NextResponse.json({ error: 'Could not read your profile.' }, { status: 503 });
  }
}

export async function PATCH(req: NextRequest) {
  const authError = await verifyApiAuth(req);
  if (authError) return authError;
  const artist = await resolveVerifiedArtist(req);
  if (!artist) {
    return NextResponse.json(
      { error: 'Identity review must finish before profile edits.', code: 'NO_VERIFIED_ARTIST' },
      { status: 403 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'Profile must be an object.' }, { status: 400 });
  }
  const { extras: extrasRaw, scalar } = splitProfilePatch(body as Record<string, unknown>);
  const extras = validateExtrasPatch(extrasRaw);
  if (!extras.ok) return NextResponse.json({ error: extras.error }, { status: 400 });
  const hasScalar = Object.keys(scalar).length > 0;
  const parsed = hasScalar
    ? validateArtistProfilePatch(scalar)
    : ({ ok: true, value: {}, fields: [] } as const);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  if (!parsed.fields.length && !extras.fields.length) {
    return NextResponse.json({ error: 'No editable profile fields were supplied.' }, { status: 400 });
  }

  const assignments = [
    ...parsed.fields.map((field) => `a.${field} = $${field}`),
    `a.artistManagedFields = reduce(
             fields = coalesce(a.artistManagedFields, []),
             field IN $managedFields |
               CASE WHEN field IN fields THEN fields ELSE fields + field END
           )`,
    'a.profileManagedAtEpochMs = timestamp()',
  ].join(',\n           ');
  try {
    const rows = await runQuery(
      `MATCH (a:Artist {
         id: $artistId,
         claimedByUid: $uid,
         claimVerificationStatus: 'verified'
       })
       SET ${assignments}
       RETURN ${PROFILE_RETURN}`,
      {
        artistId: artist.id,
        uid: artist.claimedByUid,
        ...parsed.value,
        managedFields: [...parsed.fields, ...extras.fields],
      },
      true,
    );
    if (!rows.length) {
      return NextResponse.json(
        { error: 'Ownership changed before the update; nothing was saved.' },
        { status: 409 },
      );
    }
    let savedExtras = null;
    if (extras.fields.length) {
      try {
        savedExtras = await writeArtistExtras(artist.id, extras.value, artist.claimedByUid ?? "");
      } catch (err) {
        console.error('[artist/profile] extras write failed:', err);
        return NextResponse.json(
          { error: 'Could not save your policies, questions or travel dates.' },
          { status: 503 },
        );
      }
    }
    return NextResponse.json({
      saved: true,
      profile: rows[0],
      ...(savedExtras ? { extras: savedExtras } : {}),
    });
  } catch (err) {
    console.error('[artist/profile] write failed:', err);
    return NextResponse.json({ error: 'Could not save your profile.' }, { status: 503 });
  }
}
