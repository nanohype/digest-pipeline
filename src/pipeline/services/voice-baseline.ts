/**
 * Voice baseline service — lists S3 keys holding approved-draft examples
 * that feed the generator's few-shot prompt. The concrete implementation
 * wraps the S3 SDK; the generator depends on the interface so tests can
 * inject a canned list without a real S3 client.
 */

import { ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3';

export interface VoiceBaselineService {
  listBaselineKeys(): Promise<string[]>;
}

export interface VoiceBaselineConfig {
  bucket: string;
  prefix?: string;
  s3: S3Client;
  maxKeys?: number;
}

export function createS3VoiceBaselineService(config: VoiceBaselineConfig): VoiceBaselineService {
  return {
    async listBaselineKeys() {
      const keys: string[] = [];
      let continuationToken: string | undefined;

      do {
        const response = await config.s3.send(
          new ListObjectsV2Command({
            Bucket: config.bucket,
            Prefix: config.prefix,
            MaxKeys: config.maxKeys ?? 100,
            ContinuationToken: continuationToken,
          })
        );
        for (const object of response.Contents ?? []) {
          if (object.Key) keys.push(object.Key);
        }
        continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
      } while (continuationToken);

      // Sort lexicographically; callers take `.slice(-3)` for the three
      // most recent baseline files when keys encode YYYY-WW prefixes.
      keys.sort();
      return keys;
    },
  };
}
