"use client";

import { useCallback, useEffect, useState } from "react";

type ConfirmState = {
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  checkbox?: { label: string; defaultChecked?: boolean };
  resolve: (confirmed: boolean, checked: boolean) => void;
};

export function useConfirmDialog() {
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);

  const askConfirm = useCallback(
    (message: string, confirmLabel?: string, danger = true) =>
      new Promise<boolean>((resolve) =>
        setConfirmState({ message, confirmLabel, danger, resolve: (confirmed) => resolve(confirmed) }),
      ),
    [],
  );

  const askConfirmWithCheckbox = useCallback(
    (
      message: string,
      options: { checkbox: { label: string; defaultChecked?: boolean }; confirmLabel?: string; danger?: boolean },
    ) =>
      new Promise<{ confirmed: boolean; checked: boolean }>((resolve) =>
        setConfirmState({
          message,
          confirmLabel: options.confirmLabel,
          danger: options.danger ?? true,
          checkbox: options.checkbox,
          resolve: (confirmed, checked) => resolve({ confirmed, checked }),
        }),
      ),
    [],
  );

  const closeConfirm = useCallback((confirmed: boolean, checked = false) => {
    setConfirmState((current) => {
      current?.resolve(confirmed, checked);
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

  return { confirmState, askConfirm, askConfirmWithCheckbox, closeConfirm };
}

export function ConfirmDialog({
  state,
  onCancel,
  onConfirm,
}: {
  state: ConfirmState | null;
  onCancel: () => void;
  onConfirm: (checked: boolean) => void;
}) {
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    setChecked(state?.checkbox?.defaultChecked ?? false);
  }, [state]);

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
        {state.checkbox ? (
          <label className="confirm-checkbox">
            <input
              type="checkbox"
              checked={checked}
              onChange={(event) => setChecked(event.target.checked)}
            />
            <span>{state.checkbox.label}</span>
          </label>
        ) : null}
        <div className="confirm-actions">
          <button type="button" className="confirm-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className={state.danger === false ? "confirm-confirm" : "confirm-delete"}
            onClick={() => onConfirm(checked)}
          >
            {state.confirmLabel ?? "Delete"}
          </button>
        </div>
      </div>
    </div>
  );
}
