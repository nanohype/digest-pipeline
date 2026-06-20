/**
 * Canonical newsletter sections — the single source of truth for section
 * order and display names. Imported by the ranker (which groups items into
 * these sections) and the generator (which renders + validates these exact
 * headers). Keeping one copy prevents the two from drifting, which would
 * otherwise surface as a spurious "missing sections" generation failure.
 */

import type { SectionName } from './types.js';

export const SECTION_ORDER: SectionName[] = [
  'what_shipped',
  'whats_coming',
  'new_joiners',
  'wins_recognition',
  'the_ask',
];

export const SECTION_DISPLAY_NAMES: Record<SectionName, string> = {
  what_shipped: '🚀 What Shipped',
  whats_coming: "📅 What's Coming",
  new_joiners: '👋 New Joiners',
  wins_recognition: '🏆 Wins & Recognition',
  the_ask: '📣 The Ask',
};
