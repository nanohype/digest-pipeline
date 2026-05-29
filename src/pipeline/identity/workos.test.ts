import { describe, it, expect, vi } from 'vitest';
import { WorkOsIdentityResolver } from './workos.js';
import type { DirectoryUser, WorkOsDirectoryClient } from '../services/workos-directory.js';

function makeClient(overrides: Partial<WorkOsDirectoryClient> = {}): WorkOsDirectoryClient {
  return {
    findByExternalId: vi.fn(async () => null),
    listUsersSince: vi.fn(async () => []),
    ...overrides,
  };
}

const sampleUser: DirectoryUser = {
  id: 'directory_user_01',
  displayName: 'Ada Lovelace',
  title: 'Principal Engineer',
  department: 'Platform',
  customAttributes: { githubLogin: 'ada' },
};

describe('WorkOsIdentityResolver', () => {
  it('maps a DirectoryUser to a ResolvedIdentity (no email surfaced)', async () => {
    const client = makeClient({
      findByExternalId: vi.fn(async () => sampleUser),
    });
    const resolver = new WorkOsIdentityResolver(client);
    const identity = await resolver.resolveGitHubUser('ada');
    expect(identity).toEqual({
      userId: 'directory_user_01',
      displayName: 'Ada Lovelace',
      role: 'Principal Engineer',
      team: 'Platform',
    });
    expect(identity).not.toHaveProperty('email');
  });

  it('falls back to default role/team labels when the directory user omits title/department', async () => {
    const client = makeClient({
      findByExternalId: vi.fn(async () => ({ ...sampleUser, title: undefined, department: undefined })),
    });
    const resolver = new WorkOsIdentityResolver(client);
    const identity = await resolver.resolveLinearUser('lin_42');
    expect(identity?.role).toBe('Team Member');
    expect(identity?.team).toBe('Unknown Team');
  });

  it('caches the second lookup for the same external id', async () => {
    const findByExternalId = vi.fn(async () => sampleUser);
    const resolver = new WorkOsIdentityResolver(makeClient({ findByExternalId }));
    await resolver.resolveSlackUser('U123');
    await resolver.resolveSlackUser('U123');
    expect(findByExternalId).toHaveBeenCalledTimes(1);
  });

  it('returns null and does not cache when the directory has no user for the id', async () => {
    const findByExternalId = vi.fn(async () => null);
    const resolver = new WorkOsIdentityResolver(makeClient({ findByExternalId }));
    const identity = await resolver.resolveSlackUser('U404');
    expect(identity).toBeNull();
    await resolver.resolveSlackUser('U404');
    expect(findByExternalId).toHaveBeenCalledTimes(2);
  });

  it('returns null when the underlying directory call throws (pipeline continues gracefully)', async () => {
    const client = makeClient({
      findByExternalId: vi.fn(async () => {
        throw new Error('WorkOS 5xx');
      }),
    });
    const resolver = new WorkOsIdentityResolver(client);
    const identity = await resolver.resolveGitHubUser('broken');
    expect(identity).toBeNull();
  });
});
