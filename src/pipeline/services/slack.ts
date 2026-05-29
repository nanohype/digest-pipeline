/**
 * Slack service — channel history for #announcements and #team.
 * Uses the official @slack/web-api WebClient; aggregator receives
 * normalised messages without Slack's shape bleeding through.
 */

import { WebClient } from '@slack/web-api';

export interface SlackMessage {
  ts: string;
  channel: string;
  text: string;
  userId?: string;
  reactionCount: number;
  replyCount: number;
}

export interface SlackService {
  listChannelHistory(channelId: string, since: Date): Promise<SlackMessage[]>;
}

export interface SlackServiceConfig {
  botToken: string;
}

export function createSlackService(config: SlackServiceConfig): SlackService {
  const client = new WebClient(config.botToken);

  return {
    async listChannelHistory(channelId, since) {
      const oldest = (since.getTime() / 1000).toString();
      const response = await client.conversations.history({
        channel: channelId,
        oldest,
        limit: 200,
      });

      const messages = response.messages ?? [];
      return messages
        .filter((m) => m.ts && m.text)
        .map<SlackMessage>((m) => ({
          ts: m.ts!,
          channel: channelId,
          text: m.text ?? '',
          userId: m.user,
          reactionCount: m.reactions?.reduce((n, r) => n + (r.count ?? 0), 0) ?? 0,
          replyCount: m.reply_count ?? 0,
        }));
    },
  };
}
