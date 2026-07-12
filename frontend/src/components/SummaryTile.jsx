export function SummaryTile({ label, value }) {
  return (
    <article className="auto-trade-summary-tile">
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}
