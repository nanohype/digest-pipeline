/**
 * Notion service — scoped queries against the all-hands database.
 *
 * Every returned page's parent.database_id is verified against the
 * configured database ID so a compromised or over-scoped Notion
 * integration token cannot widen the aggregation surface beyond the
 * intended database.
 */

import { Client, isFullPage } from '@notionhq/client';

export interface NotionPage {
  id: string;
  title: string;
  summary?: string;
  url: string;
  createdTime: string;
  authorName?: string;
}

export interface NotionService {
  listRecentPagesSince(since: Date): Promise<NotionPage[]>;
}

export interface NotionServiceConfig {
  apiKey: string;
  databaseId: string;
}

export function createNotionService(config: NotionServiceConfig): NotionService {
  const client = new Client({ auth: config.apiKey });

  return {
    async listRecentPagesSince(since) {
      const response = await client.databases.query({
        database_id: config.databaseId,
        filter: {
          timestamp: 'created_time',
          created_time: { after: since.toISOString() },
        },
        sorts: [{ timestamp: 'created_time', direction: 'descending' }],
        page_size: 50,
      });

      const pages: NotionPage[] = [];
      for (const result of response.results) {
        if (!isFullPage(result)) continue;
        if (result.parent.type !== 'database_id' || result.parent.database_id !== config.databaseId) continue;

        const title = extractTitle(result.properties);
        if (!title) continue;

        pages.push({
          id: result.id,
          title,
          url: result.url,
          createdTime: result.created_time,
          authorName: extractAuthorName(result.properties),
        });
      }
      return pages;
    },
  };
}

function extractTitle(properties: Record<string, unknown>): string | null {
  for (const value of Object.values(properties)) {
    const prop = value as { type?: string; title?: Array<{ plain_text?: string }> };
    if (prop.type === 'title' && Array.isArray(prop.title)) {
      const joined = prop.title.map((t) => t.plain_text ?? '').join('');
      if (joined) return joined;
    }
  }
  return null;
}

function extractAuthorName(properties: Record<string, unknown>): string | undefined {
  for (const [key, value] of Object.entries(properties)) {
    if (!/author|owner|created[_\s]?by/i.test(key)) continue;
    const prop = value as {
      type?: string;
      people?: Array<{ name?: string }>;
      rich_text?: Array<{ plain_text?: string }>;
    };
    if (prop.type === 'people' && prop.people?.[0]?.name) return prop.people[0].name;
    if (prop.type === 'rich_text' && prop.rich_text?.[0]?.plain_text) return prop.rich_text[0].plain_text;
  }
  return undefined;
}
