import { createRegistry, type ProviderRegistry } from '../../common/registry.js';
import type { Aggregator } from './types.js';
import { aggregateGitHub } from './github.js';
import { aggregateLinear } from './linear.js';
import { aggregateSlack } from './slack.js';
import { aggregateNotion } from './notion.js';

/**
 * Build the aggregator registry with the four first-party sources registered.
 * Adding a fifth source is one line here — the orchestrator does not change.
 */
export function buildAggregatorRegistry(): ProviderRegistry<Aggregator> {
  const registry = createRegistry<Aggregator>('aggregator');
  registry.register('github', () => aggregateGitHub);
  registry.register('linear', () => aggregateLinear);
  registry.register('slack', () => aggregateSlack);
  registry.register('notion', () => aggregateNotion);
  return registry;
}
