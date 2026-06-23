import assert from "node:assert/strict";
import test from "node:test";

import { getNextSyncDelayMs } from "../src/scheduler";

test("runs an overdue sync immediately", () => {
  assert.equal(getNextSyncDelayMs(0, 0, 1800, 10_000), 20);
});

test("waits a full interval after a failed attempt", () => {
  assert.equal(getNextSyncDelayMs(0, 10_000, 1800, 10_000), 1_800_000);
});

test("uses a newer successful sync when scheduling", () => {
  assert.equal(getNextSyncDelayMs(12_000, 10_000, 1800, 12_300), 1_500_000);
});
