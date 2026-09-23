import { google } from 'googleapis';
import { FieldValue } from 'firebase-admin/firestore';

const DEFAULT_SPREADSHEET_ID = '1ifcppKsFeJ3VUeOe8_RAJxJ_3Iq5FsJYJKVT8suNt2U';
const DEFAULT_SHEET_NAME = 'Sheet1';

function clean(value, max = 5000) {
  return String(value == null ? '' : value).trim().slice(0, max);
}
function upper(value, max = 5000) { return clean(value, max).toUpperCase(); }
function vin(value) { return upper(value, 160); }
function vanNumber(value) { return upper(value, 100).replace(/^EDV\s*/i, '').trim(); }
function status(value) {
  const v = clean(value, 50).toLowerCase();
  if (v === 'operational') return 'Operational';
  if (v === 'grounded') return 'Grounded';
  if (v === 'downed') return 'Downed';
  return '';
}
function noteFromVan(van) {
  return clean(van.CurrentNote || van.VanInfoReason || '', 5000);
}
function stateFromVan(van) {
  return { status: status(van.CurrentStatus || 'Operational') || 'Operational', note: noteFromVan(van) };
}
function same(a, b) {
  return String(a?.status || '') === String(b?.status || '') && String(a?.note || '') === String(b?.note || '');
}
function millis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (value._seconds != null) return Number(value._seconds) * 1000;
  const n = new Date(value).getTime();
  return Number.isFinite(n) ? n : 0;
}

export function createDjx4FleetSync({ db }) {
  const spreadsheetId = process.env.DJX4_FLEET_SPREADSHEET_ID || DEFAULT_SPREADSHEET_ID;
  const sheetName = process.env.DJX4_FLEET_SHEET_NAME || DEFAULT_SHEET_NAME;
  const metadataRef = db.collection('syncMetadata').doc('djx4Fleet');
  const auth = new google.auth.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  const sheets = google.sheets({ version: 'v4', auth });
  let running = false;

  async function run() {
    if (running) return { ok: true, skipped: true, reason: 'SYNC_ALREADY_RUNNING' };
    running = true;
    const observedAt = Date.now();
    try {
      const [sheetResponse, vansSnapshot, metadataSnapshot] = await Promise.all([
        sheets.spreadsheets.values.get({ spreadsheetId, range: `'${sheetName}'!A2:J` }),
        db.collection('vans').get(),
        metadataRef.get()
      ]);

      const previous = metadataSnapshot.exists ? metadataSnapshot.data() : {};
      const previousFleet = previous.fleet || {};
      const previousApp = previous.app || {};
      const previousSyncMillis = millis(previous.LastSyncAt);
      const initial = !metadataSnapshot.exists || !previous.initialized;

      const vans = vansSnapshot.docs.map(doc => ({ ...doc.data(), _documentId: doc.id, VanID: doc.data().VanID || doc.id }))
        .filter(v => v.Active !== false && v.active !== false);
      const byVin = new Map();
      const byNumber = new Map();
      for (const van of vans) {
        const id = vin(van.VanID || van._documentId);
        const number = vanNumber(van.VanNumber || '');
        if (id && !byVin.has(id)) byVin.set(id, van);
        if (number && !byNumber.has(number)) byNumber.set(number, van);
      }

      const rows = sheetResponse.data.values || [];
      const appUpdates = new Map();
      const sheetUpdates = [];
      const nextFleet = {};
      const nextApp = {};
      let fleetToApp = 0;
      let appToFleet = 0;
      let ignoredStatuses = 0;
      let matched = 0;

      rows.forEach((row, index) => {
        while (row.length < 10) row.push('');
        const rowNumber = index + 2;
        const rowVin = vin(row[2]);       // C VIN
        const rowNumberId = vanNumber(row[0]); // A Van Number
        const van = (rowVin && byVin.get(rowVin)) || (rowNumberId && byNumber.get(rowNumberId));
        if (!van) return;

        const id = vin(van.VanID || van._documentId);
        if (!id) return;
        matched++;

        const fleetStatus = status(row[7]); // H Operational Status
        const fleetNote = clean(row[9], 5000); // J Issues/comment
        const app = stateFromVan(van);

        // Retired/Retirement/unknown Fleet statuses are intentionally outside Closing's 3-state model.
        if (!fleetStatus) {
          ignoredStatuses++;
          nextFleet[id] = { status: clean(row[7], 50), note: fleetNote };
          nextApp[id] = app;
          return;
        }

        const fleet = { status: fleetStatus, note: fleetNote };
        const priorFleet = previousFleet[id] || {};
        const priorApp = previousApp[id] || {};
        const fleetChanged = !same(fleet, priorFleet);
        const appChanged = !same(app, priorApp);
        let resolved = app;
        let source = 'APP';

        if (initial) {
          // First connection: Fleet is the existing DJX4 operational source.
          resolved = fleet;
          source = 'FLEET';
        } else if (fleetChanged && !appChanged) {
          resolved = fleet;
          source = 'FLEET';
        } else if (!fleetChanged && appChanged) {
          resolved = app;
          source = 'APP';
        } else if (fleetChanged && appChanged) {
          // Fleet has no edit timestamp. Compare the app's real UpdatedAt with the last successful
          // observation; a later app edit wins, otherwise the newly observed Fleet edit wins.
          const appUpdatedAt = millis(van.UpdatedAt);
          if (appUpdatedAt > previousSyncMillis) {
            resolved = app;
            source = 'APP';
          } else {
            resolved = fleet;
            source = 'FLEET';
          }
        } else if (!same(fleet, app)) {
          // Drift without a newly attributable edit: keep the app canonical and repair Fleet.
          resolved = app;
          source = 'APP';
        }

        if (source === 'FLEET' && !same(app, resolved)) {
          appUpdates.set(van._documentId || id, {
            CurrentStatus: resolved.status,
            CurrentNote: resolved.note,
            CurrentNoteSource: 'FLEET',
            VanInfoReason: resolved.note,
            FleetSyncedAt: FieldValue.serverTimestamp()
          });
          fleetToApp++;
        }

        if (source === 'APP' && !same(fleet, resolved)) {
          if (fleet.status !== resolved.status) {
            sheetUpdates.push({ range: `'${sheetName}'!H${rowNumber}`, values: [[resolved.status]] });
          }
          if (fleet.note !== resolved.note) {
            sheetUpdates.push({ range: `'${sheetName}'!J${rowNumber}`, values: [[resolved.note]] });
          }
          appToFleet++;
        }

        nextFleet[id] = resolved;
        nextApp[id] = resolved;
      });

      if (appUpdates.size) {
        const entries = [...appUpdates.entries()];
        for (let offset = 0; offset < entries.length; offset += 400) {
          const batch = db.batch();
          for (const [docId, patch] of entries.slice(offset, offset + 400)) {
            batch.set(db.collection('vans').doc(docId), {
              ...patch,
              UpdatedAt: FieldValue.serverTimestamp()
            }, { merge: true });
          }
          await batch.commit();
        }
      }

      if (sheetUpdates.length) {
        for (let offset = 0; offset < sheetUpdates.length; offset += 400) {
          await sheets.spreadsheets.values.batchUpdate({
            spreadsheetId,
            requestBody: { valueInputOption: 'USER_ENTERED', data: sheetUpdates.slice(offset, offset + 400) }
          });
        }
      }

      await metadataRef.set({
        initialized: true,
        spreadsheetId,
        sheetName,
        fleet: nextFleet,
        app: nextApp,
        lastResult: { matched, fleetToApp, appToFleet, ignoredStatuses },
        LastObservedAtMs: observedAt,
        LastSyncAt: FieldValue.serverTimestamp()
      }, { merge: true });

      return { ok: true, matched, fleetToApp, appToFleet, ignoredStatuses };
    } finally {
      running = false;
    }
  }

  return { run };
}
