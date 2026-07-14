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
    message: "BE Curl at 12.35 | AAOI Daily 50/55 at 55.00",
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

test("mtf touch notification describes immediate reaction", () => {
  const notification = longAlertNotification([
    {
      quote: { symbol: "MRVL" },
      match: {
        type: "mtf_cloud_price_touch",
        label: "Hourly 34/50",
        cloud_label: "Hourly 34/50",
        direction: "reject_down",
        entry_price: 107,
      },
    },
  ]);

  assert.deepEqual(notification, {
    title: "MRVL: Hourly 34/50 Touch alert",
    message: "Price rejected down from Hourly 34/50 at 107.00",
  });
});

test("scanner entry notification is explicit", () => {
  const notification = longAlertNotification([
    {
      quote: { symbol: "BE" },
      match: {
        type: "scanner_entry",
        display_label: "Entry: in 5/12",
        entry_price: 12.5,
        scanner_read: { detail: "curl with price inside the 10m 5/12 EMA cloud." },
      },
    },
  ]);

  assert.deepEqual(notification, {
    title: "BE: Entry alert",
    message: "Entry at 12.50: curl with price inside the 10m 5/12 EMA cloud.",
  });
});

test("playable trade notification includes execution levels", () => {
  const notification = longAlertNotification([
    {
      quote: { symbol: "AAOI" },
      match: {
        type: "playable_trade",
        trade_action: "Long",
        entry_price: 119.42,
        stop_price: 115.5,
        target_price: 127.51,
        reward_risk: 2.77,
      },
    },
  ]);

  assert.deepEqual(notification, {
    title: "AAOI: Playable alert",
    message: "Playable Long at 119.42, SL 115.50, TP 127.51, 2.77R",
  });
});
