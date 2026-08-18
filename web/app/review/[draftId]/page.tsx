"use client";

/**
 * Draft review & approval page.
 * - Full preview with section structure
 * - Inline editable textarea, 2s debounced save via proxy API
 * - Character diff indicator vs auto-draft
 * - Approve button with confirmation dialog
 * - Status banner for non-PENDING drafts
 *
 * Auth is handled by the AuthKit middleware — by the time this page
 * renders, the user is guaranteed to be signed in. API calls go
 * through the /api/drafts proxy which extracts the access token from
 * the session cookie.
 */

import { use, useCallback, useEffect, useId, useRef, useState } from "react";
import { ApproveButton } from "@/components/ApproveButton";
import { DiffIndicator } from "@/components/DiffIndicator";
import { levenshteinDistance } from "@/lib/diff";

interface DraftSection {
  name: string;
  displayName: string;
  items: Array<{
    title: string;
    description?: string;
    author?: { displayName: string; role: string };
  }>;
}

interface Draft {
  id: string;
  weekOf: string;
  status: "PENDING" | "APPROVED" | "EXPIRED" | "SENT" | "FAILED";
  fullText: string;
  sections: DraftSection[];
  createdAt: string;
}

interface RouteParams {
  draftId: string;
}

export default function ReviewPage({ params }: { params: Promise<RouteParams> }) {
  const { draftId } = use(params);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editedText, setEditedText] = useState("");
  const [originalText, setOriginalText] = useState("");
  const [isApproving, setIsApproving] = useState(false);
  const [approveError, setApproveError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editorId = useId();

  useEffect(() => {
    void fetch(`/api/drafts/${draftId}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as Draft;
      })
      .then((data) => {
        setDraft(data);
        setEditedText(data.fullText);
        setOriginalText(data.fullText);
      })
      .catch((err: unknown) => {
        setLoadError(err instanceof Error ? err.message : "Failed to load draft");
      });
  }, [draftId]);

  const handleTextChange = useCallback(
    (newText: string) => {
      setEditedText(newText);
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(async () => {
        if (!draft) return;
        setIsSaving(true);
        try {
          await fetch(`/api/drafts/${draft.id}/edits`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ editedText: newText }),
          });
        } finally {
          setIsSaving(false);
        }
      }, 2_000);
    },
    [draft],
  );

  const handleApprove = async () => {
    if (!draft) return;
    setIsApproving(true);
    setApproveError(null);
    try {
      const res = await fetch(`/api/drafts/${draft.id}/approve`, { method: "POST" });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? "Approval failed");
      }
      setDraft((d) => (d ? { ...d, status: "SENT" } : d));
    } catch (err) {
      setApproveError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setIsApproving(false);
    }
  };

  if (!draft) {
    return (
      <main className="page-shell">
        {loadError ? (
          <div className="error-banner" role="alert">
            Could not load draft: {loadError}
          </div>
        ) : (
          <p className="muted">Loading draft…</p>
        )}
      </main>
    );
  }

  const editRate =
    originalText.length > 0
      ? levenshteinDistance(originalText, editedText) / originalText.length
      : 0;
  const isPending = draft.status === "PENDING";

  return (
    <main className="page-shell review-page">
      <header className="review-header">
        <h1>Weekly newsletter review</h1>
        <p className="muted">
          Week of{" "}
          {new Date(draft.weekOf).toLocaleDateString("en-US", {
            month: "long",
            day: "numeric",
            year: "numeric",
          })}
        </p>
        {!isPending ? <div className="status-banner">{draft.status}</div> : null}
        {isPending ? (
          <div className="actions-row">
            <DiffIndicator editRate={editRate} isSaving={isSaving} />
            <ApproveButton
              onApprove={handleApprove}
              isApproving={isApproving}
              disabled={!isPending}
            />
          </div>
        ) : null}
        {approveError ? (
          <div className="error-banner" role="alert">
            {approveError}
          </div>
        ) : null}
      </header>

      <section className="draft-section">
        <div className="draft-columns">
          <div className="draft-preview-pane">
            <h2>Preview</h2>
            <pre>{draft.fullText}</pre>
          </div>
          {isPending ? (
            <div className="draft-edit-pane">
              {/* label-in-heading keeps the pane's h2 semantics while giving the
                  textarea a real htmlFor/id association */}
              <h2>
                <label htmlFor={editorId}>Edit</label>
              </h2>
              <textarea
                id={editorId}
                className="draft-editor"
                value={editedText}
                onChange={(e) => handleTextChange(e.target.value)}
                rows={40}
              />
            </div>
          ) : null}
        </div>
      </section>
    </main>
  );
}
