import { createRegistry, type ProviderRegistry } from "../../vendor/runtime/registry.js";
import { aggregateGitHub } from "./github.js";
import { aggregateLinear } from "./linear.js";
import { aggregateNotion } from "./notion.js";
import { aggregateSlack } from "./slack.js";
import type { Aggregator } from "./types.js";

/**
 * Build the aggregator registry with the four first-party sources registered.
 * Adding a fifth source is one line here — the orchestrator does not change.
 */
export function buildAggregatorRegistry(): ProviderRegistry<Aggregator> {
  const registry = createRegistry<Aggregator>("aggregator");
  registry.register("github", () => aggregateGitHub);
  registry.register("linear", () => aggregateLinear);
  registry.register("slack", () => aggregateSlack);
  registry.register("notion", () => aggregateNotion);
  return registry;
}
