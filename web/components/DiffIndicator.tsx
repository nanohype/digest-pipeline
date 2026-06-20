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
  const tone = pct < 5 ? 'good' : pct < 10 ? 'warn' : pct < 20 ? 'amber' : 'danger';
  return (
    <div className="diff-indicator" aria-label={`Edit rate: ${pct}%`}>
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
