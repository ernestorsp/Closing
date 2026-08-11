import express from 'express';
import { FieldValue } from 'firebase-admin/firestore';
import readXlsxFile from 'read-excel-file/node';
import {
  PHOTO_PARTS,
  STATUSES,
  WORK_STATIONS,
  apiError,
  allowedStations,
  assertAdmin,
  assertStationAccess,
  dateKey,
  docData,
  identifier,
  inspectionDayKey,
  isAdmin,
  isYes,
  publicUser,
  serialize,
  station,
  text,
  todayKey,
  vanHomeStation,
  workingStation
} from './domain.js';
import { actorFromRequest, auditWrite, getCollection, getWhere, keyForDay } from './firestore-helpers.js';
import { availableSpots } from './sync-service.js';

function newest(left, right) {
  return new Date(right.CompletedAt || right.UpdatedAt || right.StartedAt || 0) - new Date(left.CompletedAt || left.UpdatedAt || left.StartedAt || 0);
}

function userProfileRecord(profile, uid, selfUid) {
  return {
    uid,
    email: text(profile.Email || profile.email, 320).toLowerCase(),
    name: text(profile.Name || profile.displayName, 160),
    role: isAdmin(profile) ? 'Admin' : 'Lead',
    defaultStation: text(profile.DefaultStation || profile.station || 'DJX3', 10),
    stationAccess: text(profile.StationAccess || (Array.isArray(profile.stationAccess) && profile.stationAccess.length > 1 ? 'Both' : profile.stationAccess?.[0]) || 'Both', 20),
    active: profile.Active !== false && profile.active !== false,
    updatedAt: serialize(profile.UpdatedAt || profile.updatedAt || ''),
    isSelf: uid === selfUid
  };
}

async function appData(db, req) {
  const profile = req.profile;
  const selectedStation = workingStation(profile);
  const today = todayKey();
  const inspectionToday = inspectionDayKey();
  const key = keyForDay(selectedStation, today);
  const [vans, spots, inspections, drivers, rescueDay, closing, note, skip, messages, acks] = await Promise.all([
    getCollection(db, 'vans', 2500),
    getCollection(db, 'spots', 1000),
    getWhere(db, 'inspections', 'InspectionDate', '==', inspectionToday, 1500),
    getCollection(db, 'rescueDrivers', 3000),
    db.collection('rescueDays').doc(key).get(),
    db.collection('closingDays').doc(key).get(),
    db.collection('closingNotes').doc(key).get(),
    db.collection('inspectionSkipRequests').doc(key).get(),
    getCollection(db, 'avatarMessages', 250),
    getWhere(db, 'avatarAcks', 'UserUid', '==', req.user.uid, 500)
  ]);
  const activeVans = vans.filter(van => van.Active !== false);
  const completedToday = inspections.filter(row => row.InspectionState === 'Completed').sort(newest);
  const completedVanIds = [...new Set(completedToday.map(row => String(row.VanID)))];
  const completed = new Set(completedVanIds);
  const stationDone = completedToday.filter(row => (row.WorkingStation || row.Station) === selectedStation);
  const stationPending = activeVans.filter(van => vanHomeStation(van) === selectedStation && !completed.has(String(van.VanID)));
  const rescue = rescueDay.exists ? serialize(rescueDay.data()) : {};
  const closingData = closing.exists ? serialize(closing.data()) : null;
  const closingNote = note.exists && note.get('Status') === 'Sent' ? serialize(note.data()) : null;
  const skipRecord = skip.exists ? serialize(skip.data()) : null;
  const inspectionSkip = skipRecord
    ? { status: skipRecord.Status || 'Pending', requestedAt: skipRecord.RequestedAt || '', requestedAdminName: skipRecord.RequestedAdminName || '' }
    : { status: 'None' };
  const inspectionsReady = !stationPending.length || inspectionSkip.status === 'Approved';
  const counts = { Operational: 0, Downed: 0, Grounded: 0 };
  activeVans.filter(van => vanHomeStation(van) === selectedStation).forEach(van => {
    const status = van.CurrentStation === 'SHOP' ? 'Grounded' : (van.CurrentStatus || 'Operational');
    if (Object.hasOwn(counts, status)) counts[status] += 1;
  });
  const acknowledged = new Set(acks.map(row => String(row.MessageID)));
  const avatarMessages = messages
    .filter(row => row.Active !== false && !acknowledged.has(String(row.MessageID)) && ['ALL', selectedStation].includes(text(row.Station || 'ALL', 10).toUpperCase()))
    .sort((a, b) => new Date(a.CreatedAt || 0) - new Date(b.CreatedAt || 0))
    .map(row => ({ messageId: String(row.MessageID || row._documentId), text: String(row.MessageText || ''), station: row.Station || 'ALL', createdAt: row.CreatedAt || '', createdByName: row.CreatedByName || 'Admin', requiresAck: true }));
  const activeDrivers = drivers.filter(row => row.Active !== false && row.Driver && !String(row.Driver).includes('---')).sort((a, b) => String(a.Station).localeCompare(String(b.Station)) || String(a.Driver).localeCompare(String(b.Driver)));
  return {
    user: publicUser(profile, req.user),
    today,
    vans: activeVans,
    avatarMessages,
    vanCounts: counts,
    closingData,
    closingNote,
    inspectionSkip,
    spots: spots.filter(row => row.Active !== false).map(row => ({ SpotID: String(row.SpotID || row._documentId), Station: String(row.Station), Spot: String(row.Spot), OccupiedByVanID: String(row.OccupiedByVanID || '') })),
    completedToday,
    completedVanIds,
    inProgress: inspections.filter(row => row.InspectionState === 'In Progress' && (row.UserUid === req.user.uid || text(row.UserEmail).toLowerCase() === text(req.user.email).toLowerCase())).sort(newest),
    rescueDrivers: activeDrivers.map(row => ({ DriverID: String(row.DriverID || row._documentId), Driver: row.Driver, Station: row.Station })),
    dailyRescueDrivers: Array.isArray(rescue.DailyDrivers) ? rescue.DailyDrivers : [],
    rescues: Array.isArray(rescue.Rescues) ? rescue.Rescues : [],
    rescueFinalized: rescue.Finalized === true,
    checklist: {
      inspectionsCompleted: stationDone.length,
      inspectionsTotal: stationDone.length + stationPending.length,
      inspectionsReady,
      inspectionsSkipped: inspectionSkip.status === 'Approved',
      rescuesReady: rescue.Finalized === true,
      pickupReady: Boolean(closingData),
      returnedPackagesReady: Boolean(closingData),
      routesTomorrowReady: Boolean(closingData),
      allReady: inspectionsReady && rescue.Finalized === true && Boolean(closingData),
      notesSent: Boolean(closingNote)
    },
    stats: {
      vans: activeVans.length,
      completed: completedToday.length,
      pending: stationPending.length,
      issues: completedToday.filter(row => row.Status !== 'Operational').length
    }
  };
}

function parseCsvMatrix(source) {
  const rows = [];
  let row = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === '"') {
      if (quoted && source[index + 1] === '"') {
        value += '"';
        index += 1;
      } else quoted = !quoted;
    } else if (character === ',' && !quoted) {
      row.push(value);
      value = '';
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && source[index + 1] === '\n') index += 1;
      row.push(value);
      if (row.some(cell => String(cell).trim())) rows.push(row);
      row = [];
      value = '';
    } else value += character;
  }
  row.push(value);
  if (row.some(cell => String(cell).trim())) rows.push(row);
  return rows;
}

async function parseTable(file) {
  const name = text(file?.name, 300).toLowerCase();
  const encoded = String(file?.base64 || '');
  if (!encoded) throw apiError(400, 'FILE_REQUIRED', 'Choose a file to upload.');
  if (encoded.length > 16_000_000) throw apiError(413, 'FILE_TOO_LARGE', 'The file is too large.');
  const buffer = Buffer.from(encoded, 'base64');
  let matrix;
  if (name.endsWith('.csv')) matrix = parseCsvMatrix(buffer.toString('utf8').replace(/^\uFEFF/, ''));
  else {
    try {
      matrix = await readXlsxFile(buffer);
    } catch {
      throw apiError(400, 'INVALID_FILE', 'The file is not a valid XLSX or CSV file.');
    }
  }
  if (matrix.length < 2) throw apiError(400, 'EMPTY_FILE', 'The file has no data rows.');
  return { name, headers: matrix[0].map(value => text(value, 200)), rows: matrix.slice(1) };
}

function normalizedColumns(headers) {
  const map = new Map();
  headers.forEach((header, index) => map.set(text(header, 200).toLowerCase().replace(/\s+/g, ' '), index));
  return map;
}

function tableCell(row, columns, name) {
  const index = columns.get(name.toLowerCase());
  return index === undefined ? '' : text(row[index], 1000);
}

async function commitBatches(db, writes) {
  for (let start = 0; start < writes.length; start += 400) {
    const batch = db.batch();
    writes.slice(start, start + 400).forEach(write => write(batch));
    await batch.commit();
  }
}

export function createRpcRouter({ db, auth, bucket, mailer, requireAuth, syncService }) {
  const router = express.Router();
  router.use(requireAuth);

  const methods = {
    async getAppData(req) { return appData(db, req); },
    async getLocalFirstMetadata(req) {
      const key = keyForDay(workingStation(req.profile), todayKey());
      const snapshot = await db.collection('rescueDays').doc(key).get();
      return { rescueVersion: Number(snapshot.get('Version') || 0), rescueUpdatedAt: serialize(snapshot.get('UpdatedAt') || '') };
    },
    async syncApplyOperation(req, [operation]) { return syncService.apply(req, operation); },
    async setPreferredLanguage(req, [language]) {
      const value = text(language, 5).toLowerCase();
      if (!['en', 'es'].includes(value)) throw apiError(400, 'INVALID_LANGUAGE', 'Invalid language.');
      await db.collection('users').doc(req.user.uid).set({ PreferredLanguage: value, preferredLanguage: value, UpdatedAt: FieldValue.serverTimestamp() }, { merge: true });
      return { ok: true, language: value };
    },
    async setWorkingStation(req, [requested]) {
      const selected = assertStationAccess(req.profile, requested);
      await db.collection('users').doc(req.user.uid).set({ WorkingStation: selected, DefaultStation: selected, station: selected, UpdatedAt: FieldValue.serverTimestamp() }, { merge: true });
      req.profile.WorkingStation = selected;
      return { ok: true, station: selected };
    },
    async getAvailableSpots(req, [requested, vanId]) { return availableSpots(db, requested, vanId, req.user.email); },
    async getInspection(req, [inspectionId]) { return syncService.inspectionData(identifier(inspectionId, 'inspectionId'), req); },
    async startInspection(req, [input]) {
      return (await syncService.apply(req, { id: crypto.randomUUID(), type: 'START_INSPECTION', day: todayKey(), station: workingStation(req.profile), entityId: input?.vanId, payload: { ...(input || {}), inspectionId: crypto.randomUUID() } })).result;
    },
    async saveInspectionPhoto(req, [input]) {
      if (!input?.storagePath) throw apiError(400, 'DIRECT_PHOTO_UNSUPPORTED', 'Photo must be queued on the device before synchronization.');
      return (await syncService.apply(req, { id: crypto.randomUUID(), type: 'SAVE_INSPECTION_PHOTO', day: todayKey(), station: workingStation(req.profile), entityId: input.inspectionId, payload: input })).result;
    },
    async saveDamageReport(req, [input]) {
      if (!input?.storagePath) throw apiError(400, 'DIRECT_PHOTO_UNSUPPORTED', 'Damage photo must be queued on the device before synchronization.');
      return (await syncService.apply(req, { id: crypto.randomUUID(), type: 'SAVE_DAMAGE', day: todayKey(), station: workingStation(req.profile), entityId: input.inspectionId, payload: input })).result;
    },
    async finishInspection(req, [input]) {
      return (await syncService.apply(req, { id: crypto.randomUUID(), type: 'FINISH_INSPECTION', day: todayKey(), station: workingStation(req.profile), entityId: input?.inspectionId, payload: input || {} })).result;
    },
    async saveDailyClosing(req, [input]) {
      return (await syncService.apply(req, { id: crypto.randomUUID(), type: 'SAVE_CLOSING', day: input?.date || todayKey(), station: workingStation(req.profile), entityId: input?.date, payload: input || {} })).result;
    },
    async saveDailyRescuesBatch(req, [input]) {
      const key = keyForDay(workingStation(req.profile), todayKey());
      const current = await db.collection('rescueDays').doc(key).get();
      return (await syncService.apply(req, { id: crypto.randomUUID(), type: 'SAVE_RESCUES', day: todayKey(), station: workingStation(req.profile), entityId: key, payload: { ...(input || {}), expectedVersion: Number(current.get('Version') || 0) } })).result;
    },
    async sendClosingNotes(req, [input]) {
      return (await syncService.apply(req, { id: crypto.randomUUID(), type: 'SEND_NOTES', day: todayKey(), station: workingStation(req.profile), entityId: keyForDay(workingStation(req.profile), todayKey()), payload: input || {} })).result;
    },
    async reopenDailyRescues(req) {
      const key = keyForDay(workingStation(req.profile), todayKey());
      await db.collection('rescueDays').doc(key).set({ Finalized: false, UpdatedAt: FieldValue.serverTimestamp(), ReopenedByUid: req.user.uid }, { merge: true });
      await auditWrite(db, actorFromRequest(req), 'REOPEN_DAILY_RESCUES', 'RESCUE', workingStation(req.profile), 'Editing saved rescues');
      return { ok: true, message: `${workingStation(req.profile)} rescues are open for editing.` };
    },
    async skipGroundedInspection(req, [vanId]) {
      const id = identifier(vanId, 'vanId');
      const vanRef = db.collection('vans').doc(id);
      const inspectionId = crypto.randomUUID();
      const inspectionRef = db.collection('inspections').doc(inspectionId);
      const actor = actorFromRequest(req);
      await db.runTransaction(async tx => {
        const van = await tx.get(vanRef);
        if (!van.exists || van.get('Active') === false) throw apiError(404, 'VAN_NOT_FOUND', 'Van not found.');
        if (van.get('CurrentStatus') !== 'Grounded' && van.get('CurrentStation') !== 'SHOP') throw apiError(400, 'NOT_GROUNDED', 'Only grounded vans can be completed without inspection.');
        const selected = workingStation(req.profile);
        tx.set(inspectionRef, {
          InspectionID: inspectionId, InspectionDate: inspectionDayKey(), StartedAt: FieldValue.serverTimestamp(), CompletedAt: FieldValue.serverTimestamp(), DurationMinutes: 0,
          UserUid: req.user.uid, UserEmail: actor.email, UserName: actor.name, WorkingStation: selected, VanID: id, VanNumber: van.get('VanNumber') || id,
          PreviousStation: van.get('CurrentStation') || selected, Station: van.get('CurrentStation') || selected, PreviousSpot: van.get('CurrentSpot') || '', Spot: van.get('CurrentSpot') || '',
          PreviousStatus: 'Grounded', Status: 'Grounded', LocationChanged: false, PhotoProgress: '0/6', InspectionState: 'Completed', Notes: 'Grounded van - inspection not required.', Version: 1
        });
        tx.set(vanRef, { LastInspectionAt: FieldValue.serverTimestamp(), LastInspectionID: inspectionId, UpdatedAt: FieldValue.serverTimestamp() }, { merge: true });
      });
      await auditWrite(db, actor, 'SKIP_GROUNDED_INSPECTION', 'INSPECTION', inspectionId, `Van ${id}`);
      return { ok: true, message: 'Grounded van completed without inspection.' };
    },
    async getVanHistory(req, [vanId]) {
      assertAdmin(req.profile);
      return (await getWhere(db, 'inspections', 'VanID', '==', identifier(vanId, 'vanId'), 250)).filter(row => row.InspectionState === 'Completed').sort(newest).slice(0, 50);
    },
    async getCompletedInspection(req, [inspectionId]) {
      assertAdmin(req.profile);
      const data = await syncService.inspectionData(identifier(inspectionId, 'inspectionId'), req, { editable: false });
      if (data.inspection.InspectionState !== 'Completed') throw apiError(409, 'NOT_COMPLETED', 'This inspection is not completed.');
      return { inspection: data.inspection, photos: data.photos.map(row => ({ PhotoID: row.PhotoID, Part: row.Part, CapturedAt: row.CapturedAt, DamageAssessment: row.DamageAssessment || '', DamageNotes: row.DamageNotes || '', StoragePath: row.StoragePath })), damages: data.damages, requiredParts: PHOTO_PARTS };
    },
    async getEditableInspection(req, [inspectionId]) {
      const id = identifier(inspectionId, 'inspectionId');
      const data = await syncService.inspectionData(id, req);
      if (data.inspection.InspectionState !== 'Completed') throw apiError(404, 'NOT_COMPLETED', 'Completed inspection not found.');
      const events = await getWhere(db, 'audit', 'EntityID', '==', id, 100);
      return { ...data, mediaLoaded: true, audit: events.filter(event => String(event.Action).includes('EDIT')).sort((a, b) => new Date(b.Timestamp || 0) - new Date(a.Timestamp || 0)).slice(0, 20) };
    },
    async getInspectionPhoto(req, [inspectionId, photoId]) {
      assertAdmin(req.profile);
      const photo = docData(await db.collection('photos').doc(identifier(photoId, 'photoId')).get());
      if (!photo || String(photo.InspectionID) !== String(inspectionId)) throw apiError(404, 'PHOTO_NOT_FOUND', 'Photo not found.');
      return { storagePath: photo.StoragePath, capturedAt: photo.CapturedAt, assessment: photo.DamageAssessment || '', notes: photo.DamageNotes || '' };
    },
    async getPreviousPhoto(req, [inspectionId, part]) {
      const current = docData(await db.collection('inspections').doc(identifier(inspectionId, 'inspectionId')).get());
      if (!current) throw apiError(404, 'INSPECTION_NOT_FOUND', 'Inspection not found.');
      const history = (await getWhere(db, 'inspections', 'VanID', '==', current.VanID, 250)).filter(row => row.InspectionState === 'Completed' && row.InspectionID !== current.InspectionID).sort(newest);
      for (const inspection of history) {
        const photos = await getWhere(db, 'photos', 'InspectionID', '==', inspection.InspectionID, 100);
        const photo = photos.find(row => row.Part === part);
        if (photo) return { found: true, storagePath: photo.StoragePath, capturedAt: photo.CapturedAt, assessment: photo.DamageAssessment || '', notes: photo.DamageNotes || '' };
      }
      return { found: false };
    },
    async getAdminData(req) {
      assertAdmin(req.profile);
      const [users, updates] = await Promise.all([getCollection(db, 'users', 1000), db.collection('system').doc('imports').get()]);
      return {
        lastUpdates: updates.exists ? serialize(updates.data()) : { drivers: { DJX3: null, DJX4: null }, vans: null },
        users: users.map(row => userProfileRecord(row, row._documentId, req.user.uid)).filter(row => row.email).sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name)),
        permissions: [
          { role: 'Admin', access: 'All Closing pages, History, Update, invitations and user management' },
          { role: 'Lead', access: 'Daily Closing pages for the assigned station(s); no History or administration' }
        ]
      };
    },
    async createUserInvitation(req, [input]) {
      assertAdmin(req.profile);
      const email = text(input?.email, 320).toLowerCase();
      const name = text(input?.name, 160);
      const selectedRole = ['Admin', 'Lead'].includes(input?.role) ? input.role : 'Lead';
      const scope = ['DJX3', 'DJX4', 'Both'].includes(input?.stationAccess) ? input.stationAccess : 'Both';
      const defaultStation = station(input?.defaultStation || 'DJX3', { workingOnly: true });
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !name) throw apiError(400, 'INVALID_USER', 'Enter a valid email and user name.');
      if (scope !== 'Both' && scope !== defaultStation) throw apiError(400, 'INVALID_STATION_ACCESS', 'Default station must match station access.');
      let account;
      try {
        account = await auth.getUserByEmail(email);
        const current = await db.collection('users').doc(account.uid).get();
        if (current.exists && current.get('Active') !== false) throw apiError(409, 'USER_EXISTS', 'That email already has an active account.');
        await auth.updateUser(account.uid, { disabled: false, displayName: name });
      } catch (error) {
        if (error.code && error.code !== 'auth/user-not-found') throw error;
        account = await auth.createUser({ email, displayName: name, password: crypto.randomUUID() + crypto.randomUUID(), disabled: false });
      }
      await db.collection('users').doc(account.uid).set({
        Email: email, Name: name, Role: selectedRole, DefaultStation: defaultStation, WorkingStation: defaultStation, StationAccess: scope,
        stationAccess: scope === 'Both' ? [...WORK_STATIONS] : [scope], Active: true, active: true, InvitedAt: FieldValue.serverTimestamp(), InvitedBy: req.user.email || '', UpdatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
      const link = await auth.generatePasswordResetLink(email, { url: process.env.PUBLIC_APP_URL || 'https://aaxi-closing.web.app' });
      await mailer.send({ to: [email], subject: 'Invitation to AAXI Closing', html: `<div style="font-family:Arial,sans-serif"><h2>AAXI Closing invitation</h2><p>Hello <b>${name}</b>,</p><p>You were invited as <b>${selectedRole}</b> with access to <b>${scope}</b>.</p><p><a href="${link}">CREATE PASSWORD</a></p></div>`, textBody: `Create your AAXI Closing password: ${link}`, idempotencyKey: `invite-${account.uid}-${Date.now()}` });
      await auditWrite(db, actorFromRequest(req), 'INVITE_USER', 'USER', email, `${selectedRole} · ${scope}`);
      return { ok: true, message: `Invitation sent to ${email}.` };
    },
    async updateManagedUser(req, [input]) {
      assertAdmin(req.profile);
      const email = text(input?.email, 320).toLowerCase();
      const account = await auth.getUserByEmail(email).catch(() => null);
      if (!account) throw apiError(404, 'USER_NOT_FOUND', 'User not found.');
      const selectedRole = input?.role === 'Admin' ? 'Admin' : 'Lead';
      const active = input?.active === true || String(input?.active).toLowerCase() === 'true';
      if (account.uid === req.user.uid && (!active || selectedRole !== 'Admin')) throw apiError(409, 'CANNOT_REMOVE_SELF', 'You cannot remove your own Admin access.');
      const scope = ['DJX3', 'DJX4', 'Both'].includes(input?.stationAccess) ? input.stationAccess : 'Both';
      const defaultStation = station(input?.defaultStation || 'DJX3', { workingOnly: true });
      await Promise.all([
        auth.updateUser(account.uid, { disabled: !active, displayName: text(input?.name, 160) }),
        db.collection('users').doc(account.uid).set({ Email: email, Name: text(input?.name, 160), Role: selectedRole, DefaultStation: defaultStation, StationAccess: scope, stationAccess: scope === 'Both' ? [...WORK_STATIONS] : [scope], Active: active, active, UpdatedAt: FieldValue.serverTimestamp() }, { merge: true })
      ]);
      await auditWrite(db, actorFromRequest(req), 'UPDATE_USER', 'USER', email, `${selectedRole} · ${scope} · ${active ? 'Active' : 'Inactive'}`);
      return { ok: true, message: 'User permissions updated.' };
    },
    async removeManagedUser(req, [emailValue]) {
      assertAdmin(req.profile);
      const email = text(emailValue, 320).toLowerCase();
      const account = await auth.getUserByEmail(email).catch(() => null);
      if (!account) throw apiError(404, 'USER_NOT_FOUND', 'User not found.');
      if (account.uid === req.user.uid) throw apiError(409, 'CANNOT_REMOVE_SELF', 'You cannot remove your own account.');
      await Promise.all([auth.updateUser(account.uid, { disabled: true }), db.collection('users').doc(account.uid).set({ Active: false, active: false, RemovedAt: FieldValue.serverTimestamp(), RemovedByUid: req.user.uid }, { merge: true })]);
      await auditWrite(db, actorFromRequest(req), 'REMOVE_USER', 'USER', email, 'Access disabled');
      return { ok: true, message: 'User access removed.' };
    },
    async removeManagedVan(req, [vanId]) {
      assertAdmin(req.profile);
      const id = identifier(vanId, 'vanId');
      const ref = db.collection('vans').doc(id);
      const van = await ref.get();
      if (!van.exists) throw apiError(404, 'VAN_NOT_FOUND', 'Van not found.');
      const activeInspections = (await getWhere(db, 'inspections', 'VanID', '==', id, 100)).filter(row => row.InspectionState === 'In Progress');
      if (activeInspections.length) throw apiError(409, 'VAN_IN_PROGRESS', 'This van has an inspection in progress. Finish it before removing the van.');
      await ref.set({ Active: false, RemovedAt: FieldValue.serverTimestamp(), RemovedByUid: req.user.uid }, { merge: true });
      await auditWrite(db, actorFromRequest(req), 'REMOVE_VAN', 'VAN', id, `Van ${van.get('VanNumber') || id} removed from fleet`);
      return { ok: true, message: `Van ${van.get('VanNumber') || id} removed from the fleet.` };
    },
    async importDriversFile(req, [requestedStation, file]) {
      assertAdmin(req.profile);
      const selected = station(requestedStation, { workingOnly: true });
      const table = await parseTable(file);
      const columns = normalizedColumns(table.headers);
      for (const required of ['name and id', 'transporterid', 'status']) if (!columns.has(required)) throw apiError(400, 'MISSING_COLUMN', `Invalid driver file. Missing column: ${required}.`);
      const seen = new Set();
      const items = table.rows.map((row, index) => {
        const id = tableCell(row, columns, 'TransporterID').toUpperCase();
        const name = tableCell(row, columns, 'Name and ID').replace(/\s+/g, ' ').trim();
        if (!id && !name) return null;
        if (!id || !name || seen.has(id)) throw apiError(400, 'INVALID_DRIVER_ROW', `Invalid or duplicate driver at row ${index + 2}.`);
        seen.add(id);
        return { DriverID: id, Driver: name, Station: selected, Email: tableCell(row, columns, 'Email'), Active: tableCell(row, columns, 'Status').toUpperCase() === 'ACTIVE', UpdatedAt: new Date().toISOString() };
      }).filter(Boolean);
      const existing = await getWhere(db, 'rescueDrivers', 'Station', '==', selected, 3000);
      const writes = existing.filter(row => !seen.has(String(row.DriverID))).map(row => batch => batch.set(db.collection('rescueDrivers').doc(String(row.DriverID || row._documentId)), { Active: false, UpdatedAt: FieldValue.serverTimestamp() }, { merge: true }));
      items.forEach(item => writes.push(batch => batch.set(db.collection('rescueDrivers').doc(item.DriverID), item, { merge: true })));
      await commitBatches(db, writes);
      const update = { at: new Date().toISOString(), email: req.user.email || '', name: req.profile.Name || '' };
      await db.collection('system').doc('imports').set({ drivers: { [selected]: update } }, { merge: true });
      const active = items.filter(item => item.Active).length;
      return { ok: true, total: items.length, active, inactive: items.length - active, message: `${selected} drivers updated: ${active} active, ${items.length - active} inactive.` };
    },
    async importVansFile(req, [file]) {
      assertAdmin(req.profile);
      const table = await parseTable(file);
      const columns = normalizedColumns(table.headers);
      for (const required of ['vin', 'vehiclename', 'status', 'operationalstatus', 'stationcode']) if (!columns.has(required)) throw apiError(400, 'MISSING_COLUMN', `Invalid vehicle file. Missing column: ${required}.`);
      const seen = new Set();
      const items = table.rows.map((row, index) => {
        const id = tableCell(row, columns, 'vin').toUpperCase();
        const rawName = tableCell(row, columns, 'vehicleName');
        const home = tableCell(row, columns, 'stationCode').toUpperCase();
        if (!id && !rawName) return null;
        if (!id || !rawName || !WORK_STATIONS.includes(home) || seen.has(id)) throw apiError(400, 'INVALID_VAN_ROW', `Invalid or duplicate vehicle at row ${index + 2}.`);
        seen.add(id);
        const source = tableCell(row, columns, 'operationalStatus').toUpperCase();
        return { VanID: id, VanNumber: rawName.replace(/^EDV\s*/i, '').trim(), VanType: /ELECTRIC|EDV|RPV/.test(rawName.toUpperCase()) ? 'EDV' : 'Van', HomeStation: home, CurrentStation: home, CurrentSpot: '', CurrentStatus: source === 'GROUNDED' ? 'Grounded' : source === 'DOWNED' ? 'Downed' : 'Operational', Active: tableCell(row, columns, 'status').toUpperCase() === 'ACTIVE', UpdatedAt: new Date().toISOString() };
      }).filter(Boolean);
      const refs = items.map(item => db.collection('vans').doc(item.VanID));
      const snapshots = await db.getAll(...refs);
      const newItems = items.filter((_item, index) => !snapshots[index].exists);
      await commitBatches(db, newItems.map(item => batch => batch.set(db.collection('vans').doc(item.VanID), item)));
      const update = { at: new Date().toISOString(), email: req.user.email || '', name: req.profile.Name || '' };
      await db.collection('system').doc('imports').set({ vans: update }, { merge: true });
      return { ok: true, total: items.length, added: newItems.length, unchanged: items.length - newItems.length, active: items.filter(item => item.Active).length, stations: { DJX3: items.filter(item => item.Active && item.HomeStation === 'DJX3').length, DJX4: items.filter(item => item.Active && item.HomeStation === 'DJX4').length }, message: `Vans checked: ${newItems.length} new added; ${items.length - newItems.length} existing vans left unchanged.` };
    },
    async getAvatarMessages(req) {
      const data = await appData(db, req);
      return { messages: data.avatarMessages };
    },
    async acknowledgeAvatarMessage(req, [messageId]) {
      const id = identifier(messageId, 'messageId');
      const ref = db.collection('avatarMessages').doc(id);
      const message = await ref.get();
      if (!message.exists) throw apiError(404, 'MESSAGE_NOT_FOUND', 'Message not found.');
      const ackRef = db.collection('avatarAcks').doc(`${id}_${req.user.uid}`);
      await Promise.all([
        ackRef.set({ AckID: ackRef.id, MessageID: id, UserUid: req.user.uid, UserEmail: req.user.email || '', UserName: req.profile.Name || '', AcknowledgedAt: FieldValue.serverTimestamp() }),
        ref.set({ Active: false }, { merge: true })
      ]);
      const data = await appData(db, req);
      return { ok: true, claimed: true, messages: data.avatarMessages };
    },
    async sendAvatarMessage(req, [input]) {
      assertAdmin(req.profile);
      const messageText = text(input?.message, 500);
      const audience = text(input?.station || 'ALL', 10).toUpperCase();
      if (!messageText || !['ALL', ...WORK_STATIONS].includes(audience)) throw apiError(400, 'INVALID_MESSAGE', 'Write a message and select All, DJX3 or DJX4.');
      const id = crypto.randomUUID();
      await db.collection('avatarMessages').doc(id).set({ MessageID: id, MessageText: messageText, Station: audience, Active: true, CreatedAt: FieldValue.serverTimestamp(), CreatedByEmail: req.user.email || '', CreatedByName: req.profile.Name || req.user.email || '' });
      return { ok: true, message: 'Message sent through Closing Buddy.', data: await methods.getAvatarAdminData(req) };
    },
    async getAvatarAdminData(req) {
      assertAdmin(req.profile);
      const [messages, acks] = await Promise.all([getCollection(db, 'avatarMessages', 500), getCollection(db, 'avatarAcks', 3000)]);
      const counts = new Map();
      acks.forEach(row => counts.set(String(row.MessageID), Number(counts.get(String(row.MessageID)) || 0) + 1));
      return { messages: messages.sort((a, b) => new Date(b.CreatedAt || 0) - new Date(a.CreatedAt || 0)).map(row => ({ messageId: String(row.MessageID || row._documentId), text: String(row.MessageText || ''), station: String(row.Station || 'ALL'), active: row.Active !== false, createdAt: row.CreatedAt || '', createdByName: row.CreatedByName || row.CreatedByEmail || 'Admin', ackCount: counts.get(String(row.MessageID || row._documentId)) || 0 })) };
    },
    async getInspectionSkipAdmins(req) {
      const users = await getCollection(db, 'users', 1000);
      return users.filter(row => row.Active !== false && isAdmin(row)).map(row => ({ email: text(row.Email, 320).toLowerCase(), name: text(row.Name || row.Email, 160) })).sort((a, b) => a.name.localeCompare(b.name));
    },
    async requestInspectionSkipSelected(req, [adminEmail]) {
      const selectedStation = workingStation(req.profile);
      const date = todayKey();
      const key = keyForDay(selectedStation, date);
      const ref = db.collection('inspectionSkipRequests').doc(key);
      const current = await ref.get();
      if (['Pending', 'Approved'].includes(current.get('Status'))) return { ok: true, status: current.get('Status'), message: `The approval request is already ${String(current.get('Status')).toLowerCase()}.` };
      const admins = await methods.getInspectionSkipAdmins(req);
      const selectedAdmin = admins.find(row => row.email === text(adminEmail, 320).toLowerCase());
      if (!selectedAdmin) throw apiError(400, 'ADMIN_REQUIRED', 'Select an active Admin before sending the request.');
      const data = await appData(db, req);
      const pending = data.checklist.inspectionsTotal - data.checklist.inspectionsCompleted;
      if (pending < 1) throw apiError(409, 'NO_PENDING_INSPECTIONS', 'All inspections are already completed.');
      const token = crypto.randomUUID() + crypto.randomUUID();
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
      const tokenHash = Buffer.from(digest).toString('hex');
      await ref.set({ RequestID: crypto.randomUUID(), RequestDate: date, Station: selectedStation, Status: 'Pending', PendingInspectionCount: pending, RequestedAt: FieldValue.serverTimestamp(), RequestedByUid: req.user.uid, RequestedByEmail: req.user.email || '', RequestedByName: req.profile.Name || '', RequestedAdminEmail: selectedAdmin.email, RequestedAdminName: selectedAdmin.name, TokenHash: tokenHash });
      const base = `${process.env.API_PUBLIC_URL || ''}/v1/public/inspection-skip?token=${encodeURIComponent(token)}&station=${selectedStation}&date=${date}`;
      if (!process.env.API_PUBLIC_URL) throw apiError(503, 'PUBLIC_API_URL_MISSING', 'API_PUBLIC_URL is not configured.');
      await mailer.send({ to: [selectedAdmin.email], subject: `${selectedStation} - Inspection Skip Approval Required`, html: `<div style="font-family:Arial,sans-serif"><h2>Inspection Skip Approval</h2><p>${text(req.profile.Name || req.user.email)} requested permission to skip ${pending} remaining inspections at ${selectedStation}.</p><p><a href="${base}&decision=approve">YES — APPROVE</a> &nbsp; <a href="${base}&decision=deny">NO — DENY</a></p></div>`, textBody: `Approve: ${base}&decision=approve\nDeny: ${base}&decision=deny`, idempotencyKey: `skip-${key}-${tokenHash.slice(0, 12)}` });
      return { ok: true, status: 'Pending', message: `Approval request emailed to ${selectedAdmin.name}.` };
    }
  };

  router.post('/:method', async (req, res, next) => {
    try {
      const method = text(req.params.method, 100);
      if (!Object.hasOwn(methods, method)) throw apiError(404, 'RPC_NOT_FOUND', `Unsupported application method: ${method}.`);
      const args = Array.isArray(req.body?.args) ? req.body.args : [];
      const result = await methods[method](req, args);
      res.json({ ok: true, result: serialize(result) });
    } catch (error) { next(error); }
  });
  return router;
}
