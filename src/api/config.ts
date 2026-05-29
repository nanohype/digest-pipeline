/**
 * API config — env-parsed with Zod. Fails loudly at startup rather than
 * mid-request. Approvers load from Secrets Manager, not process.env, so the
 * allow-list can be rotated without a redeploy.
 */

import { z } from 'zod';
import { createSecretsClient, type SecretsClient } from '../common/secrets.js';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  AWS_REGION: z.string().min(1).default('us-east-1'),
  WORKOS_ISSUER: z.url().default('https://api.workos.com'),
  WORKOS_CLIENT_ID: z.string().min(1),
  APPROVERS_SECRET_ID: z.string().min(1),
  WEB_ORIGIN: z
    .string()
    .min(1)
    .transform((s) =>
      s
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean)
    ),
});

export type ApiEnv = z.infer<typeof EnvSchema>;

export const ApproversSchema = z.object({
  cosUserId: z.string().min(1),
  backupApproverIds: z.array(z.string().min(1)),
});
export type Approvers = z.infer<typeof ApproversSchema>;

export interface ApiConfig {
  env: ApiEnv;
  secrets: SecretsClient;
  loadApprovers(): Promise<Approvers>;
}

export function loadApiConfig(overrides?: Partial<NodeJS.ProcessEnv>): ApiConfig {
  const env = EnvSchema.parse({ ...process.env, ...overrides });
  const secrets = createSecretsClient({ region: env.AWS_REGION });
  return {
    env,
    secrets,
    loadApprovers: () => secrets.getJson(env.APPROVERS_SECRET_ID, ApproversSchema),
  };
}
