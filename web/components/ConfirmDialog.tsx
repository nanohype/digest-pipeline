"use client";

/**
 * ConfirmDialog — modal confirmation for destructive actions. Focus-trapped,
 * Escape-to-close, `role="dialog"` + `aria-modal`, initial focus on the
 * cancel button so a stray Enter can't confirm. Backdrop click cancels, and
 * focus returns to whatever opened the dialog on unmount.
 */

import { type ReactNode, useCallback, useEffect, useId, useRef } from "react";

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface ConfirmDialogProps {
  title: string;
  children: ReactNode;
  /** Confirm-button text — name the action ("Send to entire company"), never "OK". */
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Read onCancel through a ref so the document-level keydown listener stays
  // stable across parent re-renders instead of re-subscribing each render.
  const onCancelRef = useRef(onCancel);
  useEffect(() => {
    onCancelRef.current = onCancel;
  });

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === "Escape") {
      onCancelRef.current();
      return;
    }
    if (e.key !== "Tab" || !panelRef.current) return;
    const focusable = panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === first) {
        e.preventDefault();
        last.focus();
      }
    } else if (document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }, []);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.addEventListener("keydown", handleKeyDown);
    document.body.style.overflow = "hidden";
    cancelRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "";
      opener?.focus();
    };
  }, [handleKeyDown]);

  return (
    <div
      className="dialog-root"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
    >
      <div className="dialog-backdrop" aria-hidden="true" onClick={onCancel} />
      <div ref={panelRef} className="dialog-panel">
        <h2 className="dialog-title" id={titleId}>
          {title}
        </h2>
        <div className="dialog-body" id={descriptionId}>
          {children}
        </div>
        <div className="dialog-actions">
          <button
            ref={cancelRef}
            type="button"
            className="dialog-button dialog-button--cancel"
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className="dialog-button dialog-button--confirm"
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
