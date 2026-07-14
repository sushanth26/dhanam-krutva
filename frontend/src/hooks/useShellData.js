import { useState } from "react";

import { getJson } from "../lib/api";
import { flattenAccounts, preferredAccountId } from "../lib/market";

export function useShellData({ setLoadingKey }) {
  const [status, setStatus] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [selectedAccountId, setSelectedAccountId] = useState(null);
  const [alert, setAlert] = useState("");

  async function refreshShell({ includeAccounts = true } = {}) {
    setLoadingKey("shell", true);
    try {
      const nextStatus = await getJson("/api/status");
      setStatus(nextStatus);
      if (!nextStatus.configured) {
        setAlert("Add WEBULL_APP_KEY and WEBULL_APP_SECRET to .env, then restart the server.");
      } else {
        setAlert("");
      }

      if (!includeAccounts) return;

      const accountResponse = await getJson("/api/accounts");
      if (!accountResponse.ok) {
        setAlert(accountResponse.error || `Webull returned ${accountResponse.status_code}`);
      }
      const nextAccounts = flattenAccounts(accountResponse.data);
      setAccounts(nextAccounts);
      setSelectedAccountId((current) => preferredAccountId(nextAccounts, current));
    } catch (error) {
      setAlert(error.message);
    } finally {
      setLoadingKey("shell", false);
    }
  }

  function selectAccount(accountId) {
    setSelectedAccountId(preferredAccountId(accounts, accountId));
  }

  return {
    accounts,
    alert,
    refreshShell,
    selectAccount,
    selectedAccountId,
    status,
  };
}
