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

const priceFormatter = new Intl.NumberFormat("en-US", {
  currency: "USD",
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
  style: "currency",
});

const numberFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const dateFormatter = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});
const filedAtFormatter = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  month: "short",
  timeZoneName: "short",
  year: "numeric",
});
const RECENT_REFRESH_INTERVAL_MS = 2 * 60 * 1000;

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

function formatTradePrice(value) {
  const price = Number(value);
  return Number.isFinite(price) && price > 0 ? priceFormatter.format(price) : "N/A";
}

function formatDate(value) {
  if (!value) return "N/A";
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? String(value) : dateFormatter.format(parsed);
}

function formatFiledAt(record) {
  if (record.filedAt) {
    const parsed = new Date(record.filedAt);
    if (!Number.isNaN(parsed.getTime())) return filedAtFormatter.format(parsed);
  }
  return formatDate(record.filingDate);
}

function recordKey(record) {
  return record.recordId || [
    record.accessionNumber,
    record.ticker,
    record.transactionDate || record.filingDate,
    record.insider,
    record.shares,
    Number(record.price || 0).toFixed(4),
  ].join(":");
}

function mergeRecords(currentRecords, recentRecords) {
  const currentPrices = Object.fromEntries(
    currentRecords
      .filter((record) => Number(record.currentPrice) > 0)
      .map((record) => [String(record.ticker || "").toUpperCase(), record.currentPrice]),
  );
  const byKey = new Map();
  [...recentRecords, ...currentRecords].forEach((record) => {
    const ticker = String(record.ticker || "").toUpperCase();
    const key = recordKey(record);
    if (!byKey.has(key)) {
      byKey.set(key, {
        ...record,
        currentPrice: record.currentPrice || currentPrices[ticker] || null,
      });
    }
  });
  return [...byKey.values()];
}

async function loadCurrentPrices(records) {
  const symbols = [...new Set(records.map((record) => String(record.ticker || "").toUpperCase()).filter(Boolean))];
  const currentPrices = {};
  for (let index = 0; index < symbols.length; index += 25) {
    const params = new URLSearchParams({
      force: "true",
      symbols: symbols.slice(index, index + 25).join(","),
    });
    const pricePayload = await getJson(`/api/webull/live-prices?${params.toString()}`);
    if (pricePayload.ok === false) {
      throw new Error(pricePayload.errors?.[0]?.error || "Live prices are unavailable.");
    }
    (pricePayload.quotes || []).forEach((quote) => {
      const symbol = String(quote.symbol || "").toUpperCase();
      const price = Number(quote.price);
      if (symbol && Number.isFinite(price) && price > 0) currentPrices[symbol] = price;
    });
  }
  return currentPrices;
}

function priceComparison(record) {
  const boughtAt = Number(record.price);
  const currentPrice = Number(record.currentPrice);
  if (!Number.isFinite(boughtAt) || boughtAt <= 0 || !Number.isFinite(currentPrice) || currentPrice <= 0) {
    return { changePct: null, label: "Unavailable", tone: "unknown" };
  }
  const changePct = ((currentPrice - boughtAt) / boughtAt) * 100;
  return {
    changePct,
    label: currentPrice >= boughtAt ? "Green" : "Red",
    tone: currentPrice >= boughtAt ? "green" : "red",
  };
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
    const latestDate = rows.reduce((latest, row) => {
      const rowDate = row.transactionDate || row.filingDate || "";
      return rowDate > latest ? rowDate : latest;
    }, "");
    return {
      rows,
      summary: {
        boardBuys: rows.filter((row) => row.isBoardBuy).length,
        companyName: rows[0]?.companyName || "",
        executiveBuys: rows.filter((row) => row.isExecutiveBuy).length,
        latestDate,
        marketCap: rows[0]?.marketCap || 0,
        averageBuyPrice: rows.reduce((sum, row) => sum + row.value, 0) / Math.max(rows.reduce((sum, row) => sum + row.shares, 0), 1),
        currentPrice: rows.find((row) => Number(row.currentPrice) > 0)?.currentPrice || 0,
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
    else if (sortKey === "price") result = compareValues(leftSummary.averageBuyPrice, rightSummary.averageBuyPrice);
    else if (sortKey === "currentPrice") result = compareValues(leftSummary.currentPrice, rightSummary.currentPrice);
    else if (sortKey === "performance") {
      const leftChange = leftSummary.averageBuyPrice > 0 && leftSummary.currentPrice > 0
        ? ((leftSummary.currentPrice - leftSummary.averageBuyPrice) / leftSummary.averageBuyPrice) * 100
        : Number.NEGATIVE_INFINITY;
      const rightChange = rightSummary.averageBuyPrice > 0 && rightSummary.currentPrice > 0
        ? ((rightSummary.currentPrice - rightSummary.averageBuyPrice) / rightSummary.averageBuyPrice) * 100
        : Number.NEGATIVE_INFINITY;
      result = compareValues(leftChange, rightChange);
    }
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
  const [status, setStatus] = useState({
    loading: true,
    pricesLoading: false,
    filingsLoading: false,
    error: "",
    filingError: "",
    priceError: "",
    meta: null,
  });

  async function loadData(nextDays = days) {
    setStatus((current) => ({
      ...current,
      loading: true,
      pricesLoading: false,
      filingsLoading: false,
      error: "",
      filingError: "",
      priceError: "",
    }));
    try {
      const payload = await getJson(`/api/insiders/qqq?days=${nextDays}`);
      const nextRecords = Array.isArray(payload.records) ? payload.records : [];
      setRecords(nextRecords);
      setSortKey("date");
      setSortDirection("desc");
      setStatus({
        loading: false,
        pricesLoading: nextRecords.length > 0,
        filingsLoading: nextRecords.some((record) => !record.filingDate),
        error: "",
        filingError: "",
        priceError: "",
        meta: payload,
      });
      onDataLoaded?.(payload);

      if (!nextRecords.length) return;
      loadFilingDetails(nextDays);

      try {
        const currentPrices = await loadCurrentPrices(nextRecords);
        setRecords((current) => current.map((record) => ({
          ...record,
          currentPrice: currentPrices[String(record.ticker || "").toUpperCase()] || null,
        })));
        setStatus((current) => ({
          ...current,
          pricesLoading: false,
          priceError: "",
        }));
      } catch (error) {
        setStatus((current) => ({
          ...current,
          pricesLoading: false,
          priceError: error.message || "Current prices are unavailable.",
        }));
      }
    } catch (error) {
      setStatus({
        loading: false,
        pricesLoading: false,
        filingsLoading: false,
        error: error.message || "Unable to load insider buys.",
        filingError: "",
        priceError: "",
        meta: null,
      });
    }
  }

  async function loadFilingDetails(nextDays) {
    try {
      const payload = await getJson(`/api/insiders/qqq/filing-details?days=${nextDays}`);
      const detailedRecords = Array.isArray(payload.records) ? payload.records : [];
      setRecords((current) => {
        const prices = Object.fromEntries(
          current
            .filter((record) => Number(record.currentPrice) > 0)
            .map((record) => [String(record.ticker || "").toUpperCase(), record.currentPrice]),
        );
        return detailedRecords.map((record) => ({
          ...record,
          currentPrice: prices[String(record.ticker || "").toUpperCase()] || null,
        }));
      });
      setStatus((current) => ({
        ...current,
        filingsLoading: false,
        filingError: "",
        meta: { ...current.meta, ...payload },
      }));
    } catch (error) {
      setStatus((current) => ({
        ...current,
        filingsLoading: false,
        filingError: error.message || "Some SEC filing dates could not be matched.",
      }));
    }
  }

  async function loadRecentData() {
    try {
      const payload = await getJson("/api/insiders/qqq/recent");
      const recentRecords = Array.isArray(payload.records) ? payload.records : [];
      if (!recentRecords.length) {
        setStatus((current) => ({
          ...current,
          meta: { ...current.meta, ...payload },
        }));
        onDataLoaded?.(payload);
        return;
      }
      let currentPrices = {};
      try {
        currentPrices = await loadCurrentPrices(recentRecords);
      } catch {
        // Existing prices remain visible until the next full refresh.
      }
      const pricedRecords = recentRecords.map((record) => ({
        ...record,
        currentPrice: currentPrices[String(record.ticker || "").toUpperCase()] || null,
      }));
      setRecords((current) => mergeRecords(current, pricedRecords));
      setStatus((current) => ({
        ...current,
        meta: { ...current.meta, ...payload },
      }));
      onDataLoaded?.(payload);
    } catch {
      // Keep the existing table and retry on the next SEC polling cycle.
    }
  }

  useEffect(() => {
    loadData();
    loadRecentData();
    const timer = window.setInterval(loadRecentData, RECENT_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
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
          <span className="insider-eyebrow">SEC Form 4 monitor</span>
          <h2>QQQ Insider Buys</h2>
          <p>
            {status.meta
              ? `${status.meta.holdingsScanned} Nasdaq-100 names scanned from ${status.meta.source}.`
              : "Officer and director open-market purchases from SEC Form 4 filings, with Nasdaq history."}
          </p>
        </div>
        <button type="button" className="secondary-button" disabled={status.loading || status.pricesLoading || status.filingsLoading} onClick={() => loadData()}>
          {status.loading ? "Checking" : status.pricesLoading ? "Pricing" : status.filingsLoading ? "Matching filings" : "Refresh"}
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
      {status.meta?.secError ? <div className="alert app-alert warning">SEC live filings are temporarily unavailable. Nasdaq history is still shown.</div> : null}
      {status.filingError ? <div className="alert app-alert warning">{status.filingError}</div> : null}
      {status.priceError ? <div className="alert app-alert warning">{status.priceError}</div> : null}

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
                ["shares", "Shares"],
                ["marketCap", "Market cap"],
                ["price", "Bought at"],
                ["currentPrice", "Current"],
                ["performance", "Result"],
                ["tag", "Tag"],
                ["transactionDate", "Trade date"],
                ["date", "Filed"],
              ].map(([key, label]) => renderHeader(key, label))}
            </tr>
          </thead>
          <tbody>
            {status.loading ? (
              <tr><td colSpan="10" className="insider-empty">Loading QQQ insider activity...</td></tr>
            ) : groups.length ? groups.map(({ rows, summary }) => (
              <Fragment key={`${summary.ticker}-section`}>
                <tr className="insider-stock-row" key={`${summary.ticker}-group`}>
                  <td colSpan="10">
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
                      <span>Latest trade {formatDate(summary.latestDate)}</span>
                    </div>
                  </td>
                </tr>
                {rows.map((record) => {
                  const comparison = priceComparison(record);
                  return (
                    <tr key={recordKey(record)}>
                      <td data-label="Ticker">{record.ticker}</td>
                      <td data-label="Insider"><strong>{record.insider}</strong><span>{record.ownership}</span></td>
                      <td data-label="Shares">{numberFormatter.format(record.shares)}</td>
                      <td data-label="Market cap">{formatMarketCap(record.marketCap)}</td>
                      <td data-label="Bought at" className="insider-price-cell">{formatTradePrice(record.price)}</td>
                      <td data-label="Current" className="insider-price-cell">
                        {status.pricesLoading && !record.currentPrice ? "Loading" : formatTradePrice(record.currentPrice)}
                      </td>
                      <td data-label="Result">
                        <span className={`insider-performance ${comparison.tone}`}>
                          {comparison.label}
                          {comparison.changePct === null ? null : (
                            <small>{comparison.changePct >= 0 ? "+" : ""}{comparison.changePct.toFixed(1)}%</small>
                          )}
                        </span>
                      </td>
                      <td data-label="Tag"><span className={`insider-tag ${record.isBoardBuy ? "board" : "exec"}`}>{importanceLabel(record)}</span></td>
                      <td data-label="Trade date">{formatDate(record.transactionDate || record.filingDate)}</td>
                      <td data-label="Filed">
                        <a className="insider-source-link" href={record.sourceUrl} target="_blank" rel="noreferrer">
                          {status.filingsLoading && !record.filingDate ? "Matching..." : formatFiledAt(record)}
                        </a>
                        <span>{record.source}</span>
                      </td>
                    </tr>
                  );
                })}
              </Fragment>
            )) : (
              <tr><td colSpan="10" className="insider-empty">No matching insider buys found.</td></tr>
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
