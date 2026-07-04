export function AlarmPanel({ message, changed }) {
  if (!message) return null;
  return (
    <div className={`alarm-panel ${changed ? "changed" : ""}`} role="status" aria-live="polite">
      <strong>Alarm</strong>
      <span>{message}</span>
    </div>
  );
}
