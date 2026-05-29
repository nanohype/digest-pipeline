/**
 * WorkOS Directory Sync client — resolves employee identities by
 * upstream external id (GitHub login, Slack user id, Linear user id)
 * and enumerates users created since a timestamp (for new-joiner
 * detection).
 *
 * Uses native fetch against the WorkOS REST API. Keeps the surface
 * tiny so the identity resolver can depend on this interface instead
 * of pulling in @workos-inc/node — the SDK's transitive footprint is
 * much larger than the two calls we actually make, and the inject-able
 * `fetchImpl` gives us a clean seam for tests.
 *
 * WorkOS doesn't support server-side filtering on custom attributes,
 * so findByExternalId paginates through the directory and scans
 * client-side. The IdentityResolver caches results for 4 hours; the
 * full walk happens at most once per unique external-id type per TTL.
 */

export type ExternalIdType = 'github' | 'slack' | 'linear';

export interface DirectoryUser {
  id: string; // WorkOS directory user id
  displayName: string;
  title?: string;
  department?: string;
  customAttributes: Record<string, unknown>;
  createdAt?: string; // ISO 8601 from WorkOS
}

export interface WorkOsDirectoryClient {
  findByExternalId(type: ExternalIdType, value: string): Promise<DirectoryUser | null>;
  listUsersSince(since: Date): Promise<DirectoryUser[]>;
}

export interface WorkOsDirectoryConfig {
  apiKey: string;
  directoryId: string;
  baseUrl?: string; // default https://api.workos.com
  fetchImpl?: typeof fetch;
}

interface WorkOsDirectoryUser {
  id: string;
  first_name?: string | null;
  last_name?: string | null;
  job_title?: string | null;
  custom_attributes?: Record<string, unknown>;
  created_at?: string;
}

interface WorkOsDirectoryUserList {
  data: WorkOsDirectoryUser[];
  list_metadata: { after?: string | null };
}

const EXTERNAL_ID_ATTRIBUTE: Record<ExternalIdType, string> = {
  github: 'githubLogin',
  slack: 'slackUserId',
  linear: 'linearUserId',
};

export function createWorkOsDirectoryClient(config: WorkOsDirectoryConfig): WorkOsDirectoryClient {
  const fetchImpl = config.fetchImpl ?? fetch;
  const baseUrl = (config.baseUrl ?? 'https://api.workos.com').replace(/\/$/, '');
  const headers = {
    Authorization: `Bearer ${config.apiKey}`,
    Accept: 'application/json',
  };

  const toDirectoryUser = (raw: WorkOsDirectoryUser): DirectoryUser => {
    const attrs = raw.custom_attributes ?? {};
    const displayName =
      [raw.first_name, raw.last_name].filter(Boolean).join(' ').trim() || String(attrs.displayName ?? raw.id);
    return {
      id: raw.id,
      displayName,
      title: raw.job_title ?? (typeof attrs.title === 'string' ? attrs.title : undefined),
      department: typeof attrs.department === 'string' ? attrs.department : undefined,
      customAttributes: attrs,
      createdAt: raw.created_at,
    };
  };

  async function* walk(): AsyncGenerator<WorkOsDirectoryUser> {
    let after: string | null | undefined;
    while (true) {
      const url = new URL(`${baseUrl}/directory_users`);
      url.searchParams.set('directory', config.directoryId);
      url.searchParams.set('limit', '100');
      if (after) url.searchParams.set('after', after);
      const response = await fetchImpl(url.toString(), { headers });
      if (!response.ok) {
        throw new Error(`WorkOS directory list failed (${response.status} ${response.statusText})`);
      }
      const body = (await response.json()) as WorkOsDirectoryUserList;
      for (const user of body.data) yield user;
      after = body.list_metadata.after;
      if (!after) return;
    }
  }

  return {
    async findByExternalId(type, value) {
      const attributeName = EXTERNAL_ID_ATTRIBUTE[type];
      for await (const raw of walk()) {
        const attr = raw.custom_attributes?.[attributeName];
        if (typeof attr === 'string' && attr === value) return toDirectoryUser(raw);
      }
      return null;
    },

    async listUsersSince(since) {
      const cutoff = since.getTime();
      const matches: DirectoryUser[] = [];
      for await (const raw of walk()) {
        const created = raw.created_at ? Date.parse(raw.created_at) : NaN;
        if (!Number.isNaN(created) && created >= cutoff) matches.push(toDirectoryUser(raw));
      }
      return matches;
    },
  };
}
