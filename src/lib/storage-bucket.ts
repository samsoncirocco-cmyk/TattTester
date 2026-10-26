/**
 * One bucket chain for every storage path.
 *
 * Generated images were written from `GCP_STORAGE_BUCKET` while signed URLs
 * were minted from `GCS_BUCKET_NAME`. When only the first was set, refine
 * rounds signed a bucket the object was not in and the provider 404'd
 * (#390). Both sides now ask this function, in this order, so deleting
 * `GCS_BUCKET_NAME` cannot point the signer somewhere else.
 *
 * A cut that already lives in a different bucket is not this function's
 * problem: its public URL names the bucket, and the signer follows that
 * (see `parseGcsObjectUrl`).
 */
const DEFAULT_BUCKET = 'tatt-pro-assets';

/** GCS bucket names: 3–63 chars, start and end alphanumeric. */
const BUCKET_NAME_RE = /^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/;

export function configuredStorageBucket(): string {
  const configured = [
    process.env.GCP_STORAGE_BUCKET,
    process.env.GCS_BUCKET_NAME,
    process.env.GCS_BUCKET,
    process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  ].find((value) => typeof value === 'string' && value.trim().length > 0);
  return configured?.trim() || DEFAULT_BUCKET;
}

/**
 * Split a public `storage.googleapis.com` object URL into the bucket and
 * object path it names. Anything else — a signed URL, a provider host, a
 * bucket name that is not a bucket name — is undefined, so a caller never
 * signs a path it did not parse.
 */
export function parseGcsObjectUrl(
  imageUrl: string | undefined
): { bucket: string; path: string } | undefined {
  if (!imageUrl) return undefined;
  let url: URL;
  try {
    url = new URL(imageUrl);
  } catch {
    return undefined;
  }
  if (url.hostname !== 'storage.googleapis.com') return undefined;

  const parts = url.pathname.split('/').filter((part) => part.length > 0);
  if (parts.length < 2) return undefined;
  const bucket = parts[0];
  if (!BUCKET_NAME_RE.test(bucket)) return undefined;

  let path: string;
  try {
    path = decodeURIComponent(parts.slice(1).join('/'));
  } catch {
    return undefined;
  }
  if (!path) return undefined;
  return { bucket, path };
}
