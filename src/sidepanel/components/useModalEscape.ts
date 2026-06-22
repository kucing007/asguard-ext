import { useEffect } from "preact/hooks";

/**
 * Closes a modal on Escape. Call at the top of a component that renders a modal:
 *   useModalEscape(showX, () => setShowX(false));
 * Dependency is `open` only (onClose is captured), so the listener doesn't
 * re-subscribe on every render.
 */
export function useModalEscape(open: boolean, onClose: () => void): void {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
}
