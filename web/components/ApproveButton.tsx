/**
 * ApproveButton — explicit send-to-company action with a confirmation
 * prompt. Intentionally unflashy; this button pushes email to 500
 * inboxes, so surprise is bad.
 */

interface ApproveButtonProps {
  onApprove: () => Promise<void>;
  isApproving: boolean;
  disabled: boolean;
}

export function ApproveButton({ onApprove, isApproving, disabled }: ApproveButtonProps) {
  const handleClick = async () => {
    const confirmed = window.confirm(
      'Send this newsletter to the entire company?\n\nThis action cannot be undone.'
    );
    if (!confirmed) return;
    await onApprove();
  };

  return (
    <button
      className="approve-button"
      onClick={handleClick}
      disabled={disabled || isApproving}
      aria-busy={isApproving}
      aria-disabled={disabled || isApproving}
    >
      {isApproving ? 'Sending…' : 'Approve & send'}
    </button>
  );
}
