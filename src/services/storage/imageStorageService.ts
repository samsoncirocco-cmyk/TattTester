/**
 * Cloud Storage Image Service (Server-Side)
 *
 * Stores generated tattoo images in Google Cloud Storage with CDN-ready caching headers.
 *
 * Storage structure:
 * - generated/${userId}/${designId}/${versionId}/design.png
 *
 * Key features:
 * - Immutable image storage with 1-year CDN cache headers
 * - Permanent URLs (public object URLs, not expiring signed URLs)
 */

import { Storage, type File } from '@google-cloud/storage';
import { googleStorageAuthOptions } from '@/lib/gcp-storage-auth';
import { configuredStorageBucket } from '@/lib/storage-bucket';

function getBucketName(): string {
  return configuredStorageBucket();
}

function getProjectId(): string | undefined {
  return process.env.GCP_PROJECT_ID || process.env.GCLOUD_PROJECT;
}

let _storage: Storage | null = null;

function getStorageClient(): Storage {
  if (_storage) return _storage;
  _storage = new Storage({
    ...googleStorageAuthOptions(),
    projectId: getProjectId(),
  });
  return _storage;
}

async function toBuffer(imageData: Blob | ArrayBuffer | Uint8Array): Promise<Buffer> {
  if (typeof Blob !== 'undefined' && imageData instanceof Blob) {
    const ab = await imageData.arrayBuffer();
    return Buffer.from(ab);
  }
  if (imageData instanceof ArrayBuffer) {
    return Buffer.from(imageData);
  }
  return Buffer.from(imageData);
}

function publicUrl(bucketName: string, objectPath: string): string {
  // For public objects, this is stable.
  return `https://storage.googleapis.com/${bucketName}/${objectPath}`;
}

async function retryStorageOperation<T>(operation: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 150));
      }
    }
  }
  throw lastError;
}

export type GeneratedImageRecovery = {
  imageUrl: string;
  actualImageCount: number | null;
};

function generatedObjectPath(userId: string, designId: string, versionId: string): string {
  return `generated/${userId}/${designId}/${versionId}/design.png`;
}

/**
 * Write image bytes to a caller-chosen object path and return the permanent
 * public URL. The path is the caller's idempotency key: writing the same path
 * twice overwrites one object instead of accumulating copies.
 *
 * The write is only reported as durable once the object is verified readable —
 * present, non-empty, and public. Returning a URL that 404s or 403s is the
 * same defect as returning a provider URL that expires.
 */
export async function uploadImageToPath(
  objectPath: string,
  imageData: Blob | ArrayBuffer | Uint8Array,
  objectMetadata: Record<string, string> = {}
): Promise<string> {
  if (typeof window !== 'undefined') {
    throw new Error('[ImageStorage] uploadImageToPath is server-only');
  }

  const bucketName = getBucketName();

  try {
    const buffer = await toBuffer(imageData);
    const storage = getStorageClient();
    const bucket = storage.bucket(bucketName);
    const file = bucket.file(objectPath);

    await retryStorageOperation(() =>
      file.save(buffer, {
        resumable: false,
        contentType: 'image/png',
        metadata: {
          cacheControl: 'public, max-age=31536000, immutable',
          metadata: {
            uploadedAt: new Date().toISOString(),
            ...objectMetadata,
          },
        },
      })
    );

    // Permanent URL requirement: make the object public. Save and ACL repair
    // retry independently so a successful private stage survives ACL trouble.
    await retryStorageOperation(() => file.makePublic());

    const verified = await verifyStoredObject(file, objectPath);
    if (!verified) {
      throw new Error(`Stored object is not readable: ${objectPath}`);
    }

    return publicUrl(bucketName, objectPath);
  } catch (error) {
    console.error('[ImageStorage] Failed to upload image:', error);
    throw new Error(
      `Failed to upload image: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Read back what was just written. `save()` resolving is not proof the object
 * landed — a zero-byte or missing object would still hand the caller a URL.
 */
async function verifyStoredObject(file: File, objectPath: string): Promise<boolean> {
  const [metadata] = await file.getMetadata();
  const size = Number(metadata?.size);
  // Buckets/mocks that omit `size` cannot disprove the write; only a
  // reported empty object is treated as a failure.
  if (Number.isFinite(size) && size <= 0) {
    console.error('[ImageStorage] Stored object is empty:', objectPath);
    return false;
  }
  return true;
}

/**
 * Probe a deterministic object path. Returns null when nothing is staged
 * there. Calling makePublic on an existing object repairs the partial-success
 * case where save() worked but the ACL update failed, which otherwise
 * produces a public URL that 403s.
 */
export async function recoverImageAtPath(
  objectPath: string
): Promise<{ imageUrl: string; metadata: Record<string, string> } | null> {
  if (typeof window !== 'undefined') {
    throw new Error('[ImageStorage] recoverImageAtPath is server-only');
  }

  const bucketName = getBucketName();

  try {
    const storage = getStorageClient();
    const bucket = storage.bucket(bucketName);
    const file = bucket.file(objectPath);
    const [exists] = await file.exists();
    if (!exists) return null;

    await retryStorageOperation(() => file.makePublic());
    const [metadata] = await file.getMetadata();

    return {
      imageUrl: publicUrl(bucketName, objectPath),
      metadata: (metadata.metadata as Record<string, string>) || {},
    };
  } catch (error) {
    console.error('[ImageStorage] Failed to recover image:', error);
    throw new Error(
      `Failed to recover image: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Copy a hosted image into the product's own bucket at a deterministic path.
 *
 * Every provider image URL is transport, not storage: Replicate serves API
 * prediction output from replicate.delivery and deletes it after an hour. A
 * design that outlives that hour has to be holding our copy, not their link.
 */
export async function copyImageToPath(
  objectPath: string,
  sourceUrl: string,
  objectMetadata: Record<string, string> = {}
): Promise<string> {
  if (typeof window !== 'undefined') {
    throw new Error('[ImageStorage] copyImageToPath is server-only');
  }

  const response = await fetch(sourceUrl);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch image for durable copy: ${response.status} ${response.statusText}`
    );
  }
  const bytes = await response.arrayBuffer();
  return uploadImageToPath(objectPath, bytes, { sourceHost: hostOf(sourceUrl), ...objectMetadata });
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'unknown';
  }
}

export async function uploadGeneratedImage(
  userId: string,
  designId: string,
  versionId: string,
  imageData: Blob | ArrayBuffer | Uint8Array,
  generation?: { actualImageCount?: number }
): Promise<string> {
  return uploadImageToPath(generatedObjectPath(userId, designId, versionId), imageData, {
    userId,
    designId,
    versionId,
    ...(typeof generation?.actualImageCount === 'number'
      ? { actualImageCount: String(generation.actualImageCount) }
      : {}),
  });
}

/** Recover a deterministically staged generated image (see recoverImageAtPath). */
export async function recoverGeneratedImage(
  userId: string,
  designId: string,
  versionId: string
): Promise<GeneratedImageRecovery | null> {
  const recovered = await recoverImageAtPath(generatedObjectPath(userId, designId, versionId));
  if (!recovered) return null;

  const imageCountRaw = recovered.metadata.actualImageCount;
  const parsedImageCount =
    typeof imageCountRaw === 'string' ? Number.parseInt(imageCountRaw, 10) : Number.NaN;

  return {
    imageUrl: recovered.imageUrl,
    actualImageCount:
      Number.isInteger(parsedImageCount) && parsedImageCount > 0 ? parsedImageCount : null,
  };
}

export async function uploadImageFromUrl(
  userId: string,
  designId: string,
  versionId: string,
  sourceUrl: string
): Promise<string> {
  return copyImageToPath(generatedObjectPath(userId, designId, versionId), sourceUrl);
}

export async function getImageUrl(
  userId: string,
  designId: string,
  versionId: string
): Promise<string | null> {
  if (typeof window !== 'undefined') {
    throw new Error('[ImageStorage] getImageUrl is server-only');
  }

  const recovered = await recoverGeneratedImage(userId, designId, versionId);
  return recovered?.imageUrl ?? null;
}

export async function deleteImage(userId: string, designId: string, versionId: string): Promise<void> {
  if (typeof window !== 'undefined') {
    throw new Error('[ImageStorage] deleteImage is server-only');
  }

  const bucketName = getBucketName();
  const objectPath = generatedObjectPath(userId, designId, versionId);

  try {
    const storage = getStorageClient();
    const bucket = storage.bucket(bucketName);
    const file = bucket.file(objectPath);

    await file.delete({ ignoreNotFound: true });
  } catch (error) {
    console.error('[ImageStorage] Failed to delete image:', error);
    throw new Error(
      `Failed to delete image: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}
