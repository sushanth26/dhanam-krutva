import { useCallback, useMemo, useState } from "react";

const DEFAULT_LOADING_STATE = {
  shell: false,
  watchlists: false,
  prices: false,
  notifications: false,
};

export function useLoadingState() {
  const [loading, setLoading] = useState(DEFAULT_LOADING_STATE);
  const pageLoading = useMemo(() => Object.values(loading).some(Boolean), [loading]);
  const setLoadingKey = useCallback((key, value) => {
    setLoading((current) => ({ ...current, [key]: value }));
  }, []);

  return { loading, pageLoading, setLoadingKey };
}
