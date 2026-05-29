/**
 * Thin Secrets Manager wrapper with in-process caching.
 *
 * Every call site loads its JSON secret through `getSecretJson<T>` with a
 * Zod schema so unparseable secrets fail closed at startup rather than
 * causing surprises deep inside request handlers.
 */

import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { z } from 'zod';

export interface SecretsClient {
  getJson<S extends z.ZodType>(secretId: string, schema: S): Promise<z.infer<S>>;
}

interface CacheEntry<T = unknown> {
  value: T;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;

export function createSecretsClient(options?: {
  region?: string;
  ttlMs?: number;
  fetcher?: (secretId: string) => Promise<string>;
}): SecretsClient {
  const ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
  const cache = new Map<string, CacheEntry>();
  const fetcher = options?.fetcher ?? defaultFetcher(options?.region);

  return {
    async getJson<S extends z.ZodType>(secretId: string, schema: S): Promise<z.infer<S>> {
      const cached = cache.get(secretId);
      if (cached && Date.now() < cached.expiresAt) {
        return cached.value as z.infer<S>;
      }
      const raw = await fetcher(secretId);
      const parsed = schema.parse(JSON.parse(raw)) as z.infer<S>;
      cache.set(secretId, { value: parsed, expiresAt: Date.now() + ttlMs });
      return parsed;
    },
  };
}

function defaultFetcher(region?: string): (secretId: string) => Promise<string> {
  const client = new SecretsManagerClient({ region: region ?? process.env.AWS_REGION });
  return async (secretId) => {
    const response = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
    if (!response.SecretString) {
      throw new Error(`Secret ${secretId} has no SecretString (binary secrets not supported)`);
    }
    return response.SecretString;
  };
}
