/**
 * Notion service — scoped queries against the all-hands database.
 *
 * Notion's 2025-09-03 API splits a database into one or more data
 * sources; queries run against a data source, not the database. The
 * configured database ID is resolved to its data source IDs once (cached
 * for the service lifetime) and each is queried in turn.
 *
 * Every returned page's parent.database_id is verified against the
 * configured database ID so a compromised or over-scoped Notion
 * integration token cannot widen the aggregation surface beyond the
 * intended database.
 */

import { Client, isFullDatabase, isFullPage } from "@notionhq/client";

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
  let dataSourceIds: string[] | undefined;

  async function resolveDataSourceIds(): Promise<string[]> {
    if (dataSourceIds) return dataSourceIds;
    const database = await client.databases.retrieve({ database_id: config.databaseId });
    if (!isFullDatabase(database)) {
      throw new Error(`Notion database ${config.databaseId} returned without data source metadata`);
    }
    dataSourceIds = database.data_sources.map((source) => source.id);
    return dataSourceIds;
  }

  return {
    async listRecentPagesSince(since) {
      const sourceIds = await resolveDataSourceIds();
      const pages: NotionPage[] = [];

      for (const dataSourceId of sourceIds) {
        const response = await client.dataSources.query({
          data_source_id: dataSourceId,
          filter: {
            timestamp: "created_time",
            created_time: { after: since.toISOString() },
          },
          sorts: [{ timestamp: "created_time", direction: "descending" }],
          page_size: 50,
        });

        for (const result of response.results) {
          if (!isFullPage(result)) continue;
          // A page queried from a data source carries parent.type
          // 'data_source_id' with parent.database_id set to the owning
          // database. Verify it against the configured database so an
          // over-scoped token cannot widen the aggregation surface.
          const parent = result.parent;
          const parentDatabaseId =
            parent.type === "data_source_id" || parent.type === "database_id"
              ? parent.database_id
              : undefined;
          if (parentDatabaseId !== config.databaseId) continue;

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
      }
      return pages;
    },
  };
}

function extractTitle(properties: Record<string, unknown>): string | null {
  for (const value of Object.values(properties)) {
    const prop = value as { type?: string; title?: Array<{ plain_text?: string }> };
    if (prop.type === "title" && Array.isArray(prop.title)) {
      const joined = prop.title.map((t) => t.plain_text ?? "").join("");
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
    if (prop.type === "people" && prop.people?.[0]?.name) return prop.people[0].name;
    if (prop.type === "rich_text" && prop.rich_text?.[0]?.plain_text)
      return prop.rich_text[0].plain_text;
  }
  return undefined;
}
