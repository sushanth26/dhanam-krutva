export function SummaryTile({ label, value }) {
  return (
    <article className="summary-tile">
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}
