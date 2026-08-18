"use client";

/**
 * ApproveButton — explicit send-to-company action gated by a modal
 * confirmation dialog. Intentionally unflashy; this button pushes email to
 * 500 inboxes, so surprise is bad.
 */

import { useState } from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";

interface ApproveButtonProps {
  onApprove: () => Promise<void>;
  isApproving: boolean;
  disabled: boolean;
}

export function ApproveButton({ onApprove, isApproving, disabled }: ApproveButtonProps) {
  const [confirming, setConfirming] = useState(false);

  const handleConfirm = async () => {
    setConfirming(false);
    await onApprove();
  };

  return (
    <>
      <button
        // Explicit, because the HTML default is `submit`. This button opens a
        // confirmation dialog; inside a form it would instead submit it, which
        // on the one control that mails a newsletter to the whole company is
        // the wrong default to inherit silently.
        type="button"
        className="approve-button"
        onClick={() => setConfirming(true)}
        disabled={disabled || isApproving}
        aria-busy={isApproving}
        aria-disabled={disabled || isApproving}
        aria-haspopup="dialog"
      >
        {isApproving ? "Sending…" : "Approve & send"}
      </button>
      {confirming ? (
        <ConfirmDialog
          title="Send this newsletter to the entire company?"
          confirmLabel="Send to entire company"
          cancelLabel="Cancel"
          onConfirm={() => void handleConfirm()}
          onCancel={() => setConfirming(false)}
        >
          <p>
            This delivers the current draft to every employee&apos;s inbox. Sending cannot be
            undone.
          </p>
        </ConfirmDialog>
      ) : null}
    </>
  );
}
