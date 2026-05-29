import { describe, it, expect, vi } from 'vitest';
import { createS3VoiceBaselineService } from './voice-baseline.js';
import type { S3Client } from '@aws-sdk/client-s3';

function fakeS3(pages: Array<{ keys: string[]; nextToken?: string }>): S3Client {
  let call = 0;
  const send = vi.fn(async () => {
    const page = pages[call];
    call += 1;
    return {
      Contents: page.keys.map((Key) => ({ Key })),
      IsTruncated: Boolean(page.nextToken),
      NextContinuationToken: page.nextToken,
    };
  });
  return { send } as unknown as S3Client;
}

describe('createS3VoiceBaselineService', () => {
  it('returns every key from a single page of results', async () => {
    const s3 = fakeS3([{ keys: ['2026-10.txt', '2026-09.txt', '2026-08.txt'] }]);
    const service = createS3VoiceBaselineService({ bucket: 'baseline', s3 });
    const keys = await service.listBaselineKeys();
    expect(keys).toEqual(['2026-08.txt', '2026-09.txt', '2026-10.txt']);
  });

  it('paginates through multiple ListObjectsV2 responses', async () => {
    const s3 = fakeS3([
      { keys: ['a', 'b'], nextToken: 'page-2' },
      { keys: ['c'], nextToken: undefined },
    ]);
    const service = createS3VoiceBaselineService({ bucket: 'baseline', s3 });
    const keys = await service.listBaselineKeys();
    expect(keys).toEqual(['a', 'b', 'c']);
    expect((s3.send as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
  });

  it('sorts keys lexicographically so `.slice(-3)` picks the most recent YYYY-WW keys', async () => {
    const s3 = fakeS3([{ keys: ['2026-01.txt', '2025-52.txt', '2026-10.txt', '2026-05.txt'] }]);
    const service = createS3VoiceBaselineService({ bucket: 'baseline', s3 });
    const keys = await service.listBaselineKeys();
    expect(keys.slice(-3)).toEqual(['2026-01.txt', '2026-05.txt', '2026-10.txt']);
  });
});
