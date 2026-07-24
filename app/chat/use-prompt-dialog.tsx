"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export function usePromptDialog() {
  const [promptState, setPromptState] = useState<{
    label: string;
    confirmLabel?: string;
  } | null>(null);
  const [promptDraft, setPromptDraft] = useState("");
  const promptResolveRef = useRef<((value: string | null) => void) | null>(null);
  const promptDraftRef = useRef("");
  const promptInputRef = useRef<HTMLInputElement>(null);

  const askPrompt = useCallback(
    (label: string, defaultValue = "", confirmLabel = "Save") =>
      new Promise<string | null>((resolve) => {
        promptResolveRef.current = resolve;
        promptDraftRef.current = defaultValue;
        setPromptDraft(defaultValue);
        setPromptState({ label, confirmLabel });
      }),
    [],
  );

  const closePrompt = useCallback((value?: string | null) => {
    const resolve = promptResolveRef.current;
    promptResolveRef.current = null;
    setPromptState(null);
    if (!resolve) return;
    resolve(value !== undefined && value !== null ? value : promptDraftRef.current);
  }, []);

  useEffect(() => {
    if (!promptState) return;
    const input = promptInputRef.current;
    if (input) {
      input.focus();
      input.select();
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        const resolve = promptResolveRef.current;
        promptResolveRef.current = null;
        setPromptState(null);
        resolve?.(null);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [promptState]);

  useEffect(() => {
    promptDraftRef.current = promptDraft;
  }, [promptDraft]);

  return {
    promptState,
    promptDraft,
    setPromptDraft,
    promptInputRef,
    askPrompt,
    closePrompt,
  };
}

export type PromptDialogProps = {
  label: string;
  confirmLabel?: string;
  draft: string;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onDraftChange: (value: string) => void;
  onCancel: () => void;
  onSave: () => void;
};

export function PromptDialog({
  label,
  confirmLabel,
  draft,
  inputRef,
  onDraftChange,
  onCancel,
  onSave,
}: PromptDialogProps) {
  return (
    <div className="confirm-overlay" role="presentation">
      <form
        className="confirm-modal prompt-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="prompt-dialog-title"
        onSubmit={(event) => {
          event.preventDefault();
          onSave();
        }}
      >
        <p className="confirm-message" id="prompt-dialog-title">
          {label}
        </p>
        <input
          ref={inputRef}
          className="prompt-input"
          type="text"
          value={draft}
          maxLength={120}
          autoComplete="off"
          placeholder="Untitled topic"
          onChange={(event) => onDraftChange(event.target.value)}
        />
        <div className="confirm-actions">
          <button type="button" className="confirm-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="confirm-confirm" onClick={onSave}>
            {confirmLabel ?? "Save"}
          </button>
        </div>
      </form>
    </div>
  );
}
