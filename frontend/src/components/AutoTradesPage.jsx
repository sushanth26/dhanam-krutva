import { useState } from "react";

import { formatDateTime } from "../lib/dates";
import { formatPrice } from "../lib/market";
import { SummaryTile } from "./SummaryTile";

export function emptyAutoTradeOrders() {
  return {
    ok: true,
    orders: [],
    buckets: { buy: [], sell: [], open: [], filled: [] },
    counts: { buy: 0, sell: 0, open: 0, filled: 0 },
  };
}

export function AutoTradesPage({ accountId, alert, loading, orders, onRefresh }) {
  const [tableView, setTableView] = useState("all");
  const buckets = orders?.buckets || emptyAutoTradeOrders().buckets;
  const counts = orders?.counts || emptyAutoTradeOrders().counts;
  const allOrders = orders?.orders || [];
  const tableViews = [
    { id: "all", label: "All", count: allOrders.length },
    { id: "buy", label: "Buy", count: counts.buy || 0 },
    { id: "sell", label: "Sell", count: counts.sell || 0 },
    { id: "open", label: "Open", count: counts.open || 0 },
    { id: "filled", label: "Filled", count: counts.filled || 0 },
  ];
  const visibleOrders = tableView === "all" ? allOrders : (buckets[tableView] || []);
  const activeTable = tableViews.find((item) => item.id === tableView) || tableViews[0];
  const tradeDate = orders?.trade_date;
  const historyTradeDate = orders?.history_trade_date;
  const dateText = accountId
    ? historyTradeDate && tradeDate && historyTradeDate !== tradeDate
      ? `Latest Webull history session ${historyTradeDate}, plus today's open orders for ${accountId}`
      : `Today's Webull orders for ${accountId}`
    : "Select a margin account to view broker orders.";
  return (
    <section className="auto-trades-page">
      <div className="auto-trades-header">
        <div>
          <h2>Auto Trades</h2>
          <p className="muted">{dateText}</p>
        </div>
        <button type="button" className="secondary-button" onClick={() => onRefresh()} disabled={loading || !accountId}>
          {loading ? "Refreshing" : "Refresh"}
        </button>
      </div>
      {alert ? <div className="alert">{alert}</div> : null}
      <div className="auto-trade-summary-grid" aria-label="Auto trade order counts">
        <SummaryTile label="Buy Orders" value={counts.buy || 0} />
        <SummaryTile label="Sell Orders" value={counts.sell || 0} />
        <SummaryTile label="Open Orders" value={counts.open || 0} />
        <SummaryTile label="Filled Orders" value={counts.filled || 0} />
      </div>
      <div className="table-view-tabs" role="tablist" aria-label="Trade table view">
        {tableViews.map((item) => (
          <button
            key={item.id}
            type="button"
            className={tableView === item.id ? "active" : ""}
            onClick={() => setTableView(item.id)}
            role="tab"
            aria-selected={tableView === item.id}
          >
            {item.label} <span>{item.count}</span>
          </button>
        ))}
      </div>
      <OrderBucket title={activeTable.label} items={visibleOrders} />
    </section>
  );
}

function OrderBucket({ title, items }) {
  return (
    <section className="auto-trade-bucket">
      <div className="auto-trade-bucket-heading">
        <h3>{title}</h3>
        <span>{items.length}</span>
      </div>
      <div className="auto-trade-table-wrap">
        <table className="auto-trade-table">
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Side</th>
              <th>Status</th>
              <th>Qty</th>
              <th>Order</th>
              <th>Time</th>
            </tr>
          </thead>
          <tbody>
            {items.length ? items.map((item, index) => (
              <tr key={orderRowKey(item, index)}>
                <td data-label="Symbol"><strong>{item.symbol || "-"}</strong></td>
                <td data-label="Side"><span className={`order-side-pill ${orderSideClass(item.side)}`}>{item.side || "-"}</span></td>
                <td data-label="Status"><span className={`order-status-pill ${orderStatusClass(item.status)}`}>{item.status || "-"}</span></td>
                <td data-label="Qty">{orderQuantityText(item)}</td>
                <td data-label="Order">
                  <div className="auto-trade-order-detail">
                    <strong>{item.order_type || "-"}</strong>
                    <span>{orderPriceText(item)}</span>
                    <small>{item.client_order_id || item.order_id || "-"}</small>
                  </div>
                </td>
                <td data-label="Time">{orderTimeText(item)}</td>
              </tr>
            )) : (
              <tr>
                <td colSpan="6" className="empty-table-cell">No {title.toLowerCase()} orders found</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function orderRowKey(item, index) {
  return item.client_order_id || item.order_id || `${item.symbol || "order"}-${item.side || ""}-${item.status || ""}-${index}`;
}

function orderSideClass(side) {
  const normalized = String(side || "").toLowerCase();
  if (normalized === "buy") return "buy";
  if (normalized === "sell") return "sell";
  return "unknown";
}

function orderStatusClass(status) {
  const normalized = String(status || "").toLowerCase();
  if (normalized === "filled") return "filled";
  if (normalized.includes("submit") || normalized.includes("open") || normalized.includes("partial") || normalized.includes("working")) return "open";
  if (normalized.includes("cancel") || normalized.includes("fail") || normalized.includes("reject")) return "error";
  return "unknown";
}

function orderQuantityText(item) {
  const quantity = item.quantity ?? "-";
  const filled = item.filled_quantity;
  return filled != null ? `${filled}/${quantity}` : String(quantity);
}

function orderPriceText(item) {
  const parts = [];
  if (item.avg_price != null) parts.push(`Avg ${formatPrice(item.avg_price)}`);
  if (item.limit_price != null) parts.push(`Limit ${formatPrice(item.limit_price)}`);
  if (item.stop_price != null) parts.push(`Stop ${formatPrice(item.stop_price)}`);
  return parts.length ? parts.join(" · ") : "-";
}

function orderTimeText(item) {
  const value = item.updated_at || item.created_at;
  return value ? formatDateTime(value) : "-";
}
