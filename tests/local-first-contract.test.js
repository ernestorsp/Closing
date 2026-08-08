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
const scripts = fs.readFileSync(
  path.join(__dirname, "..", "apps-script", "Scripts.html"),
  "utf8",
);
const legacyBackend = fs.readFileSync(
  path.join(__dirname, "..", "apps-script", "Code.gs"),
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

test("inspected vans are searchable while Closing and Rescue edit in place", () => {
  assert.doesNotMatch(index, /data-page="edit"/);
  assert.match(index, /data-page="inspected">Inspected Vans/);
  assert.match(index, /id="inspectedVanSearch"/);
  assert.match(index, /id="inspectedVanList"/);
  assert.match(index, /id="inspectionEditForm"/);
  assert.match(index, /id="editPhotoGrid"/);
  assert.match(index, /id="editDamagePanel"/);
  assert.match(index, /captureInspectionEditDamage/);
  assert.doesNotMatch(index, /editModuleGrid|EDIT CLOSING|EDIT RESCUE/);
  assert.match(frontend, /function renderInspectedVans\(\)/);
  assert.match(frontend, /inspection\.VanNumber/);
  assert.match(frontend, /\.includes\(query\)/);
  assert.match(frontend, /handleRescueFinalButton/);
  assert.match(frontend, /renderClosingSaveState/);
  assert.match(frontend, /Send the Closing Notes anyway/);
  assert.doesNotMatch(frontend, /button\.disabled\s*=.*!ready/);
  assert.match(frontend, /captureInspectionEditPhoto/);
  assert.match(frontend, /enqueueOperation\(\s*"SAVE_INSPECTION_PHOTO"/);
  assert.match(frontend, /enqueueOperation\(\s*"SAVE_DAMAGE"/);
  assert.match(backend, /mediaLoaded:\s*true/);
  assert.match(backend, /NewDamageFound:\s*newDamageFound/);
  assert.match(backend, /lfCanEditInspection_\(user_\(session\.email\), inspection\)/);
});

test("background synchronization stays invisible to the customer", () => {
  assert.doesNotMatch(index, /id="syncStatus"/);
  assert.doesNotMatch(index, /id="editSyncIssues"/);
  assert.doesNotMatch(frontend, /Pending sync/);
  assert.doesNotMatch(frontend, /changes that require review/);
  assert.doesNotMatch(frontend, /These changes need review/);
  assert.doesNotMatch(frontend, /Remote synchronization is pending/);
  assert.match(frontend, /recoverOwnClosingConflict/);
  assert.match(frontend, /operation\.type === "EDIT_INSPECTION"/);
  assert.match(frontend, /CORE\.operationTimeout\(operation\.type\)/);
  assert.match(frontend, /info\.busy \? 15000/);
  assert.match(frontend, /expectedVersion/);
  assert.match(
    backend,
    /norm_\(existing\.SavedByEmail\) === norm_\(session\.email\)/,
  );
  assert.match(backend, /const neverEdited = !norm_\(inspection\.EditedByEmail\)/);
  assert.match(backend, /expectedVersion > 0 \? !versionIsCurrent/);
  assert.match(frontend, /if \(manual\) setSyncState\(true\)/);
  assert.match(frontend, /if \(manual\) setSyncState\(false\)/);
});

test("DJX4 omits receipt drivers and empty DVIC is N/A in email", () => {
  assert.match(index, /id="driversWithReceiptsWrap"/);
  assert.match(scripts, /receiptsWrap\.hidden=isDjx4/);
  assert.match(scripts, /x\.station!==\'DJX4\'&&!x\.driversWithReceipts/);
  assert.match(backend, /station === "DJX4"\s*\? ""/);
  assert.match(
    legacyBackend,
    /DriversWithReceipts:station===\'DJX4\'\?\'\':intRange_/,
  );
  assert.match(
    legacyBackend,
    /receiptsDetail=station===\'DJX4\'\?\'\':detail\(\'Drivers with Receipts\'/,
  );
  assert.match(
    legacyBackend,
    /dvicValue=String\(data\.DVICDrivers\|\|\'\'\)\.trim\(\)\|\|\'N\/A\'/,
  );
});
