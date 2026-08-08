const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const backend = fs.readFileSync(
  path.join(__dirname, "..", "apps-script", "ZZ_LocalFirst.gs"),
  "utf8",
);
const frontend = fs.readFileSync(
  path.join(__dirname, "..", "apps-script", "LocalFirst.html"),
  "utf8",
);
const index = fs.readFileSync(
  path.join(__dirname, "..", "apps-script", "Index.html"),
  "utf8",
);

test("every queued operation type is accepted by the idempotent backend", () => {
  const queued = [
    ...frontend.matchAll(/enqueueOperation\(\s*"([A-Z_]+)"/g),
  ].map((match) => match[1]);
  assert.ok(queued.length >= 7);
  queued.forEach((type) => assert.match(backend, new RegExp('"' + type + '"')));
  assert.match(backend, /SYNC_OPERATIONS/);
  assert.match(backend, /Status:\s*error\s*\?\s*"retry"\s*:\s*"synced"/);
  assert.match(backend, /operation\.station = requestedStation/);
  assert.match(backend, /operation\.day = validDateInput_/);
});

test("critical actions use the local outbox instead of direct remote saves", () => {
  ["SAVE_CLOSING", "SAVE_RESCUES", "FINISH_INSPECTION", "SEND_NOTES"].forEach(
    (type) =>
      assert.match(
        frontend,
        new RegExp('enqueueOperation\\(\\s*"' + type + '"'),
      ),
  );
  assert.match(frontend, /indexedDB\.open/);
  assert.match(frontend, /window\.addEventListener\("online"/);
  assert.match(frontend, /visibilitychange/);
});

test("Edit navigation and pending-note warning are present", () => {
  assert.match(index, /data-page="edit"/);
  assert.match(index, /id="inspectionEditForm"/);
  assert.match(frontend, /Send the Closing Notes anyway/);
  assert.doesNotMatch(frontend, /button\.disabled\s*=.*!ready/);
});
