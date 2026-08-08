const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

const source = fs
  .readFileSync(
    path.join(__dirname, "..", "apps-script", "SyncCore.html"),
    "utf8",
  )
  .replace(/^\s*<script>\s*/, "")
  .replace(/\s*<\/script>\s*$/, "");
const context = { globalThis: {} };
vm.createContext(context);
vm.runInContext(source, context);
const core = context.globalThis.ClosingSyncCore;

test("new operations are persistent-queue ready", () => {
  const operation = core.createOperation(
    "SAVE_CLOSING",
    { date: "2026-08-07" },
    {
      id: "operation_12345678",
      now: 1000,
      entityId: "2026-08-07_DJX3",
      station: "DJX3",
      day: "2026-08-07",
    },
  );
  assert.equal(operation.status, "pending");
  assert.equal(operation.attempts, 0);
  assert.equal(operation.nextAttemptAt, 1000);
  assert.equal(operation.entityId, "2026-08-07_DJX3");
  assert.equal(operation.station, "DJX3");
  assert.equal(operation.day, "2026-08-07");
});

test("retry delay grows progressively and is capped", () => {
  assert.equal(core.retryDelay(1, 0.5), 1500);
  assert.equal(core.retryDelay(2, 0.5), 3000);
  assert.equal(core.retryDelay(20, 0.5), 300000);
});

test("slow Drive operations get a longer client timeout", () => {
  assert.equal(core.operationTimeout("SAVE_CLOSING"), 75000);
  assert.equal(core.operationTimeout("SAVE_INSPECTION_PHOTO"), 120000);
  assert.equal(core.operationTimeout("SAVE_DAMAGE"), 120000);
  assert.equal(core.operationTimeout("SEND_NOTES"), 120000);
});

test("conflicts require explicit user review", () => {
  const conflict = core.errorInfo(
    new Error("CONFLICT: changed by another user"),
  );
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.requiresAction, true);
  const network = core.errorInfo(new Error("Synchronization timed out"));
  assert.equal(network.requiresAction, false);
  const busy = core.errorInfo(
    new Error("SYNC_BUSY: operation is already syncing"),
  );
  assert.equal(busy.busy, true);
  assert.equal(busy.requiresAction, false);
  const temporaryQuota = core.errorInfo(
    new Error("Service invoked too many times in a short time"),
  );
  assert.equal(temporaryQuota.requiresAction, false);
  const dailyEmailQuota = core.errorInfo(
    new Error("Not enough email quota remains to send Closing Notes today."),
  );
  assert.equal(dailyEmailQuota.requiresAction, true);
  const validation = core.errorInfo(new Error("Select an available spot."));
  assert.equal(validation.requiresAction, true);
});

test("notes list pending data without blocking", () => {
  const pending = core.pendingChecklist(
    {
      inspectionsReady: false,
      rescuesReady: true,
      pickupReady: false,
      returnedPackagesReady: true,
      routesTomorrowReady: true,
    },
    1,
  );
  assert.deepEqual(Array.from(pending), [
    "vans without a completed inspection",
    "Pick up not confirmed",
    "photos still being prepared or uploaded",
  ]);
});

test("rescue fingerprints are stable across row order and timestamps", () => {
  const first = core.stableFingerprint([
    { RescueID: "b", Stops: 2, UpdatedAt: "one" },
    { RescueID: "a", Stops: 1, UpdatedAt: "two" },
  ]);
  const second = core.stableFingerprint([
    { RescueID: "a", Stops: 1, UpdatedAt: "new" },
    { RescueID: "b", Stops: 2, UpdatedAt: "newer" },
  ]);
  assert.equal(first, second);
});
