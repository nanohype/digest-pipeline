/**
 * DiffIndicator — shows character-level edit rate vs the auto-draft.
 * Thresholds come from the voice-matching playbook: ≤5% is green,
 * ≤10% yellow, ≤20% amber, anything higher is red (drift alert
 * territory).
 */

interface DiffIndicatorProps {
  editRate: number;
  isSaving: boolean;
}

export function DiffIndicator({ editRate, isSaving }: DiffIndicatorProps) {
  const pct = Math.round(editRate * 1000) / 10;
  const tone = pct < 5 ? "good" : pct < 10 ? "warn" : pct < 20 ? "amber" : "danger";
  // No aria-label on the wrapper. A plain div has an implicit `generic` role,
  // which does not support one — so the label was silently dropped and the edit
  // rate was announced to nobody. Giving the div a role that accepts the label
  // would be worse: the label then *replaces* the contents, so "Edit rate:
  // 7.2%" would be read in place of the target the reviewer is measured
  // against. The visible text already reads as a complete sentence in DOM order
  // — "Edit rate 7.2% target ≤10%" — so the accessible name is left to it.
  return (
    <div className="diff-indicator">
      <span className="diff-label">Edit rate</span>
      <span className={`diff-value diff-value--${tone}`}>{pct}%</span>
      <span className="diff-target">target ≤10%</span>
      {isSaving ? (
        <span className="saving-indicator" aria-live="polite">
          saving…
        </span>
      ) : null}
    </div>
  );
}
