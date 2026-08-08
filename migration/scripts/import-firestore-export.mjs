import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import process from 'node:process';
import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';

if (!getApps().length) initializeApp({ credential: applicationDefault() });
const db = getFirestore();
const auth = getAuth();
const sourcePath = process.argv[2];
const dryRun = process.argv.includes('--dry-run');
if (!sourcePath) {
  console.error('Usage: node import-firestore-export.mjs <export.json> [--dry-run]');
  process.exit(1);
}

const payload = JSON.parse(await fs.readFile(sourcePath, 'utf8'));
if (payload.version !== 2 || !payload.data) throw new Error('Unsupported export version: ' + payload.version + '. Create a new version 2 export.');
const data = payload.data;
const stats = {};
const warnings = [];
const clean = value => String(value ?? '').trim();
const safeId = value => clean(value).replaceAll('/', '_').slice(0, 1500);
const active = value => value === true || !['false', 'no', '0', 'inactive'].includes(clean(value).toLowerCase());
const dateKey = value => {
  const text = clean(value);
  const direct = text.match(/^\d{4}-\d{2}-\d{2}/);
  if (direct) return direct[0];
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10);
};
const stripSource = row => Object.fromEntries(Object.entries(row || {}).filter(([key]) => !key.startsWith('_')));
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
async function importRows(collection, rows, idField, fallback) {
  let count = 0;
  for (const [index, source] of (rows || []).entries()) {
    const row = stripSource(source);
    const id = safeId(row[idField] || (fallback && fallback(row, index)));
    if (!id) { warnings.push(collection + ' row ' + (index + 2) + ' has no ' + idField + '.'); continue; }
    await set(db.collection(collection).doc(id), { ...row, [idField]: row[idField] || id, MigratedAt: FieldValue.serverTimestamp() });
    count += 1;
  }
  stats[collection] = count;
}

const config = {};
for (const row of data.config || []) {
  const key = clean(row.ConfigKey || row.Key);
  if (key) config[key] = row.Value ?? '';
}
await set(db.collection('system').doc('config'), { ...config, MigratedAt: FieldValue.serverTimestamp(), SourceSpreadsheetID: payload.spreadsheetId || '' });

let users = 0;
for (const row of data.users || []) {
  const email = clean(row.Email).toLowerCase();
  if (!email) continue;
  let account = null;
  if (!dryRun) {
    try {
      account = await auth.getUserByEmail(email);
      await auth.updateUser(account.uid, { disabled: !active(row.Active), displayName: clean(row.Name) || email });
    } catch (error) {
      if (error.code !== 'auth/user-not-found') throw error;
      account = await auth.createUser({
        email,
        displayName: clean(row.Name) || email,
        password: crypto.randomUUID() + crypto.randomUUID(),
        disabled: !active(row.Active)
      });
    }
  }
  const uid = account ? account.uid : 'dry_' + crypto.createHash('sha256').update(email).digest('hex').slice(0, 24);
  const scope = ['DJX3', 'DJX4', 'Both'].includes(clean(row.StationAccess)) ? clean(row.StationAccess) : 'Both';
  const defaultStation = ['DJX3', 'DJX4'].includes(clean(row.DefaultStation).toUpperCase()) ? clean(row.DefaultStation).toUpperCase() : 'DJX3';
  await set(db.collection('users').doc(uid), {
    ...stripSource(row),
    Email: email,
    Name: clean(row.Name) || email,
    Role: clean(row.Role).toLowerCase() === 'admin' ? 'Admin' : 'Lead',
    DefaultStation: defaultStation,
    WorkingStation: defaultStation,
    StationAccess: scope,
    stationAccess: scope === 'Both' ? ['DJX3', 'DJX4'] : [scope],
    Active: active(row.Active),
    active: active(row.Active),
    LegacyPasswordDiscarded: true,
    MigratedAt: FieldValue.serverTimestamp()
  });
  users += 1;
}
stats.users = users;
if (users) warnings.push(users + ' Firebase Auth accounts require password-reset links; legacy password hashes were not copied.');

await importRows('vans', data.vans, 'VanID', row => row.VanNumber);
await importRows('spots', data.spots, 'SpotID', row => String(row.Station) + '_' + String(row.Spot));
await importRows('inspections', (data.inspections || []).map(row => ({
  ...row,
  InspectionDate: dateKey(row.InspectionDate || row.StartedAt),
  Version: Number(row.Version || 1)
})), 'InspectionID');
await importRows('photos', data.photos, 'PhotoID');
await importRows('damages', data.damages, 'DamageID');
await importRows('audit', data.audit, 'EventID', (_row, index) => 'legacy_audit_' + (index + 1));
await importRows('rescueDrivers', data.rescueDrivers, 'DriverID', row => row.Driver);
await importRows('avatarMessages', data.avatarMessages, 'MessageID');
await importRows('avatarAcks', data.avatarAcks, 'AckID', row => String(row.MessageID) + '_' + String(row.UserEmail));

const metadata = new Map((data.syncMetadata || []).map(row => [clean(row.MetadataKey), row]));
const rescueDays = new Map();
function rescueDay(selectedStation, date) {
  if (!selectedStation || !date) return null;
  const key = date + '_' + selectedStation;
  if (!rescueDays.has(key)) rescueDays.set(key, { RecordKey: key, Date: date, Station: selectedStation, DailyDrivers: [], Rescues: [], Finalized: false, Version: 0 });
  return rescueDays.get(key);
}
function truthy(value) {
  return value === true || ['true', 'yes', '1'].includes(clean(value).toLowerCase());
}
for (const row of data.dailyRescueDrivers || []) {
  const value = rescueDay(clean(row.Station).toUpperCase(), dateKey(row.AssignmentDate || row.CreatedAt));
  if (value && !truthy(row.Deleted)) value.DailyDrivers.push(stripSource(row));
}
for (const row of data.rescues || []) {
  const value = rescueDay(clean(row.Station).toUpperCase(), dateKey(row.RescueDate || row.CreatedAt));
  if (value && !truthy(row.Deleted)) value.Rescues.push(stripSource(row));
}
for (const row of data.audit || []) {
  if (!['FINALIZE_DAILY_RESCUES', 'EDIT_DAILY_RESCUES', 'REOPEN_DAILY_RESCUES'].includes(clean(row.Action))) continue;
  const value = rescueDay(clean(row.EntityID).toUpperCase(), dateKey(row.Timestamp));
  if (value) value.Finalized = clean(row.Action) !== 'REOPEN_DAILY_RESCUES';
}
for (const [key, value] of rescueDays) {
  const legacy = metadata.get('RESCUE_' + value.Date + '_' + value.Station);
  value.Version = Number((legacy && legacy.Version) || (value.Finalized ? 1 : 0));
  value.UpdatedAt = (legacy && legacy.UpdatedAt) || payload.exportedAt;
  await set(db.collection('rescueDays').doc(key), { ...value, MigratedAt: FieldValue.serverTimestamp() });
}
stats.rescueDays = rescueDays.size;

await importRows('closingDays', (data.closingDays || []).map(row => ({ ...row, RecordDate: dateKey(row.RecordDate), Version: Number(row.Version || 1) })), 'RecordKey', row => dateKey(row.RecordDate) + '_' + row.Station);
await importRows('closingNotes', (data.closingNotes || []).map(row => ({ ...row, NoteDate: dateKey(row.NoteDate) })), 'NoteKey', row => dateKey(row.NoteDate) + '_' + row.Station);

const skipByKey = new Map();
for (const row of data.inspectionSkipRequests || []) {
  const key = dateKey(row.RequestDate) + '_' + clean(row.Station).toUpperCase();
  if (!key.startsWith('_')) skipByKey.set(key, stripSource(row));
}
for (const [key, row] of skipByKey) await set(db.collection('inspectionSkipRequests').doc(key), { ...row, MigratedAt: FieldValue.serverTimestamp() });
stats.inspectionSkipRequests = skipByKey.size;

await set(db.collection('system').doc('migration'), {
  Version: payload.version,
  SourceSpreadsheetID: payload.spreadsheetId || '',
  SourceSpreadsheetName: payload.spreadsheetName || '',
  ExportedAt: payload.exportedAt || '',
  ImportedAt: FieldValue.serverTimestamp(),
  Complete: false,
  MediaImported: false,
  PasswordResetLinksSent: false,
  Stats: stats
});
await flush();
console.log(JSON.stringify({ ok: true, dryRun, sourcePath, stats, warnings }, null, 2));
