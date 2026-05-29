import { describe, it, expect, vi } from 'vitest';
import { createWorkOsDirectoryClient } from './workos-directory.js';

function buildResponse(body: unknown, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

describe('createWorkOsDirectoryClient', () => {
  const apiKey = 'sk_test_abc';
  const directoryId = 'directory_01HABCXYZ';

  it('resolves a github login by scanning custom_attributes on directory users', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      buildResponse({
        data: [
          {
            id: 'directory_user_01',
            first_name: 'Ada',
            last_name: 'Lovelace',
            job_title: 'Principal Engineer',
            custom_attributes: { githubLogin: 'ada', department: 'Platform' },
            created_at: '2026-01-01T00:00:00Z',
          },
        ],
        list_metadata: { after: null },
      })
    );
    const client = createWorkOsDirectoryClient({ apiKey, directoryId, fetchImpl });

    const user = await client.findByExternalId('github', 'ada');

    expect(user).toEqual({
      id: 'directory_user_01',
      displayName: 'Ada Lovelace',
      title: 'Principal Engineer',
      department: 'Platform',
      customAttributes: { githubLogin: 'ada', department: 'Platform' },
      createdAt: '2026-01-01T00:00:00Z',
    });
    const [calledUrl, calledInit] = fetchImpl.mock.calls[0];
    const url = typeof calledUrl === 'string' ? calledUrl : calledUrl.toString();
    expect(url).toContain('/directory_users');
    expect(url).toContain(`directory=${directoryId}`);
    expect((calledInit?.headers as Record<string, string>).Authorization).toBe(`Bearer ${apiKey}`);
  });

  it('returns null when no directory user has the requested custom attribute', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => buildResponse({ data: [], list_metadata: { after: null } }));
    const client = createWorkOsDirectoryClient({ apiKey, directoryId, fetchImpl });
    const user = await client.findByExternalId('slack', 'U404');
    expect(user).toBeNull();
  });

  it('paginates through multiple pages until list_metadata.after is null', async () => {
    const pages = [
      {
        data: [{ id: 'u1', first_name: 'A', last_name: 'A', custom_attributes: {} }],
        list_metadata: { after: 'u1' },
      },
      {
        data: [{ id: 'u2', first_name: 'B', last_name: 'B', custom_attributes: { slackUserId: 'U777' } }],
        list_metadata: { after: null },
      },
    ];
    let call = 0;
    const fetchImpl = vi.fn<typeof fetch>(async () => buildResponse(pages[call++]));
    const client = createWorkOsDirectoryClient({ apiKey, directoryId, fetchImpl });

    const user = await client.findByExternalId('slack', 'U777');

    expect(user?.id).toBe('u2');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const secondUrl = fetchImpl.mock.calls[1][0].toString();
    expect(secondUrl).toContain('after=u1');
  });

  it('matches on the linear-specific custom attribute', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      buildResponse({
        data: [{ id: 'u3', first_name: 'G', last_name: 'H', custom_attributes: { linearUserId: 'lin_42' } }],
        list_metadata: { after: null },
      })
    );
    const client = createWorkOsDirectoryClient({ apiKey, directoryId, fetchImpl });
    const user = await client.findByExternalId('linear', 'lin_42');
    expect(user?.id).toBe('u3');
  });

  it('throws when the WorkOS API responds non-2xx', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      buildResponse({ error: 'unauthorized' }, { status: 401, statusText: 'Unauthorized' })
    );
    const client = createWorkOsDirectoryClient({ apiKey, directoryId, fetchImpl });
    await expect(client.findByExternalId('github', 'ada')).rejects.toThrow(/401/);
  });

  it('lists users created since a timestamp (client-side filter on created_at)', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      buildResponse({
        data: [
          {
            id: 'old',
            first_name: 'Old',
            last_name: 'User',
            custom_attributes: {},
            created_at: '2025-12-01T00:00:00Z',
          },
          {
            id: 'new',
            first_name: 'Grace',
            last_name: 'Hopper',
            custom_attributes: { department: 'Compilers' },
            created_at: '2026-04-10T00:00:00Z',
          },
        ],
        list_metadata: { after: null },
      })
    );
    const client = createWorkOsDirectoryClient({ apiKey, directoryId, fetchImpl });

    const users = await client.listUsersSince(new Date('2026-04-01T00:00:00Z'));

    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({
      id: 'new',
      displayName: 'Grace Hopper',
      department: 'Compilers',
    });
  });
});
