import { Fragment, useEffect, useMemo, useState } from "react";

import { getJson } from "../lib/api";

const currencyFormatter = new Intl.NumberFormat("en-US", {
  currency: "USD",
  maximumFractionDigits: 0,
  style: "currency",
});

const compactCurrencyFormatter = new Intl.NumberFormat("en-US", {
  currency: "USD",
  maximumFractionDigits: 1,
  notation: "compact",
  style: "currency",
});

const numberFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

function marketCapInRange(value, range) {
  if (range === "mega") return value >= 200000000000;
  if (range === "large") return value >= 10000000000 && value < 200000000000;
  if (range === "mid") return value >= 2000000000 && value < 10000000000;
  if (range === "small") return value > 0 && value < 2000000000;
  if (range === "unknown") return !value;
  return true;
}

function formatMarketCap(value) {
  return value ? compactCurrencyFormatter.format(value) : "N/A";
}

function importanceLabel(record) {
  if (record.isExecutiveBuy) return "Executive buy";
  if (record.isBoardBuy) return "Board buy";
  return "Important buy";
}

function compareValues(left, right) {
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left || "").localeCompare(String(right || ""), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function groupRecords(records, sortKey, sortDirection) {
  const groups = [...records.reduce((map, record) => {
    const rows = map.get(record.ticker) || [];
    rows.push(record);
    map.set(record.ticker, rows);
    return map;
  }, new Map()).values()].map((rows) => {
    const latestDate = rows.reduce((latest, row) => row.filingDate > latest ? row.filingDate : latest, "");
    return {
      rows,
      summary: {
        boardBuys: rows.filter((row) => row.isBoardBuy).length,
        companyName: rows[0]?.companyName || "",
        executiveBuys: rows.filter((row) => row.isExecutiveBuy).length,
        latestDate,
        marketCap: rows[0]?.marketCap || 0,
        ticker: rows[0]?.ticker || "",
        totalShares: rows.reduce((sum, row) => sum + row.shares, 0),
        totalValue: rows.reduce((sum, row) => sum + row.value, 0),
        trades: rows.length,
      },
    };
  });

  const direction = sortDirection === "asc" ? 1 : -1;
  groups.sort((left, right) => {
    const leftSummary = left.summary;
    const rightSummary = right.summary;
    let result = 0;
    if (sortKey === "ticker") result = compareValues(leftSummary.ticker, rightSummary.ticker);
    else if (sortKey === "marketCap") result = compareValues(leftSummary.marketCap, rightSummary.marketCap);
    else if (sortKey === "shares") result = compareValues(leftSummary.totalShares, rightSummary.totalShares);
    else if (sortKey === "value") result = compareValues(leftSummary.totalValue, rightSummary.totalValue);
    else result = compareValues(leftSummary.latestDate, rightSummary.latestDate);
    return result ? result * direction : leftSummary.ticker.localeCompare(rightSummary.ticker);
  });

  return groups;
}

export function InsiderBuyingPage({ onDataLoaded }) {
  const [records, setRecords] = useState([]);
  const [days, setDays] = useState(365);
  const [query, setQuery] = useState("");
  const [marketCapRange, setMarketCapRange] = useState("all");
  const [sortKey, setSortKey] = useState("date");
  const [sortDirection, setSortDirection] = useState("desc");
  const [status, setStatus] = useState({ loading: true, error: "", meta: null });

  async function loadData(nextDays = days) {
    setStatus((current) => ({ ...current, loading: true, error: "" }));
    try {
      const payload = await getJson(`/api/insiders/qqq?days=${nextDays}`);
      setRecords(Array.isArray(payload.records) ? payload.records : []);
      setSortKey("date");
      setSortDirection("desc");
      setStatus({ loading: false, error: "", meta: payload });
      onDataLoaded?.(payload);
    } catch (error) {
      setStatus({ loading: false, error: error.message || "Unable to load insider buys.", meta: null });
    }
  }

  useEffect(() => {
    loadData();
  }, []);

  const visibleRecords = useMemo(() => {
    const normalizedQuery = query.trim().toUpperCase();
    return records.filter((record) => {
      if (!marketCapInRange(record.marketCap || 0, marketCapRange)) return false;
      if (!normalizedQuery) return true;
      return [record.ticker, record.companyName, record.insider, record.role].some((value) =>
        String(value || "").toUpperCase().includes(normalizedQuery),
      );
    });
  }, [marketCapRange, query, records]);

  const groups = useMemo(
    () => groupRecords(visibleRecords, sortKey, sortDirection),
    [sortDirection, sortKey, visibleRecords],
  );
  const totalValue = visibleRecords.reduce((sum, record) => sum + record.value, 0);

  function updateSort(key) {
    if (sortKey === key) {
      setSortDirection((current) => current === "asc" ? "desc" : "asc");
      return;
    }
    setSortKey(key);
    setSortDirection(["ticker"].includes(key) ? "asc" : "desc");
  }

  function renderHeader(key, label) {
    const active = sortKey === key;
    return (
      <th key={key}>
        <button
          type="button"
          className={`insider-sort ${active ? "active" : ""}`}
          data-direction={active ? sortDirection : ""}
          onClick={() => updateSort(key)}
        >
          <span>{label}</span>
          <span className="insider-sort-caret" aria-hidden="true"></span>
        </button>
      </th>
    );
  }

  return (
    <section className="insider-page">
      <div className="insider-page-header">
        <div>
          <span className="insider-eyebrow">Nasdaq-100 monitor</span>
          <h2>QQQ Insider Buys</h2>
          <p>
            {status.meta
              ? `${status.meta.holdingsScanned} Nasdaq-100 names scanned from ${status.meta.source}.`
              : "Board and executive open-market buys from Nasdaq insider activity."}
          </p>
        </div>
        <button type="button" className="secondary-button" disabled={status.loading} onClick={() => loadData()}>
          {status.loading ? "Checking" : "Refresh"}
        </button>
      </div>

      <div className="insider-controls" aria-label="Insider buying filters">
        <label className="insider-search-field">
          <span>Search</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Ticker, company, insider" />
        </label>
        <label>
          <span>Lookback</span>
          <select
            value={days}
            onChange={(event) => {
              const nextDays = Number(event.target.value);
              setDays(nextDays);
              loadData(nextDays);
            }}
          >
            <option value="30">30 days</option>
            <option value="90">90 days</option>
            <option value="180">180 days</option>
            <option value="365">1 year</option>
          </select>
        </label>
        <label>
          <span>Market cap</span>
          <select value={marketCapRange} onChange={(event) => setMarketCapRange(event.target.value)}>
            <option value="all">Any market cap</option>
            <option value="mega">Mega cap $200B+</option>
            <option value="large">Large cap $10B-$200B</option>
            <option value="mid">Mid cap $2B-$10B</option>
            <option value="small">Small cap under $2B</option>
            <option value="unknown">Unknown</option>
          </select>
        </label>
      </div>

      {status.error ? <div className="alert app-alert error">{status.error}</div> : null}

      <div className="insider-metrics">
        <Summary label="Stocks" value={numberFormatter.format(groups.length)} />
        <Summary label="Important buys" value={numberFormatter.format(visibleRecords.length)} />
        <Summary label="Buy value" value={compactCurrencyFormatter.format(totalValue)} />
        <Summary label="As of" value={status.meta?.holdingsAsOf || "-"} />
      </div>

      <div className="insider-table-wrap">
        <table className="insider-table">
          <thead>
            <tr>
              {[
                ["ticker", "Ticker"],
                ["insider", "Insider"],
                ["role", "Role"],
                ["shares", "Shares"],
                ["marketCap", "Market cap"],
                ["value", "Value"],
                ["tag", "Tag"],
                ["date", "Filed"],
              ].map(([key, label]) => renderHeader(key, label))}
            </tr>
          </thead>
          <tbody>
            {status.loading ? (
              <tr><td colSpan="8" className="insider-empty">Loading QQQ insider activity...</td></tr>
            ) : groups.length ? groups.map(({ rows, summary }) => (
              <Fragment key={`${summary.ticker}-section`}>
                <tr className="insider-stock-row" key={`${summary.ticker}-group`}>
                  <td colSpan="8">
                    <div className="insider-stock-title">
                      <a href={`https://www.nasdaq.com/market-activity/stocks/${summary.ticker.toLowerCase()}/insider-activity`} target="_blank" rel="noreferrer">{summary.ticker}</a>
                      <strong>{summary.companyName}</strong>
                    </div>
                    <div className="insider-stock-stats">
                      <span>{summary.trades} buys</span>
                      <span>{summary.executiveBuys} exec</span>
                      <span>{summary.boardBuys} board</span>
                      <span>{formatMarketCap(summary.marketCap)}</span>
                      <span>{currencyFormatter.format(summary.totalValue)}</span>
                      <span>Latest {summary.latestDate}</span>
                    </div>
                  </td>
                </tr>
	                {rows.map((record) => (
	                  <tr key={`${record.ticker}-${record.insider}-${record.filingDate}-${record.value}`}>
	                    <td data-label="Ticker">{record.ticker}</td>
	                    <td data-label="Insider"><strong>{record.insider}</strong><span>{record.ownership}</span></td>
	                    <td data-label="Role">{record.role}</td>
	                    <td data-label="Shares">{numberFormatter.format(record.shares)}</td>
	                    <td data-label="Market cap">{formatMarketCap(record.marketCap)}</td>
	                    <td data-label="Value">{record.value ? currencyFormatter.format(record.value) : "Unpriced"}</td>
	                    <td data-label="Tag"><span className={`insider-tag ${record.isBoardBuy ? "board" : "exec"}`}>{importanceLabel(record)}</span></td>
	                    <td data-label="Filed">{record.filingDate}</td>
	                  </tr>
	                ))}
              </Fragment>
            )) : (
              <tr><td colSpan="8" className="insider-empty">No matching insider buys found.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Summary({ label, value }) {
  return (
    <div className="insider-summary">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
