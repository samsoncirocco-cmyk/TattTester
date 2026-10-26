/**
 * Google Cloud Storage Service
 *
 * Handles all interactions with Google Cloud Storage for TatT Pro:
 * - Upload designs, layers, stencils, and portfolio images
 * - Generate signed URLs for secure, temporary access
 * - Delete files when no longer needed
 * - Manage folder structure and naming conventions
 */

import { Storage, Bucket, File } from '@google-cloud/storage';
import type { GetSignedUrlConfig, UploadOptions } from '@google-cloud/storage';
import { googleStorageAuthOptions } from '@/lib/gcp-storage-auth';
import { configuredStorageBucket } from '@/lib/storage-bucket';

// Type Definitions
export interface GCSUploadOptions {
    contentType?: string;
    metadata?: Record<string, any>;
    public?: boolean;
}

export interface GCSUploadResult {
    success: boolean;
    gcsPath: string;
    url: string;
    bucket: string;
    path: string;
    public: boolean;
}

export interface GCSFileMetadata {
    name: string;
    size: number;
    contentType: string;
    created: string;
    updated: string;
    metadata: Record<string, any>;
}

export interface GCSHealthStatus {
    healthy: boolean;
    bucket: string;
    location?: string;
    storageClass?: string;
    created?: string;
    error?: string;
}

export interface BatchDeleteResult {
    deleted: string[];
    failed: Array<{ filePath: string; error: string }>;
}

export interface DesignMetadata {
    userId?: string;
    style?: string;
    bodyPart?: string;
}

export interface LayerMetadata {
    userId?: string;
}

export interface StencilMetadata {
    userId?: string;
}

// Initialize Google Cloud Storage. Serverless has no credentials file —
// the service account lives in GOOGLE_APPLICATION_CREDENTIALS_JSON there
// (same variable google-auth-edge and the monitoring client read).
const storage = new Storage({
    ...googleStorageAuthOptions(),
    projectId: process.env.GCP_PROJECT_ID
});

/**
 * Bucket handle for one call. Read at call time, not import time: a name
 * resolved when the module loaded is how a later env fix never reached the
 * signer. `name` overrides the shared chain so a stored object URL can be
 * signed in the bucket it names (#390).
 */
function bucketHandle(name?: string): { name: string; bucket: Bucket } {
    const resolved = name && name.trim() ? name.trim() : configuredStorageBucket();
    return { name: resolved, bucket: storage.bucket(resolved) };
}

/**
 * The bucket this module writes and, by default, signs. Same chain as
 * imageStorageService — see `configuredStorageBucket`. Callers that already
 * hold a public object URL should pass that URL's bucket into
 * `getSignedUrl` instead of comparing against this name.
 */
export function signingBucketName(): string {
    return configuredStorageBucket();
}
const signedUrlExpiry = parseInt(process.env.GCS_SIGNED_URL_EXPIRY || '3600', 10);

/**
 * Upload file to Google Cloud Storage
 */
export async function uploadToGCS(
    fileData: Buffer | string,
    destinationPath: string,
    options: GCSUploadOptions = {}
): Promise<GCSUploadResult> {
    try {
        const {
            contentType = 'image/png',
            metadata = {},
            public: isPublic = false
        } = options;

        const { name: bucketName, bucket } = bucketHandle();
        const file: File = bucket.file(destinationPath);

        // Upload file
        if (typeof fileData === 'string') {
            // Local file path
            await bucket.upload(fileData, {
                destination: destinationPath,
                metadata: {
                    contentType,
                    metadata: {
                        uploadedAt: new Date().toISOString(),
                        ...metadata
                    }
                },
                public: isPublic
            });
        } else {
            // Buffer or stream
            await file.save(fileData, {
                metadata: {
                    contentType,
                    metadata: {
                        uploadedAt: new Date().toISOString(),
                        ...metadata
                    }
                },
                public: isPublic
            });
        }

        console.log(`[GCS] Uploaded: gs://${bucketName}/${destinationPath}`);

        // Generate signed URL (unless public)
        const url = isPublic
            ? `https://storage.googleapis.com/${bucketName}/${destinationPath}`
            : await getSignedUrl(destinationPath);

        return {
            success: true,
            gcsPath: `gs://${bucketName}/${destinationPath}`,
            url,
            bucket: bucketName,
            path: destinationPath,
            public: isPublic
        };

    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.error('[GCS] Upload failed:', message);
        throw new Error(`Failed to upload to GCS: ${message}`);
    }
}

/**
 * Generate signed URL for existing file
 */
export async function getSignedUrl(
    filePath: string,
    expirySeconds: number = signedUrlExpiry,
    action: 'read' | 'write' = 'read',
    /**
     * Sign this bucket instead of the configured one. Pass the bucket parsed
     * from a stored object URL so a cut written before a bucket change still
     * signs where it lives (#390).
     */
    bucketName?: string
): Promise<string> {
    try {
        const file: File = bucketHandle(bucketName).bucket.file(filePath);

        const config: GetSignedUrlConfig = {
            version: 'v4',
            action,
            expires: Date.now() + expirySeconds * 1000
        };

        const [signedUrl] = await file.getSignedUrl(config);

        return signedUrl;

    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.error('[GCS] Signed URL generation failed:', message);
        throw new Error(`Failed to generate signed URL: ${message}`);
    }
}

/**
 * Delete file from Google Cloud Storage
 */
export async function deleteFromGCS(filePath: string): Promise<boolean> {
    try {
        const { name: bucketName, bucket } = bucketHandle();
        await bucket.file(filePath).delete();
        console.log(`[GCS] Deleted: gs://${bucketName}/${filePath}`);
        return true;

    } catch (error: any) {
        // Ignore "not found" errors
        if (error.code === 404) {
            console.warn(`[GCS] File not found (already deleted?): ${filePath}`);
            return true;
        }

        const message = error instanceof Error ? error.message : 'Unknown error';
        console.error('[GCS] Delete failed:', message);
        throw new Error(`Failed to delete from GCS: ${message}`);
    }
}

/**
 * Check if file exists in GCS
 */
export async function fileExists(filePath: string): Promise<boolean> {
    try {
        const [exists] = await bucketHandle().bucket.file(filePath).exists();
        return exists;
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.error('[GCS] Exists check failed:', message);
        return false;
    }
}

/**
 * Get file metadata
 */
export async function getFileMetadata(filePath: string): Promise<any> {
    try {
        const [metadata] = await bucketHandle().bucket.file(filePath).getMetadata();
        return metadata;
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.error('[GCS] Metadata fetch failed:', message);
        throw new Error(`Failed to get file metadata: ${message}`);
    }
}

/**
 * Upload design image to GCS
 */
export async function uploadDesign(
    imageBuffer: Buffer,
    designId: string,
    metadata: DesignMetadata = {}
): Promise<GCSUploadResult> {
    const timestamp = Date.now();
    const destinationPath = `designs/${designId}_${timestamp}.png`;

    return uploadToGCS(imageBuffer, destinationPath, {
        contentType: 'image/png',
        metadata: {
            designId,
            userId: metadata.userId,
            style: metadata.style,
            bodyPart: metadata.bodyPart,
            type: 'design'
        }
    });
}

/**
 * Upload layer PNG to GCS
 */
export async function uploadLayer(
    imageBuffer: Buffer,
    designId: string,
    layerType: string,
    metadata: LayerMetadata = {}
): Promise<GCSUploadResult> {
    const timestamp = Date.now();
    const destinationPath = `layers/${designId}_${layerType}_${timestamp}.png`;

    return uploadToGCS(imageBuffer, destinationPath, {
        contentType: 'image/png',
        metadata: {
            designId,
            layerType,
            userId: metadata.userId,
            type: 'layer'
        }
    });
}

/**
 * Upload layer thumbnail to GCS
 */
export async function uploadLayerThumbnail(
    thumbnailBuffer: Buffer,
    designId: string,
    layerType: string
): Promise<GCSUploadResult> {
    const timestamp = Date.now();
    const destinationPath = `layers/${designId}_${layerType}_${timestamp}_thumb.png`;

    return uploadToGCS(thumbnailBuffer, destinationPath, {
        contentType: 'image/png',
        metadata: {
            designId,
            layerType,
            type: 'thumbnail'
        }
    });
}

/**
 * Upload stencil export to GCS (300 DPI)
 */
export async function uploadStencil(
    stencilBuffer: Buffer,
    designId: string,
    metadata: StencilMetadata = {}
): Promise<GCSUploadResult> {
    const timestamp = Date.now();
    const destinationPath = `stencils/${designId}_${timestamp}_300dpi.png`;

    return uploadToGCS(stencilBuffer, destinationPath, {
        contentType: 'image/png',
        metadata: {
            designId,
            userId: metadata.userId,
            dpi: '300',
            type: 'stencil'
        }
    });
}

/**
 * Upload portfolio image to GCS
 */
export async function uploadPortfolio(
    imageBuffer: Buffer,
    artistId: string,
    index: number
): Promise<GCSUploadResult> {
    const destinationPath = `portfolios/${artistId}_${index}.jpg`;

    return uploadToGCS(imageBuffer, destinationPath, {
        contentType: 'image/jpeg',
        metadata: {
            artistId,
            index: index.toString(),
            type: 'portfolio'
        }
    });
}

/**
 * List files in a folder
 */
export async function listFiles(prefix: string, maxResults: number = 100): Promise<GCSFileMetadata[]> {
    try {
        const [files] = await bucketHandle().bucket.getFiles({
            prefix,
            maxResults
        });

        return files.map(file => ({
            name: file.name,
            size: parseInt(file.metadata.size as string, 10),
            contentType: file.metadata.contentType as string,
            created: file.metadata.timeCreated as string,
            updated: file.metadata.updated as string,
            metadata: (file.metadata.metadata as Record<string, any>) || {}
        }));

    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.error('[GCS] List files failed:', message);
        throw new Error(`Failed to list files: ${message}`);
    }
}

/**
 * Batch delete files
 */
export async function batchDelete(filePaths: string[]): Promise<BatchDeleteResult> {
    const results: BatchDeleteResult = {
        deleted: [],
        failed: []
    };

    for (const filePath of filePaths) {
        try {
            await deleteFromGCS(filePath);
            results.deleted.push(filePath);
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            results.failed.push({ filePath, error: message });
        }
    }

    return results;
}

/**
 * Health check for GCS connection
 */
export async function checkGCSHealth(): Promise<GCSHealthStatus> {
    try {
        const { name: bucketName, bucket } = bucketHandle();
        // Try to get bucket metadata
        const [metadata] = await bucket.getMetadata();

        return {
            healthy: true,
            bucket: bucketName,
            location: metadata.location as string,
            storageClass: metadata.storageClass as string,
            created: metadata.timeCreated as string
        };

    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return {
            healthy: false,
            error: message,
            bucket: configuredStorageBucket()
        };
    }
}

export default {
    uploadToGCS,
    getSignedUrl,
    deleteFromGCS,
    fileExists,
    getFileMetadata,
    uploadDesign,
    uploadLayer,
    uploadLayerThumbnail,
    uploadStencil,
    uploadPortfolio,
    listFiles,
    batchDelete,
    checkGCSHealth
};
