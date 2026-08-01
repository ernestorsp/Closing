import fs from 'node:fs/promises';
import process from 'node:process';
import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';

if (!getApps().length) initializeApp({ credential: applicationDefault() });
const db = getFirestore();
const sourcePath = process.argv[2];
const dryRun = process.argv.includes('--dry-run');
if (!sourcePath) {
  console.error('Usage: node import-firestore-export.mjs <export.json> [--dry-run]');
  process.exit(1);
}

const payload = JSON.parse(await fs.readFile(sourcePath, 'utf8'));
if (payload.version !== 1) throw new Error(`Unsupported export version: ${payload.version}`);

const stats = { vans: 0, spots: 0, inspections: 0, users: 0, skipped: 0 };
const clean = value => String(value ?? '').trim();
const get = (row, names) => {
  for (const name of names) if (clean(row[name])) return clean(row[name]);
  return '';
};
const bool = value => ['true', 'yes', '1', 'active'].includes(clean(value).toLowerCase());
const batchLimit = 400;
let batch = db.batch();
let pending = 0;

async function flush() {
  if (!pending) return;
  if (!dryRun) await batch.commit();
  batch = db.batch();
  pending = 0;
}

async function set(ref, value, options = { merge: true }) {
  if (!dryRun) batch.set(ref, value, options);
  pending += 1;
  if (pending >= batchLimit) await flush();
}

for (const row of payload.vans || []) {
  const vanId = get(row, ['vanId', 'VanID', 'id', 'ID', 'vanNumber', 'VanNumber']);
  if (!vanId) { stats.skipped += 1; continue; }
  await set(db.collection('vans').doc(vanId), {
    vanId,
    vanNumber: get(row, ['vanNumber', 'VanNumber', 'van', 'Van']),
    vanType: get(row, ['vanType', 'VanType', 'type', 'Type']),
    currentStation: get(row, ['currentStation', 'CurrentStation', 'station', 'Station']),
    currentSpot: get(row, ['currentSpot', 'CurrentSpot', 'spot', 'Spot']),
    currentStatus: get(row, ['currentStatus', 'CurrentStatus', 'status', 'Status']) || 'Operational',
    migration: { sourceSheet: row._sourceSheet || '', sourceRow: row._sourceRow || 0 },
    migratedAt: FieldValue.serverTimestamp()
  });
  stats.vans += 1;
}

for (const row of payload.spots || []) {
  const station = get(row, ['station', 'Station']);
  const spot = get(row, ['spot', 'Spot', 'spotNumber', 'SpotNumber']);
  if (!station || !spot) { stats.skipped += 1; continue; }
  await set(db.collection('spots').doc(`${station}_${spot}`), {
    station, spot,
    vanId: get(row, ['vanId', 'VanID']),
    migration: { sourceSheet: row._sourceSheet || '', sourceRow: row._sourceRow || 0 },
    migratedAt: FieldValue.serverTimestamp()
  });
  stats.spots += 1;
}

for (const row of payload.inspections || []) {
  const inspectionId = get(row, ['inspectionId', 'InspectionID', 'id', 'ID']);
  const vanId = get(row, ['vanId', 'VanID']);
  if (!inspectionId || !vanId) { stats.skipped += 1; continue; }
  await set(db.collection('inspections').doc(inspectionId), {
    inspectionId, vanId,
    station: get(row, ['station', 'Station']),
    spot: get(row, ['spot', 'Spot']),
    status: get(row, ['status', 'Status']) || 'Operational',
    state: get(row, ['inspectionState', 'InspectionState', 'state', 'State']) || 'Completed',
    notes: get(row, ['notes', 'Notes']),
    migration: { sourceSheet: row._sourceSheet || '', sourceRow: row._sourceRow || 0 },
    migratedAt: FieldValue.serverTimestamp()
  });
  stats.inspections += 1;
}

for (const row of payload.users || []) {
  const uid = get(row, ['firebaseUid', 'FirebaseUid', 'uid', 'UID']);
  if (!uid) { stats.skipped += 1; continue; }
  await set(db.collection('users').doc(uid), {
    uid,
    email: get(row, ['email', 'Email']),
    displayName: get(row, ['displayName', 'DisplayName', 'name', 'Name']),
    role: get(row, ['role', 'Role']).toLowerCase() === 'admin' ? 'admin' : 'lead',
    station: get(row, ['station', 'Station']) || 'DJX3',
    active: bool(get(row, ['active', 'Active', 'status', 'Status'])),
    migration: { sourceSheet: row._sourceSheet || '', sourceRow: row._sourceRow || 0 },
    migratedAt: FieldValue.serverTimestamp()
  });
  stats.users += 1;
}

await flush();
console.log(JSON.stringify({ ok: true, dryRun, sourcePath, stats }, null, 2));
