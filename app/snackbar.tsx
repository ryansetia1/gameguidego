"use client";

import { useEffect, useRef } from "react";

/**
 * Auto-dismissing toast reusing the app's `.snackbar` style (fixed, bottom-center).
 * Renders nothing when `message` is empty. The dismiss ref keeps the timer tied to
 * the message, not to the parent's render identity.
 */
export function Snackbar({
  message,
  onDismiss,
  duration = 3500,
}: {
  message: string;
  onDismiss: () => void;
  duration?: number;
}) {
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => onDismissRef.current(), duration);
    return () => clearTimeout(timer);
  }, [message, duration]);

  if (!message) return null;
  return (
    <div className="snackbar" role="status" aria-live="polite">
      {message}
    </div>
  );
}
