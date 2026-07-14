import assert from "node:assert/strict";
import test from "node:test";

import { defaultAlertStrategies, mergeAlertStrategySettings } from "./alertStrategies.js";

test("alert strategy sync restores local overrides when server resets to defaults", () => {
  const local = { ...defaultAlertStrategies(), scannerEntry: false, mtfCloudTouch: false };
  const remote = defaultAlertStrategies();

  assert.deepEqual(mergeAlertStrategySettings(local, remote), {
    strategies: local,
    shouldSaveRemote: true,
  });
});

test("alert strategy sync uses remote overrides when server has saved choices", () => {
  const local = { ...defaultAlertStrategies(), scannerEntry: false };
  const remote = { ...defaultAlertStrategies(), curls: false };

  assert.deepEqual(mergeAlertStrategySettings(local, remote), {
    strategies: remote,
    shouldSaveRemote: false,
  });
});
