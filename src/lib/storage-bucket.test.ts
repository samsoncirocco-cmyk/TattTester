import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { configuredStorageBucket, parseGcsObjectUrl } from './storage-bucket';

const BUCKET_ENV = [
  'GCP_STORAGE_BUCKET',
  'GCS_BUCKET_NAME',
  'GCS_BUCKET',
  'NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET',
] as const;

describe('configuredStorageBucket', () => {
  const previous = new Map<string, string | undefined>();

  afterEach(() => {
    for (const name of BUCKET_ENV) {
      const value = previous.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    previous.clear();
  });

  function isolate(values: Partial<Record<(typeof BUCKET_ENV)[number], string>>) {
    for (const name of BUCKET_ENV) {
      previous.set(name, process.env[name]);
      if (values[name] === undefined) delete process.env[name];
      else process.env[name] = values[name];
    }
  }

  it('prefers the write-path bucket when the signer alias is unset (#390)', () => {
    isolate({ GCP_STORAGE_BUCKET: 'tatt-pro-762958140397-assets' });
    expect(configuredStorageBucket()).toBe('tatt-pro-762958140397-assets');
  });

  it('falls through the chain and ignores blank values', () => {
    isolate({
      GCP_STORAGE_BUCKET: '   ',
      GCS_BUCKET_NAME: '',
      GCS_BUCKET: 'from-gcs-bucket',
    });
    expect(configuredStorageBucket()).toBe('from-gcs-bucket');
  });

  it('defaults when nothing is set', () => {
    isolate({});
    expect(configuredStorageBucket()).toBe('tatt-pro-assets');
  });
});

describe('parseGcsObjectUrl', () => {
  it('reads the bucket the object actually lives in', () => {
    expect(
      parseGcsObjectUrl(
        'https://storage.googleapis.com/tatt-pro-762958140397-assets/design-sessions/s1/v2.png'
      )
    ).toEqual({
      bucket: 'tatt-pro-762958140397-assets',
      path: 'design-sessions/s1/v2.png',
    });
  });

  it('decodes the object path and ignores a query string', () => {
    expect(
      parseGcsObjectUrl(
        'https://storage.googleapis.com/tatt-pro-assets/design-sessions/s1/a%20cut.png?X-Goog-Algorithm=GOOG4'
      )
    ).toEqual({
      bucket: 'tatt-pro-assets',
      path: 'design-sessions/s1/a cut.png',
    });
  });

  it('refuses hosts and bucket names it cannot sign', () => {
    expect(parseGcsObjectUrl('https://replicate.delivery/pbxt/out.png')).toBeUndefined();
    expect(parseGcsObjectUrl('https://storage.googleapis.com/NOT_A_BUCKET/x.png')).toBeUndefined();
    expect(parseGcsObjectUrl(undefined)).toBeUndefined();
  });
});

describe('writer and signer share the chain', () => {
  it('does not read a private env order in either module', () => {
    const writer = readFileSync(
      resolve(process.cwd(), 'src/services/storage/imageStorageService.ts'),
      'utf8'
    );
    const signer = readFileSync(resolve(process.cwd(), 'src/services/gcs-service.ts'), 'utf8');
    expect(writer).toContain('configuredStorageBucket');
    expect(signer).toContain('configuredStorageBucket');
    expect(writer).not.toContain('process.env.GCP_STORAGE_BUCKET');
    expect(writer).not.toContain('process.env.GCS_BUCKET_NAME');
    expect(signer).not.toContain('process.env.GCS_BUCKET_NAME');
    expect(signer).not.toContain('process.env.GCP_STORAGE_BUCKET');
  });
});
