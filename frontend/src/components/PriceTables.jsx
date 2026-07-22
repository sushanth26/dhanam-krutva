import { useEffect, useMemo, useState } from "react";

import { CloudTag } from "./Tags";
import { cloudStatus, formatPrice } from "../lib/market";

export function MtfTable({
  quotes,
  showWatchlist = false,
  title = "MTFs",
  subtitle = "",
  buyState = {},
  emptyText = "No stocks are on hourly or daily EMA clouds right now.",
  focusedSymbol = "",
  compact = false,
  hideHeading = false,
  onBuy,
  onDismissNew,
}) {
  const columns = compact ? [
    { key: "symbol", label: "Symbol", value: (quote) => quote.symbol || "" },
    { key: "mtf", label: "4A-7P", value: (quote) => latestMtfTime(quote) },
    { key: "signal", label: "Signal", value: (quote) => tradeActionForMatches(quote.mtf_matches) || "Wait" },
    { key: "bias", label: "Bias", value: (quote) => biasSummaryForQuote(quote).label },
  ] : [
    { key: "symbol", label: "Symbol", value: (quote) => quote.symbol || "" },
    ...(showWatchlist ? [{ key: "watchlist", label: "Watchlist", value: (quote) => quote.watchlist_name || "" }] : []),
    { key: "mtf", label: "MTF", value: (quote) => mtfDisplayMatches(quote.mtf_matches).map(({ label }) => label).join(" ") },
    { key: "structure", label: "BOS", value: (quote) => quote.structure_10m?.status || "Unknown" },
    { key: "bias", label: "Bias", value: (quote) => tradeActionForMatches(quote.mtf_matches) || directionalBiasForQuote(quote) },
    { key: "plan", label: "Trade plan", value: (quote) => mtfPlanSortValue(quote) },
    { key: "time", label: "Time", value: (quote) => latestMtfTime(quote) },
  ];
  const defaultSort = compact ? { key: "mtf", direction: "desc" } : { key: "time", direction: "desc" };
  const { sortedRows: sortedQuotes, sort, toggleSort } = useSortableRows(quotes, columns, defaultSort);
  const showActions = Boolean(onBuy) && !compact;
  const nowPosition = useTimelineNowPosition();

  return (
    <section className="price-bucket mtf-bucket">
      {hideHeading ? null : (
        <div className="bucket-heading">
          <div className="bucket-title">
            <h3>{title}</h3>
            {subtitle ? <p>{subtitle}</p> : null}
          </div>
          <span>{quotes.length}</span>
        </div>
      )}
      <div className="live-price-table-wrap">
        <table className={`live-price-table ${showWatchlist ? "global-mtf-table" : ""} ${compact ? "compact-mtf-table" : ""}`}>
          <thead>
            <tr>
              {columns.map((column) => (
                <SortHeader key={column.key} column={column} sort={sort} onSort={toggleSort} />
              ))}
              {showActions ? <th className="action-col" aria-label="Actions"></th> : null}
            </tr>
          </thead>
          <tbody>
            {sortedQuotes.length ? sortedQuotes.map((quote) => (
              <MtfRow
                key={`${quote.watchlist_id || "tab"}-${quote.symbol}`}
                buyState={buyState[quote.symbol]}
                focused={quote.symbol === focusedSymbol}
                quote={quote}
                showWatchlist={showWatchlist}
                compact={compact}
                nowPosition={nowPosition}
                onBuy={onBuy}
                onDismissNew={onDismissNew}
              />
            )) : (
              <tr><td colSpan={columns.length + (showActions ? 1 : 0)}>{emptyText}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function PriceBucket({ title, quotes, kind, compact = false, onRemoveSymbol }) {
  const columns = compact ? [
    { key: "symbol", label: "Symbol", value: (quote) => quote.symbol || "" },
    { key: "structure", label: "Structure", value: (quote) => quote.structure_10m?.status || "Unknown" },
    { key: "bias", label: "Bias", value: (quote) => watchlistBiasSortValue(quote) },
  ] : [
    { key: "symbol", label: "Symbol", value: (quote) => quote.symbol || "" },
    { key: "trend", label: "Trend", value: (quote) => cloudStatus(quote.ema_10m, ["5", "12"], ["34", "50"]) },
    { key: "structure", label: "BOS", value: (quote) => quote.structure_10m?.status || "Unknown" },
    { key: "bias", label: "Bias", value: (quote) => watchlistBiasSortValue(quote) },
    { key: "price", label: "Last", className: "price-col", value: (quote) => Number(quote.price) },
  ];
  const { sortedRows, sort, toggleSort } = useSortableRows(quotes, columns, { key: "bias", direction: "asc" });
  const showActions = Boolean(onRemoveSymbol) && !compact;

  return (
    <section className={`price-bucket ${compact ? "compact-watchlist-bucket" : ""} ${kind ? `watchlist-${kind}` : ""}`}>
      <div className="bucket-heading">
        <h3>{title}</h3>
        <span>{quotes.length}</span>
      </div>
      <div className="live-price-table-wrap">
        <table className="live-price-table">
          <thead>
            <tr>
              {columns.map((column) => (
                <SortHeader key={column.key} column={column} sort={sort} onSort={toggleSort} />
              ))}
              {showActions ? <th className="action-col" aria-label="Actions"></th> : null}
            </tr>
          </thead>
          <tbody>
            {sortedRows.length ? sortedRows.map((quote) => (
              <PriceRow key={quote.symbol} compact={compact} quote={quote} onRemoveSymbol={showActions ? onRemoveSymbol : null} />
            )) : (
              <tr><td colSpan={columns.length + (showActions ? 1 : 0)}>No {kind} stocks right now.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function PreMarketScannerTable({ rows }) {
  const columns = [
    { key: "symbol", label: "Stock", value: (row) => row.symbol || "" },
    { key: "gap", label: "Gap", value: (row) => gapActionLabel(row.action) },
    { key: "trend", label: "10m", className: "scanner-trend-col", value: (row) => row.trend || "" },
    { key: "structure", label: "BOS", value: (row) => row.structure || "Unknown" },
    { key: "bias", label: "Bias", value: (row) => directionalBiasForRow(row) },
    { key: "trigger", label: "Level", className: "scanner-trigger-col", value: (row) => row.trigger || "" },
    { key: "price", label: "Last", className: "price-col", value: (row) => Number(row.price) },
    { key: "previousHigh", label: "YH", className: "price-col", value: (row) => Number(row.previousHigh) },
    { key: "previousLow", label: "YL", className: "price-col", value: (row) => Number(row.previousLow) },
    { key: "move", label: "Move", className: "price-col scanner-move-col", value: (row) => Number(row.distancePct) },
    { key: "list", label: "List", className: "scanner-list-col", value: (row) => row.watchlistName || "" },
  ];
  const { sortedRows, sort, toggleSort } = useSortableRows(rows, columns, { key: "gap", direction: "asc" });

  return (
    <section className="price-bucket premarket-scanner-bucket">
      <div className="bucket-heading">
        <h3>Gap Up / Down</h3>
        <span>{rows.length}</span>
      </div>
      <div className="live-price-table-wrap">
        <table className="live-price-table premarket-scanner-table">
          <thead>
            <tr>
              {columns.map((column) => (
                <SortHeader key={column.key} column={column} sort={sort} onSort={toggleSort} />
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedRows.length ? sortedRows.map((row) => (
              <tr key={row.symbol} className={`stock-row scanner-${row.action.toLowerCase()}`}>
                <td data-label="Stock"><strong>{row.symbol}</strong></td>
                <td data-label="Gap" className="scanner-side-cell">
                  <span className={`scanner-action ${row.action.toLowerCase()}`}>{gapActionLabel(row.action)}</span>
                </td>
                <td data-label="10m" className="scanner-trend-cell"><CloudTag status={row.trend} /></td>
                <td data-label="BOS"><span className={`structure-pill ${structureClass(row.structure)}`}>{structureLabel(row.structure)}</span></td>
                <td data-label="Bias"><DirectionPill value={directionalBiasForRow(row)} /></td>
                <td data-label="Level" className="scanner-trigger-cell">{gapTriggerLabel(row.trigger)}</td>
                <td data-label="Last" className="price-cell last-price-cell">{formatPrice(row.price)}</td>
                <td data-label="YH" className="price-cell range-high-cell">{formatPrice(row.previousHigh)}</td>
                <td data-label="YL" className="price-cell range-low-cell">{formatPrice(row.previousLow)}</td>
                <td data-label="Move" className="price-cell scanner-move-cell">{formatPercent(row.distancePct)}</td>
                <td data-label="List" className="scanner-list-cell">{row.watchlistName || "-"}</td>
              </tr>
            )) : (
              <tr className="scanner-empty-row"><td colSpan="11">No gap up or gap down names.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function SpyComparisonTable({ rows, spyQuote, subtitle = "", title = "Watchlist 5/12 Cloud", tone = "", badge = "" }) {
  const columns = [
    { key: "action", label: "Long/Short", value: (row) => row.focusAction || directionalBiasForRow(row) },
    { key: "symbol", label: "Stock", value: (row) => row.symbol || "" },
    { key: "price", label: "Last", className: "price-col", value: (row) => Number(row.price) },
  ];
  const { sortedRows, sort, toggleSort } = useSortableRows(rows, columns, { key: "__focusOrder", direction: "asc" });
  const bucketClassName = [
    "price-bucket",
    "spy-comparison-bucket",
    tone ? `spy-${tone}` : "",
    badge ? "is-priority" : "",
  ].filter(Boolean).join(" ");

  return (
    <section className={bucketClassName}>
      <div className="bucket-heading">
        <div className="bucket-title">
          <h3>
            {title}
            {badge ? <small className="spy-focus-badge">{badge}</small> : null}
          </h3>
          {subtitle ? <p>{subtitle}</p> : null}
        </div>
        <span>{rows.length}</span>
      </div>
      <div className="live-price-table-wrap">
        <table className="live-price-table spy-comparison-table">
          <thead>
            <tr>
              {columns.map((column) => (
                <SortHeader key={column.key} column={column} sort={sort} onSort={toggleSort} />
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedRows.length ? sortedRows.map((row) => (
              <tr key={row.symbol} className={`stock-row trend-${String(row.trend || "chop").toLowerCase()}`}>
                <td data-label="Long/Short"><DirectionPill value={row.focusAction || directionalBiasForRow(row)} /></td>
                <td data-label="Stock"><strong>{row.symbol}</strong></td>
                <td data-label="Last" className="price-cell muted-price">{formatPrice(row.price)}</td>
              </tr>
            )) : (
              <tr className="scanner-empty-row">
                <td colSpan="3">No focus names right now.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function structureLabel(value) {
  const text = String(value || "Unknown");
  if (text === "Bullish BOS") return "Bull BOS";
  if (text === "Bearish BOS") return "Bear BOS";
  return text;
}

function cloudSetupLabel(value) {
  const text = String(value || "-");
  if (text === "Break Curl Down") return "Break Curl";
  if (text === "Above 5/12") return "Above";
  if (text === "Below 5/12") return "Below";
  return text;
}

function structureClass(value) {
  const text = String(value || "").toLowerCase();
  if (text.includes("bullish")) return "bullish";
  if (text.includes("bearish")) return "bearish";
  if (text.includes("chop") || text.includes("intact")) return "chop";
  return "unknown";
}

function directionalBiasForQuote(quote) {
  return directionalBiasForRow({
    cloudBias: quote?.ema_10m_cloud?.bias,
    trend: cloudStatus(quote?.ema_10m, ["5", "12"], ["34", "50"]),
    structure: quote?.structure_10m?.status,
  });
}

function watchlistBiasSortValue(quote) {
  const bias = directionalBiasForQuote(quote);
  const rank = { Long: 0, Wait: 1, Short: 2 }[bias] ?? 3;
  return `${rank}-${quote.symbol || ""}`;
}

function directionalBiasForRow(row) {
  const structure = String(row?.structure || "").toLowerCase();
  const cloud = String(row?.status || row?.trend || "").toLowerCase();
  const cloudBias = String(row?.cloudBias || "").toLowerCase();
  const action = String(row?.action || "").toLowerCase();
  const bullishStructure = structure.includes("bullish");
  const bearishStructure = structure.includes("bearish");
  const bullishCloud = cloud === "above" || cloud === "bullish";
  const bearishCloud = cloud === "below" || cloud === "bearish";
  if (bullishStructure && (bullishCloud || cloudBias === "long" || action === "long")) return "Long";
  if (bearishStructure && (bearishCloud || cloudBias === "short" || action === "short")) return "Short";
  return "Wait";
}

function DirectionPill({ value }) {
  const label = value || "Wait";
  return <span className={`direction-pill ${label.toLowerCase()}`}>{label}</span>;
}

function gapActionLabel(action) {
  if (action === "Long") return "Gap Up";
  if (action === "Short") return "Gap Down";
  return action || "-";
}

function gapTriggerLabel(trigger) {
  if (trigger === "Above YH") return "Above YH";
  if (trigger === "Below YL") return "Below YL";
  return trigger || "-";
}

function formatPercent(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? `${numeric.toFixed(2)}%` : "-";
}

function formatDistance(value) {
  const numeric = Math.abs(Number(value));
  return Number.isFinite(numeric) ? `${numeric.toFixed(2)}%` : "-";
}

function SortHeader({ column, sort, onSort }) {
  const active = sort.key === column.key;
  const direction = active ? sort.direction : "";
  return (
    <th className={column.className || ""}>
      <button
        type="button"
        className={`sort-header-button ${active ? "active" : ""}`}
        onClick={() => onSort(column.key)}
        aria-label={`Sort by ${column.label}${active ? ` ${direction === "asc" ? "descending" : "ascending"}` : ""}`}
      >
        {column.label}
        <span aria-hidden="true">{active ? (direction === "asc" ? "▲" : "▼") : "↕"}</span>
      </button>
    </th>
  );
}

function useSortableRows(rows, columns, defaultSort) {
  const [sort, setSort] = useState(defaultSort || { key: columns[0]?.key || "", direction: "asc" });
  const sortedRows = useMemo(() => {
    const column = columns.find((item) => item.key === sort.key);
    if (!column) return rows;
    const direction = sort.direction === "desc" ? -1 : 1;
    return [...rows].sort((left, right) => compareSortValues(column.value(left), column.value(right)) * direction);
  }, [columns, rows, sort]);

  function toggleSort(key) {
    setSort((current) => ({
      key,
      direction: current.key === key && current.direction === "asc" ? "desc" : "asc",
    }));
  }

  return { sortedRows, sort, toggleSort };
}

function compareSortValues(left, right) {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  const bothNumeric = Number.isFinite(leftNumber) && Number.isFinite(rightNumber);
  if (bothNumeric) return leftNumber - rightNumber;
  return String(left ?? "").localeCompare(String(right ?? ""), undefined, { numeric: true, sensitivity: "base" });
}

function mtfPlanSortValue(quote) {
  const riskPlan = aPlusPlusRiskPlan(quote.mtf_matches);
  if (riskPlan?.entry != null) return Number(riskPlan.entry);
  return tradeActionForMatches(quote.mtf_matches) || "";
}

function MtfRow({ buyState, compact, focused, nowPosition, quote, showWatchlist, onBuy, onDismissNew }) {
  const triggerTime = mtfTriggerTime(quote.mtf_matches);
  const riskPlan = aPlusPlusRiskPlan(quote.mtf_matches);
  const tradeAction = tradeActionForMatches(quote.mtf_matches);
  const tenMinuteStatus = cloudStatus(quote.ema_10m, ["5", "12"], ["34", "50"]);
  const dismissNew = quote.is_new ? () => onDismissNew?.(quote) : undefined;
  const rowId = ["mtf-row", quote.watchlist_id || "tab", quote.symbol].join("-");
  const mtfTags = (
    <td className="mtf-label-cell" data-label="MTF">
      <MtfTimeline matches={quote.mtf_matches} nowPosition={nowPosition} />
      <span className="mtf-tag-stack">
        {mtfDisplayMatches(quote.mtf_matches).map(({ label, match }) => (
          <MtfTouchPill key={`${label}-${match?.candle_time || ""}`} label={label} match={match} />
        ))}
      </span>
    </td>
  );
  const watchlistCell = showWatchlist ? (
    <td className="watchlist-cell" data-label="Watchlist">
      {quote.watchlist_name || "-"}
      {quote.is_new ? <NewTag onDismiss={dismissNew} symbol={quote.symbol} /> : null}
    </td>
  ) : null;

  if (compact) {
    return (
      <BaseRow
        className={focused ? "focused-mtf-row" : ""}
        dataMtfSymbol={quote.symbol}
        id={rowId}
        quote={quote}
        showCompanyName={false}
        showPrice={false}
        trend={tenMinuteStatus}
        onClick={dismissNew}
      >
        {mtfTags}
        <td className="signal-cell" data-label="Signal"><DirectionPill value={tradeAction || "Wait"} /></td>
        <td className="bias-cell" data-label="Bias"><BiasMeter bias={biasSummaryForQuote(quote)} /></td>
      </BaseRow>
    );
  }

  return (
    <BaseRow
      className={focused ? "focused-mtf-row" : ""}
      dataMtfSymbol={quote.symbol}
      id={rowId}
      quote={quote}
      showPrice={false}
      trend={tenMinuteStatus}
      onClick={dismissNew}
      action={(
        <BuyCell
          buyState={buyState}
          disabled={!onBuy}
          onBuy={() => onBuy?.(quote)}
          symbol={quote.symbol}
          tradeAction={tradeAction}
        />
      )}
    >
      {watchlistCell}
      {mtfTags}
      <td data-label="BOS"><span className={`structure-pill ${structureClass(quote.structure_10m?.status)}`}>{structureLabel(quote.structure_10m?.status)}</span></td>
      <td data-label="Bias"><DirectionPill value={tradeAction || directionalBiasForQuote(quote)} /></td>
      <td className="mtf-plan-cell" data-label="Trade plan">
        {riskPlan ? <RiskPlan plan={riskPlan} /> : <span className="confirmed-setup">Confirmed</span>}
      </td>
      <td className="trigger-time" data-label="Time">{triggerTime}</td>
    </BaseRow>
  );
}

function MtfTouchPill({ label, match }) {
  const normalized = String(label || "").trim();
  const timeframe = mtfTimeframeLabel(normalized);
  const tone = mtfPillTone(normalized);
  const level = normalized.replace(/^(Daily|Hourly|Hour|1D|1H|10m)\s*/i, "").replace(/\s*touch$/i, "").trim();
  const touchTime = mtfTouchTime(match);
  return (
    <span className={`mtf-touch-pill tf-${timeframe.toLowerCase()} ${tone}`}>
      <b>{timeframe}</b>
      <span>{level || normalized}</span>
      {touchTime ? <time>{touchTime}</time> : null}
    </span>
  );
}

function MtfTimeline({ matches, nowPosition }) {
  const [activeEvent, setActiveEvent] = useState("");
  const events = mtfTimelineMatches(matches)
    .map(({ label, match }, index) => {
      const time = mtfTouchTime(match);
      return {
        id: `${label}-${match?.candle_time || time}-${index}`,
        label,
        match,
        position: mtfTimelinePosition(match?.candle_time),
        time,
        tone: mtfPillTone(label),
      };
    })
    .filter((event) => event.position != null);
  const timelineStyle = nowPosition == null ? undefined : { "--now-left": `${nowPosition}%` };
  return (
    <div className={`mtf-timeline ${nowPosition == null ? "no-live-time" : ""}`} style={timelineStyle} aria-label="MTF touch timeline from 4 AM to 7 PM">
      <span className="mtf-session-band premarket" aria-hidden="true"></span>
      <span className="mtf-session-band regular" aria-hidden="true"></span>
      <span className="mtf-session-band postmarket" aria-hidden="true"></span>
      <span className="mtf-session-divider open" aria-hidden="true"></span>
      <span className="mtf-session-divider close" aria-hidden="true"></span>
      {events.map((event) => (
        <button
          key={event.id}
          type="button"
          className={`mtf-event-bar ${event.tone} ${activeEvent === event.id ? "active" : ""}`}
          style={{ "--event-left": `${event.position}%` }}
          title={`${event.label} ${event.time}`}
          aria-label={`${event.label} touched at ${event.time}`}
          onClick={(clickEvent) => {
            clickEvent.stopPropagation();
            setActiveEvent((current) => current === event.id ? "" : event.id);
          }}
          onBlur={() => setActiveEvent("")}
          onPointerDown={(pointerEvent) => pointerEvent.stopPropagation()}
        >
          <span className="mtf-event-tooltip">
            <b>{event.label}</b>
            <time>{event.time}</time>
          </span>
        </button>
      ))}
      <span className="mtf-live-marker" aria-hidden="true"></span>
    </div>
  );
}

function mtfTimelineMatches(matches = []) {
  return matches
    .map((match) => ({
      label: String(match.display_label || match.label || "").trim(),
      match,
    }))
    .filter(({ label }) => label)
    .sort((left, right) => mtfMatchTimeValue(left.match) - mtfMatchTimeValue(right.match));
}

function mtfTimeframeLabel(label) {
  const text = String(label || "").toLowerCase();
  if (text.startsWith("daily") || text.startsWith("1d")) return "1D";
  if (text.startsWith("hour") || text.startsWith("1h")) return "1H";
  if (text.startsWith("10m")) return "10m";
  return "MTF";
}

function mtfPillTone(label) {
  const text = String(label || "").toLowerCase();
  if (text.includes("hourly") || text.includes("1h")) return "mtf-hourly";
  if (text.includes("20/21")) return "mtf-daily-fast";
  if (text.includes("50/55")) return "mtf-daily-slow";
  return "mtf-default";
}

function mtfDisplayMatches(matches = []) {
  const items = [];
  const indexByLabel = new Map();
  for (const match of matches) {
    const label = String(match.display_label || match.label || "").trim();
    if (!label) continue;
    const existingIndex = indexByLabel.get(label);
    if (existingIndex == null) {
      indexByLabel.set(label, items.length);
      items.push({ label, match });
      continue;
    }
    if (mtfMatchTimeValue(match) >= mtfMatchTimeValue(items[existingIndex].match)) {
      items[existingIndex] = { label, match };
    }
  }
  return items;
}

function latestMtfTime(quote) {
  const times = (quote.mtf_matches || [])
    .map((match) => Date.parse(match.candle_time || ""))
    .filter(Number.isFinite);
  return times.length ? Math.max(...times) : 0;
}

function mtfMatchTimeValue(match) {
  const parsed = Date.parse(match?.candle_time || "");
  return Number.isFinite(parsed) ? parsed : -Infinity;
}

function mtfTouchTime(match) {
  return mtfMarketClock(match?.candle_time)?.label || "";
}

const MTF_TIMELINE_START_MINUTES = 4 * 60;
const MTF_TIMELINE_END_MINUTES = 19 * 60;
const MTF_TIMELINE_RANGE_MINUTES = MTF_TIMELINE_END_MINUTES - MTF_TIMELINE_START_MINUTES;

function useTimelineNowPosition() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const interval = window.setInterval(() => setNow(new Date()), 30 * 1000);
    return () => window.clearInterval(interval);
  }, []);
  return mtfTimelinePosition(now, false);
}

function mtfTimelinePosition(value, clamp = true) {
  const clock = mtfMarketClock(value);
  if (!clock) return null;
  const minutes = clock.minutes;
  if (!clamp && (minutes < MTF_TIMELINE_START_MINUTES || minutes > MTF_TIMELINE_END_MINUTES)) return null;
  const boundedMinutes = clampNumber(minutes, MTF_TIMELINE_START_MINUTES, MTF_TIMELINE_END_MINUTES);
  return ((boundedMinutes - MTF_TIMELINE_START_MINUTES) / MTF_TIMELINE_RANGE_MINUTES) * 100;
}

function mtfMarketClock(value) {
  if (!value) return null;
  if (value instanceof Date) return marketClockFromDate(value);
  const text = String(value);
  const isoClock = text.match(/T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/);
  if (isoClock) {
    const hours = Number(isoClock[1]);
    const minutes = Number(isoClock[2]);
    if (Number.isFinite(hours) && Number.isFinite(minutes)) {
      return {
        label: `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`,
        minutes: hours * 60 + minutes,
      };
    }
  }
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  return marketClockFromDate(parsed);
}

function marketClockFromDate(value) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const hours = Number(parts.find((part) => part.type === "hour")?.value);
  const minutes = Number(parts.find((part) => part.type === "minute")?.value);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  return {
    label: `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`,
    minutes: hours * 60 + minutes,
  };
}

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function biasSummaryForQuote(quote) {
  const direction = directionalBiasForQuote(quote);
  if (direction === "Long") return { label: "Bullish", tone: "bullish", icon: "▲" };
  if (direction === "Short") return { label: "Bearish", tone: "bearish", icon: "▼" };
  return { label: "Neutral", tone: "neutral", icon: "−" };
}

function BiasMeter({ bias }) {
  return (
    <span className={`bias-meter ${bias.tone}`}>
      <span>{bias.icon}</span>
      <b>{bias.label}</b>
    </span>
  );
}

function RiskPlan({ plan }) {
  return (
    <span className="risk-plan">
      <span>Entry {formatPrice(plan.entry)}</span>
      Qty <b>{plan.shares}</b>
      <span>SL {formatPrice(plan.stop)}</span>
      <small>Risk {formatPrice(plan.risk_per_share)}/sh</small>
      {plan.volatility?.grade ? (
        <small>{volatilityLabel(plan.volatility)}</small>
      ) : null}
    </span>
  );
}

function BuyCell({ buyState, disabled, onBuy, symbol, tradeAction }) {
  if (!tradeAction) {
    return <td className="row-action-cell buy-action-cell" aria-label="Watch alert"></td>;
  }
  if (tradeAction === "Short") {
    return (
      <td className="row-action-cell buy-action-cell">
        <button type="button" className="buy-one short-signal" disabled title={`Short signal for ${symbol}; short order is not wired yet.`}>
          Short
        </button>
      </td>
    );
  }
  const loading = buyState?.status === "loading";
  const title = `Auto buy calculated size for ${symbol}`;
  return (
    <td className="row-action-cell buy-action-cell">
      <button
        type="button"
        className={`buy-one ${buyState?.status === "ok" ? "success" : ""} ${buyState?.status === "error" ? "error" : ""}`}
        disabled={disabled || loading}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onBuy?.();
        }}
        title={title}
        aria-label={title}
      >
        {loading ? "Buying" : "Buy"}
      </button>
    </td>
  );
}

function NewTag({ onDismiss, symbol }) {
  function dismiss(event) {
    event.preventDefault();
    event.stopPropagation();
    onDismiss?.();
  }

  return (
    <button
      type="button"
      className="new-mtf-tag"
      onClick={dismiss}
      onPointerDown={dismiss}
      aria-label={`Clear new alert for ${symbol}`}
    >
      NEW
    </button>
  );
}

function PriceRow({ compact, quote, onRemoveSymbol }) {
  const tenMinuteStatus = cloudStatus(quote.ema_10m, ["5", "12"], ["34", "50"]);
  if (compact) {
    return (
      <BaseRow quote={quote} trend={tenMinuteStatus} showPrice={false}>
        <td data-label="Structure"><span className={`structure-pill ${structureClass(quote.structure_10m?.status)}`}>{structureLabel(quote.structure_10m?.status)}</span></td>
        <td data-label="Bias"><DirectionPill value={directionalBiasForQuote(quote)} /></td>
      </BaseRow>
    );
  }
  return (
    <BaseRow quote={quote} trend={tenMinuteStatus} action={onRemoveSymbol ? <RemoveCell onRemove={() => onRemoveSymbol(quote.symbol)} symbol={quote.symbol} /> : null}>
      <td data-label="Trend"><CloudTag status={tenMinuteStatus} /></td>
      <td data-label="BOS"><span className={`structure-pill ${structureClass(quote.structure_10m?.status)}`}>{structureLabel(quote.structure_10m?.status)}</span></td>
      <td data-label="Bias"><DirectionPill value={directionalBiasForQuote(quote)} /></td>
    </BaseRow>
  );
}

function BaseRow({ quote, children, trend = "", action = null, className = "", dataMtfSymbol, id, showCompanyName = true, showPrice = true, onClick }) {
  const rowClass = [trend ? `trend-${String(trend).toLowerCase()}` : "", className].filter(Boolean).join(" ");
  return (
    <tr className={`stock-row ${rowClass}`} data-mtf-symbol={dataMtfSymbol} id={id} onClick={onClick}>
      <td data-label="Symbol">
        <strong>{quote.symbol}</strong>
        {showCompanyName ? <small>{symbolDisplayName(quote.symbol)}</small> : null}
      </td>
      {children}
      {showPrice ? <td className="price-cell" data-label="Last">{formatPrice(quote.price)}</td> : null}
      {action}
    </tr>
  );
}

function symbolDisplayName(symbol) {
  const names = {
    AAOI: "Applied Opt.",
    APP: "AppLovin",
    ASTS: "AST Space...",
    BE: "Bloom Energy",
    COHR: "Coherent",
    CRDO: "Credo Tech...",
    CRWV: "CoreWeave",
    GLW: "Corning",
    IREN: "Iris Energy",
    MRVL: "Marvell Tech",
    MU: "Micron",
    NBIS: "Nebius Group",
    RKLB: "Rocket Lab",
    SNDK: "Sandisk",
  };
  return names[String(symbol || "").toUpperCase()] || "";
}

function RemoveCell({ onRemove, symbol }) {
  return (
    <td className="row-action-cell">
      <button type="button" className="row-delete-button" onClick={onRemove} aria-label={`Remove ${symbol}`}>
        x
      </button>
    </td>
  );
}

function mtfTriggerTime(matches) {
  const match = latestMtfMatch(matches);
  if (!match) return "-";
  const parsed = new Date(match.candle_time);
  if (Number.isNaN(parsed.getTime())) return String(match.candle_time);
  const date = parsed.toLocaleDateString([], { month: "short", day: "numeric" });
  const time = parsed.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return `${date} ${time}`;
}

function latestMtfMatch(matches) {
  let latestMatch = null;
  let latestTime = -Infinity;
  for (const match of matches || []) {
    const parsed = Date.parse(match.candle_time || "");
    if (!Number.isFinite(parsed) || parsed < latestTime) continue;
    latestMatch = match;
    latestTime = parsed;
  }
  return latestMatch;
}

function aPlusPlusRiskPlan(matches) {
  return (matches || []).find((match) => match.trade_action === "Long" && match.risk_plan)?.risk_plan || null;
}

function tradeActionForMatches(matches) {
  const actions = new Set((matches || []).map((match) => match.trade_action).filter(Boolean));
  if (actions.has("Long") && !actions.has("Short")) return "Long";
  if (actions.has("Short") && !actions.has("Long")) return "Short";
  return "";
}

function volatilityLabel(volatility) {
  const grade = String(volatility.grade || "unknown");
  const range = volatility.average_range == null ? "" : ` ${formatPrice(volatility.average_range)} avg`;
  return `${grade}${range}`;
}
