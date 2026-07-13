import assert from "node:assert/strict";
import test from "node:test";

import { longAlertNotification, longAlertSignature } from "./longAlertNotifications.js";

test("long alert notifications read symbols from quote rows", () => {
  const rows = [
    {
      quote: { symbol: "BE" },
      match: {
        type: "long_mtf_5_12_touch",
        label: "Curl",
        display_label: "Curl: Daily 50/55 -> above 10m 5/12",
        mtf_label: "Daily 50/55",
        entry_price: 12.345,
        candle_time: "2026-07-13T19:30:00Z",
      },
    },
    {
      quote: { symbol: "AAOI" },
      match: {
        type: "10m_cloud_bounce",
        label: "10m bounce Daily 50/55",
        display_label: "Daily 50/55 Touch",
        cloud_label: "Daily 50/55",
        entry_price: 55,
        candle_time: "2026-07-13T19:40:00Z",
      },
    },
  ];

  assert.equal(longAlertSignature(rows).includes("undefined"), false);
  assert.deepEqual(longAlertNotification(rows), {
    title: "2 Setup alerts",
    message: "BE Curl | AAOI Daily 50/55",
  });
});

test("single curl notification falls back without undefined text", () => {
  const notification = longAlertNotification([
    {
      quote: { symbol: "BE" },
      match: {
        type: "long_mtf_5_12_touch",
        label: "Curl",
        display_label: "Curl: Daily 50/55 -> above 10m 5/12",
        entry_price: 12,
      },
    },
  ]);

  assert.deepEqual(notification, {
    title: "BE: Curl alert",
    message: "Daily 50/55 -> above 10m 5/12 at 12.00",
  });
});
