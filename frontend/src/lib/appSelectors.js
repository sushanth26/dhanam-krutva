import { cloudStatus } from "./market";

export function trendBucketsForQuotes(quotes) {
  return quotes.reduce(
    (buckets, quote) => {
      const trend = cloudStatus(quote.ema_10m, ["5", "12"], ["34", "50"]);
      if (trend === "Bullish") buckets.bullish.push(quote);
      else if (trend === "Bearish") buckets.bearish.push(quote);
      else if (trend === "Chop") buckets.chop.push(quote);
      return buckets;
    },
    { bullish: [], bearish: [], chop: [] },
  );
}

export function unreadCount(items) {
  return items.filter((item) => !item.read).length;
}

export function autoTradeOpenOrderCount(orders) {
  return orders.counts?.open ?? orders.buckets?.open?.length ?? 0;
}
