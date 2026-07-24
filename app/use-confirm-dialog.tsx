"use client";

import { useCallback, useEffect, useState } from "react";

type ConfirmState = {
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  resolve: (value: boolean) => void;
};

export function useConfirmDialog() {
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);

  const askConfirm = useCallback(
    (message: string, confirmLabel?: string, danger = true) =>
      new Promise<boolean>((resolve) =>
        setConfirmState({ message, confirmLabel, danger, resolve }),
      ),
    [],
  );

  const closeConfirm = useCallback((value: boolean) => {
    setConfirmState((current) => {
      current?.resolve(value);
      return null;
    });
  }, []);

  useEffect(() => {
    if (!confirmState) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") closeConfirm(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [closeConfirm, confirmState]);

  return { confirmState, askConfirm, closeConfirm };
}

export function ConfirmDialog({
  state,
  onCancel,
  onConfirm,
}: {
  state: ConfirmState | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (!state) return null;

  return (
    <div className="confirm-overlay" role="presentation">
      <div
        className="confirm-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-message"
      >
        <p className="confirm-message" id="confirm-dialog-message">
          {state.message}
        </p>
        <div className="confirm-actions">
          <button type="button" className="confirm-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className={state.danger === false ? "confirm-confirm" : "confirm-delete"}
            onClick={onConfirm}
          >
            {state.confirmLabel ?? "Delete"}
          </button>
        </div>
      </div>
    </div>
  );
}
