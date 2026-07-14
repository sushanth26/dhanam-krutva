import assert from "node:assert/strict";
import test from "node:test";

import { isMarketRefreshWindow, marketDateKey, shouldUseManualRefresh } from "./market.js";

test("manual refresh is used overnight before 9 AM Eastern", () => {
  assert.equal(shouldUseManualRefresh(new Date("2026-07-14T12:59:00Z")), true);
});

test("manual refresh is not used during regular market hours", () => {
  assert.equal(shouldUseManualRefresh(new Date("2026-07-14T13:00:00Z")), false);
  assert.equal(shouldUseManualRefresh(new Date("2026-07-14T19:59:00Z")), false);
});

test("manual refresh returns after the 4 PM Eastern close", () => {
  assert.equal(shouldUseManualRefresh(new Date("2026-07-14T20:00:00Z")), true);
});

test("market refresh window follows Eastern time", () => {
  assert.equal(isMarketRefreshWindow(new Date("2026-07-14T06:59:00Z")), false);
  assert.equal(isMarketRefreshWindow(new Date("2026-07-14T07:00:00Z")), true);
  assert.equal(isMarketRefreshWindow(new Date("2026-07-14T22:59:00Z")), true);
  assert.equal(isMarketRefreshWindow(new Date("2026-07-14T23:00:00Z")), false);
});

test("market date key follows Eastern date", () => {
  assert.equal(marketDateKey(new Date("2026-07-14T03:30:00Z")), "2026-07-13");
  assert.equal(marketDateKey(new Date("2026-07-14T04:00:00Z")), "2026-07-14");
});
