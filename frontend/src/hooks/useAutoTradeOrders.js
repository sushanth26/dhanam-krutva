import { useEffect, useState } from "react";

import { emptyAutoTradeOrders } from "../components/AutoTradesPage";
import { getJson } from "../lib/api";
import { autoTradeOpenOrderCount } from "../lib/appSelectors";

export function useAutoTradeOrders({ accountId, activePage, setLoadingKey }) {
  const [orders, setOrders] = useState(() => emptyAutoTradeOrders());
  const [alert, setAlert] = useState("");
  const openOrderCount = autoTradeOpenOrderCount(orders);

  async function refresh({ showLoading = true } = {}) {
    setAlert("");
    if (!accountId) {
      setOrders(emptyAutoTradeOrders());
      setAlert("Select a Webull margin account to view trades.");
      return;
    }
    if (showLoading) setLoadingKey("trades", true);
    try {
      const payload = await getJson(`/api/account/${accountId}/auto-trades?page_size=50&days=1`);
      if (!payload.ok) {
        setAlert(payload.history?.error || payload.open_orders?.error || `Webull returned order data with errors.`);
      }
      setOrders(payload);
    } catch (error) {
      setOrders(emptyAutoTradeOrders());
      setAlert(error.message);
    } finally {
      if (showLoading) setLoadingKey("trades", false);
    }
  }

  useEffect(() => {
    if (activePage === "trades") refresh();
  }, [activePage, accountId]);

  return { alert, openOrderCount, orders, refresh };
}
