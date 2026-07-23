"use client";

import { useEffect } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { ActionButton } from "@/app/components/ui/controls";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Stacks crashed:", error);
  }, [error]);

  return (
    <main className="error-boundary" role="alert">
      <span className="error-boundary-icon" aria-hidden="true">
        <AlertTriangle size={26} />
      </span>
      <h1>Something went wrong</h1>
      <p>
        The workspace hit an unexpected error. Your library is safe. Reloading this
        view usually clears it.
      </p>
      {error.digest ? <code className="error-boundary-digest">Reference: {error.digest}</code> : null}
      <div className="error-boundary-actions">
        <ActionButton variant="primary" onClick={reset} icon={<RotateCcw />}>
          Try again
        </ActionButton>
        <ActionButton variant="secondary" onClick={() => window.location.assign("/")}>
          Back to library
        </ActionButton>
      </div>
    </main>
  );
}
