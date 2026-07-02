export function MtfToast({ message, changed }) {
  if (!message) return null;
  return (
    <div className={`mtf-toast ${changed ? "changed" : ""}`} aria-live="polite">
      {message}
    </div>
  );
}
