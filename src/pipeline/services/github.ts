/**
 * GitHub service — minimal surface the aggregator needs. Wraps the
 * Octokit REST client so the aggregator can stay a pure function of
 * `since` and a typed service, and so tests inject a mock implementation
 * without mounting a fake HTTP server.
 */

import { Octokit } from '@octokit/rest';

export interface GitHubMergedPR {
  number: number;
  title: string;
  htmlUrl: string;
  mergedAt: string;
  authorLogin: string;
  body?: string;
  labels: string[];
  repo: string;
}

export interface GitHubRepoRef {
  owner: string;
  repo: string;
}

export interface GitHubService {
  listMergedPRsSince(since: Date): Promise<GitHubMergedPR[]>;
}

export interface GitHubServiceConfig {
  token: string;
  repos: GitHubRepoRef[];
  perRepoLimit?: number;
}

export function createOctokitGitHubService(config: GitHubServiceConfig): GitHubService {
  const octokit = new Octokit({ auth: config.token });
  const perRepoLimit = config.perRepoLimit ?? 50;

  return {
    async listMergedPRsSince(since) {
      const results: GitHubMergedPR[] = [];
      for (const { owner, repo } of config.repos) {
        const response = await octokit.rest.pulls.list({
          owner,
          repo,
          state: 'closed',
          sort: 'updated',
          direction: 'desc',
          per_page: perRepoLimit,
        });
        for (const pr of response.data) {
          if (!pr.merged_at) continue;
          if (new Date(pr.merged_at) < since) continue;
          results.push({
            number: pr.number,
            title: pr.title,
            htmlUrl: pr.html_url,
            mergedAt: pr.merged_at,
            authorLogin: pr.user?.login ?? 'unknown',
            body: pr.body ?? undefined,
            labels: pr.labels.map((l) => (typeof l === 'string' ? l : (l.name ?? ''))).filter(Boolean),
            repo: `${owner}/${repo}`,
          });
        }
      }
      return results;
    },
  };
}
