/**
 * Pipeline composition root. Wires real Postgres / WorkOS / Bedrock /
 * GitHub / Linear / Slack / Notion adapters and invokes runPipeline.
 * Intended to be the container CMD for the Dockerfile.pipeline image,
 * run by the k8s CronJob (weekly Friday 09:00 UTC).
 */

import "dotenv/config";
import { S3Client } from "@aws-sdk/client-s3";
import { z } from "zod";
import { awsRequestHandler } from "../common/aws.js";
import { getLogger } from "../common/logger.js";
import { createSecretsClient } from "../common/secrets.js";
import { createBoundedSlackClient } from "../common/slack.js";
import { createPostgresAuditDatabase } from "../data/audit.js";
import { createPostgresDraftRepository } from "../data/drafts.js";
import { createDbPool } from "../data/pool.js";
import { createWorkOsDirectoryClient } from "../vendor/runtime/workos-directory.js";
import type { AggregatorConfig, AggregatorServices } from "./aggregators/types.js";
import { NewsletterGenerator } from "./ai/generator.js";
import { AuditWriter } from "./audit.js";
import { WorkOsIdentityResolver } from "./identity/workos.js";
import {
  type PipelineDeps,
  type PipelineDraftStore,
  type PipelineNotifier,
  runPipeline,
} from "./index.js";
import { createOctokitGitHubService } from "./services/github.js";
import { createLinearService } from "./services/linear.js";
import { createNotionService } from "./services/notion.js";
import { createSlackService } from "./services/slack.js";
import { createS3VoiceBaselineService } from "./services/voice-baseline.js";
import type { PipelineConfig } from "./types.js";

const PipelineEnvSchema = z.object({
  AWS_REGION: z.string().min(1).default("us-east-1"),
  // The Platform's ModelGateway, published on ModelGateway.status.endpoint. The
  // app talks to this instead of to Bedrock: the gateway holds the AWS identity,
  // applies the route's guardrail, and is the only path out of the namespace to
  // a model.
  MODEL_GATEWAY_ENDPOINT: z
    .string()
    .url()
    // .url() alone accepts `host:8080` as a URL whose scheme is `host:`, which
    // the Messages client would only fail on at request time.
    .refine((v) => /^https?:\/\//.test(v), {
      message: "MODEL_GATEWAY_ENDPOINT must be an http(s) URL",
    }),
  // A route name on that gateway, not a Bedrock model id. The gateway rewrites
  // it to the real inference-profile id, so model selection lives in the
  // ModelGateway CR rather than in this app's config.
  MODEL_ROUTE: z.string().min(1),
  MODEL_MAX_TOKENS: z.coerce.number().int().positive().default(2000),
  WORKOS_DIRECTORY_SECRET_ID: z.string().min(1),
  DATABASE_URL: z.string().min(1).optional(),
  DATABASE_SECRET_ID: z.string().min(1).optional(),
  VOICE_BASELINE_BUCKET: z.string().min(1),
  RAW_AGGREGATIONS_BUCKET: z.string().min(1),
  SLACK_REVIEW_CHANNEL_ID: z.string().min(1),
  // Service secret ids
  GITHUB_SECRET_ID: z.string().min(1),
  LINEAR_SECRET_ID: z.string().min(1),
  SLACK_SECRET_ID: z.string().min(1),
  NOTION_SECRET_ID: z.string().min(1),
  // How many days back to scan source providers. Default 7 (matches the
  // weekly cadence). Override for catch-up runs or sparse-data test deploys.
  LOOKBACK_DAYS: z.coerce.number().int().positive().default(7),
});

const DirectorySecretSchema = z.object({
  apiKey: z.string().min(1),
  directoryId: z.string().min(1),
});
const DbSecretSchema = z.object({
  host: z.string().min(1),
  port: z.coerce.number().int().positive(),
  username: z.string().min(1),
  password: z.string().min(1),
  dbname: z.string().min(1),
});

const GitHubSecretSchema = z.object({
  token: z.string().min(1),
  repos: z.array(z.object({ owner: z.string().min(1), repo: z.string().min(1) })).min(1),
});

const LinearSecretSchema = z.object({
  apiKey: z.string().min(1),
  askLabel: z.string().min(1).optional(),
});

const SlackSecretSchema = z.object({
  botToken: z.string().min(1),
  announcementsChannelId: z.string().min(1),
  teamChannelId: z.string().min(1),
  hrBotUserIds: z.array(z.string()).default([]),
});

const NotionSecretSchema = z.object({
  apiKey: z.string().min(1),
  databaseId: z.string().min(1),
});

async function resolveDatabaseUrl(): Promise<string> {
  const env = PipelineEnvSchema.parse(process.env);
  if (env.DATABASE_URL) return env.DATABASE_URL;
  if (!env.DATABASE_SECRET_ID) {
    throw new Error("DATABASE_URL or DATABASE_SECRET_ID must be set");
  }
  const secrets = createSecretsClient({ region: env.AWS_REGION });
  const secret = await secrets.getJson(env.DATABASE_SECRET_ID, DbSecretSchema);
  const encoded = encodeURIComponent(secret.password);
  return `postgres://${secret.username}:${encoded}@${secret.host}:${secret.port}/${secret.dbname}`;
}

async function buildDeps(): Promise<PipelineDeps> {
  const env = PipelineEnvSchema.parse(process.env);
  const secrets = createSecretsClient({ region: env.AWS_REGION });

  const [directory, github, linear, slack, notion] = await Promise.all([
    secrets.getJson(env.WORKOS_DIRECTORY_SECRET_ID, DirectorySecretSchema),
    secrets.getJson(env.GITHUB_SECRET_ID, GitHubSecretSchema),
    secrets.getJson(env.LINEAR_SECRET_ID, LinearSecretSchema),
    secrets.getJson(env.SLACK_SECRET_ID, SlackSecretSchema),
    secrets.getJson(env.NOTION_SECRET_ID, NotionSecretSchema),
  ]);

  const directoryClient = createWorkOsDirectoryClient({
    apiKey: directory.apiKey,
    directoryId: directory.directoryId,
  });
  const resolver = new WorkOsIdentityResolver(directoryClient);

  const pipelineConfig: PipelineConfig = {
    slackReviewChannelId: env.SLACK_REVIEW_CHANNEL_ID,
    backupApproverIds: [],
    voiceBaselineBucket: env.VOICE_BASELINE_BUCKET,
    rawAggregationsBucket: env.RAW_AGGREGATIONS_BUCKET,
    llm: {
      route: env.MODEL_ROUTE,
      gatewayEndpoint: env.MODEL_GATEWAY_ENDPOINT,
      maxTokens: env.MODEL_MAX_TOKENS,
    },
    schedule: {
      timezone: "America/Los_Angeles",
      dayOfWeek: "Friday",
      draftPostHour: 9,
      draftPostMinute: 45,
      reminderHour: 11,
      expiryHour: 12,
    },
  };

  const s3 = new S3Client({ region: env.AWS_REGION, requestHandler: awsRequestHandler(8_000) });
  const voiceBaseline = createS3VoiceBaselineService({ bucket: env.VOICE_BASELINE_BUCKET, s3 });
  const generator = new NewsletterGenerator({ config: pipelineConfig, voiceBaseline, s3 });

  const services: AggregatorServices = {
    github: createOctokitGitHubService({ token: github.token, repos: github.repos }),
    linear: createLinearService({ apiKey: linear.apiKey, askLabelName: linear.askLabel }),
    slack: createSlackService({ botToken: slack.botToken }),
    notion: createNotionService({ apiKey: notion.apiKey, databaseId: notion.databaseId }),
  };
  const aggregatorConfig: AggregatorConfig = {
    slack: {
      announcementsChannelId: slack.announcementsChannelId,
      teamChannelId: slack.teamChannelId,
      hrBotUserIds: slack.hrBotUserIds,
    },
  };

  const databaseUrl = await resolveDatabaseUrl();
  const pool = createDbPool(databaseUrl);

  const auditDb = createPostgresAuditDatabase(pool);
  const auditWriter = new AuditWriter(auditDb);

  const draftRepo = createPostgresDraftRepository(pool);
  const draftStore: PipelineDraftStore = {
    create: (input) => draftRepo.create(input),
    expirePending: (before) => draftRepo.expirePending(before),
  };

  const slackNotifyClient = createBoundedSlackClient(slack.botToken);
  const log = getLogger();
  const notifier: PipelineNotifier = {
    async notifyDraftReady(runId, draftId, fullText) {
      try {
        await slackNotifyClient.chat.postMessage({
          channel: env.SLACK_REVIEW_CHANNEL_ID,
          text: `DigestPipeline draft ready for review.`,
          blocks: [
            {
              type: "header",
              text: { type: "plain_text", text: "📰 Weekly newsletter draft ready" },
            },
            {
              type: "section",
              text: { type: "mrkdwn", text: `Run \`${runId}\` · Draft \`${draftId}\`` },
            },
            {
              type: "section",
              text: { type: "mrkdwn", text: `Preview:\n>>> ${fullText.slice(0, 600)}` },
            },
          ],
        });
      } catch (err) {
        log.error({ runId, draftId, err }, "slack.notify-failed");
      }
    },
    async alert(runId, message) {
      try {
        await slackNotifyClient.chat.postMessage({
          channel: env.SLACK_REVIEW_CHANNEL_ID,
          text: `⚠️ DigestPipeline alert (run ${runId}): ${message}`,
        });
      } catch (err) {
        log.error({ runId, message, err }, "slack.alert-failed");
      }
    },
  };

  return {
    resolver,
    generator,
    auditWriter,
    draftStore,
    notifier,
    services,
    aggregatorConfig,
    lookbackDays: env.LOOKBACK_DAYS,
  };
}

async function main(): Promise<void> {
  const deps = await buildDeps();
  const result = await runPipeline(deps);
  getLogger().info({ result }, "pipeline.exit");
  process.exit(result.status === "FAILED" ? 1 : 0);
}

main().catch((err) => {
  getLogger().fatal({ err }, "pipeline.unhandled");
  process.exit(1);
});
