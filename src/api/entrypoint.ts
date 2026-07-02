/**
 * API composition root. Loads config, wires Postgres-backed repository +
 * audit writer, AWS-SDK-backed SES sender, @slack/web-api Slack confirmer,
 * builds the server, registers shutdown handlers, listens.
 *
 * Runs via: node --enable-source-maps dist/api/entrypoint.js
 */

import 'dotenv/config';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { WebClient as SlackWebClient } from '@slack/web-api';
import { z } from 'zod';
import { loadApiConfig } from './config.js';
import { buildServer, registerShutdownHandlers } from './server.js';
import type { EmailSender, SlackConfirmer } from '../ports.js';
import { createDbPool } from '../data/pool.js';
import { createPostgresDraftRepository } from '../data/drafts.js';
import { createPostgresAuditWriter } from '../data/audit.js';
import { getLogger } from '../common/logger.js';
import { awsRequestHandler } from '../common/aws.js';

const DbSecretSchema = z.object({
  host: z.string().min(1),
  port: z.coerce.number().int().positive(),
  username: z.string().min(1),
  password: z.string().min(1),
  dbname: z.string().min(1),
});

const SlackSecretSchema = z.object({
  botToken: z.string().min(1),
});

const RuntimeEnvSchema = z.object({
  DATABASE_URL: z.string().min(1).optional(),
  DATABASE_SECRET_ID: z.string().min(1).optional(),
  SES_FROM_ADDRESS: z.email(),
  NEWSLETTER_RECIPIENT_LIST: z.string().min(1),
  SLACK_REVIEW_CHANNEL_ID: z.string().min(1),
  SLACK_SECRET_ID: z.string().min(1),
});

type RuntimeEnv = z.infer<typeof RuntimeEnvSchema>;

async function resolveDatabaseUrl(
  config: ReturnType<typeof loadApiConfig>,
  env: RuntimeEnv,
): Promise<string> {
  if (env.DATABASE_URL) return env.DATABASE_URL;
  if (!env.DATABASE_SECRET_ID) {
    throw new Error('Either DATABASE_URL or DATABASE_SECRET_ID must be set');
  }
  const secret = await config.secrets.getJson(env.DATABASE_SECRET_ID, DbSecretSchema);
  const encoded = encodeURIComponent(secret.password);
  return `postgres://${secret.username}:${encoded}@${secret.host}:${secret.port}/${secret.dbname}`;
}

function createSesEmailSender(region: string, env: RuntimeEnv): EmailSender {
  // SES SendEmail is not idempotent — a blind retry could double-send a
  // company-wide email — so bound the socket and keep the SDK to a single
  // attempt rather than wrapping in withRetry. A timed-out send surfaces to
  // the approver, who can retry deliberately.
  const client = new SESClient({
    region,
    requestHandler: awsRequestHandler(15_000),
    maxAttempts: 1,
  });
  const recipients = env.NEWSLETTER_RECIPIENT_LIST.split(',')
    .map((r) => r.trim())
    .filter(Boolean);
  return {
    async send({ subject, htmlBody, textBody }) {
      const command = new SendEmailCommand({
        Source: env.SES_FROM_ADDRESS,
        Destination: { BccAddresses: recipients },
        Message: {
          Subject: { Data: subject, Charset: 'UTF-8' },
          Body: {
            Html: { Data: htmlBody, Charset: 'UTF-8' },
            Text: { Data: textBody, Charset: 'UTF-8' },
          },
        },
      });
      const response = await client.send(command);
      const messageId = response.MessageId;
      if (!messageId) throw new Error('SES did not return a MessageId');
      return { messageId, recipientCount: recipients.length };
    },
  };
}

function createSlackConfirmerFromBot(botToken: string, channelId: string): SlackConfirmer {
  const client = new SlackWebClient(botToken);
  return {
    async confirmSent(runId, draftId, recipientCount) {
      try {
        await client.chat.postMessage({
          channel: channelId,
          text: `✅ DigestPipeline sent — run ${runId}, draft ${draftId}, ${recipientCount} recipients`,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `✅ *DigestPipeline sent*\nRun \`${runId}\` · Draft \`${draftId}\` · ${recipientCount} recipients`,
              },
            },
          ],
        });
      } catch (err) {
        // Slack posting is observability, not critical path. Log and
        // swallow so a transient Slack outage doesn't mask a successful
        // send from the approver or the audit trail.
        getLogger().error({ runId, draftId, recipientCount, err }, 'slack.confirm-sent.failed');
      }
    },
  };
}

async function main(): Promise<void> {
  const config = loadApiConfig();
  const env = RuntimeEnvSchema.parse(process.env);

  const slackSecret = await config.secrets.getJson(env.SLACK_SECRET_ID, SlackSecretSchema);

  const databaseUrl = await resolveDatabaseUrl(config, env);
  const pool = createDbPool(databaseUrl);

  const app = await buildServer({
    config,
    draftRepository: createPostgresDraftRepository(pool),
    auditWriter: createPostgresAuditWriter(pool),
    emailSender: createSesEmailSender(config.env.AWS_REGION, env),
    slackConfirmer: createSlackConfirmerFromBot(slackSecret.botToken, env.SLACK_REVIEW_CHANNEL_ID),
  });

  registerShutdownHandlers(app);

  await app.listen({ host: '0.0.0.0', port: config.env.PORT });
  app.log.info({ port: config.env.PORT }, 'digest-pipeline API listening');
}

main().catch((err) => {
  console.error('digest-pipeline API failed to start:', err);
  process.exit(1);
});
