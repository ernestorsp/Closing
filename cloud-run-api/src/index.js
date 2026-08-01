import express from 'express';
import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore';

if (!getApps().length) initializeApp({ credential: applicationDefault() });
const db = getFirestore();
const auth = getAuth();
const app = express();
const PORT = Number(process.env.PORT || 8080);
const LOCK_TTL_MS = Number(process.env.INSPECTION_LOCK_TTL_MS || 5 * 60 * 1000);
const ALLOWED_ORIGINS = String(process.env.ALLOWED_ORIGINS || 'https://ernestorsp.github.io')
  .split(',').map(x => x.trim()).filter(Boolean);

app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'authorization,content-type,x-request-id');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

function httpError(status, code, message, details = undefined) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  error.details = details;
  return error;
}

async function requireAuth(req, _res, next) {
  try {
    const header = String(req.headers.authorization || '');
    if (!header.startsWith('Bearer ')) throw httpError(401, 'UNAUTHENTICATED', 'Missing Firebase ID token.');
    const token = header.slice(7);
    req.user = await auth.verifyIdToken(token, true);
    const profile = await db.collection('users').doc(req.user.uid).get();
    if (!profile.exists || profile.get('active') === false) throw httpError(403, 'USER_DISABLED', 'User is not active.');
    req.profile = profile.data();
    next();
  } catch (error) { next(error); }
}

function requireAdmin(req, _res, next) {
  if (req.profile?.role !== 'admin') return next(httpError(403, 'ADMIN_REQUIRED', 'Administrator access required.'));
  next();
}

function cleanId(value, field) {
  const id = String(value || '').trim();
  if (!id || id.length > 120 || id.includes('/')) throw httpError(400, 'INVALID_ARGUMENT', `Invalid ${field}.`);
  return id;
}

function cleanStation(value) {
  const station = cleanId(value, 'station').toUpperCase();
  if (!['DJX3', 'DJX4', 'SHOP'].includes(station)) throw httpError(400, 'INVALID_STATION', 'Station must be DJX3, DJX4 or SHOP.');
  return station;
}

function nowIso() { return new Date().toISOString(); }
function lockExpired(data, nowMs) {
  const expires = data?.expiresAt?.toMillis?.() ?? 0;
  return expires <= nowMs;
}
function serialize(value) {
  if (value == null) return value;
  if (typeof value?.toDate === 'function') return value.toDate().toISOString();
  if (Array.isArray(value)) return value.map(serialize);
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, serialize(child)]));
  return value;
}
function docData(doc) { return { id: doc.id, ...serialize(doc.data()) }; }

app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'aaxi-closing-api', time: nowIso() }));

app.get('/v1/bootstrap', requireAuth, async (req, res, next) => {
  try {
    const station = cleanStation(req.query.station || req.profile.station || 'DJX3');
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const [vansSnap, spotsSnap, locksSnap, completedSnap, inProgressSnap] = await Promise.all([
      db.collection('vans').where('currentStation', 'in', station === 'SHOP' ? ['SHOP'] : [station, 'SHOP']).limit(500).get(),
      station === 'SHOP' ? Promise.resolve(null) : db.collection('spots').where('station', '==', station).limit(500).get(),
      db.collection('inspectionLocks').limit(500).get(),
      db.collection('inspections').where('station', '==', station).where('completedAt', '>=', Timestamp.fromDate(today)).orderBy('completedAt', 'desc').limit(250).get(),
      db.collection('inspections').where('ownerUid', '==', req.user.uid).where('state', '==', 'InProgress').limit(25).get()
    ]);
    const liveLocks = locksSnap.docs.filter(doc => !lockExpired(doc.data(), Date.now())).map(docData);
    res.json({
      ok: true,
      user: { uid: req.user.uid, email: req.user.email || '', ...serialize(req.profile) },
      station,
      vans: vansSnap.docs.map(docData),
      spots: spotsSnap ? spotsSnap.docs.map(docData) : [],
      locks: liveLocks,
      completedToday: completedSnap.docs.map(docData),
      inProgress: inProgressSnap.docs.map(docData),
      serverTime: nowIso()
    });
  } catch (error) { next(error); }
});

app.get('/v1/spots', requireAuth, async (req, res, next) => {
  try {
    const station = cleanStation(req.query.station || req.profile.station || 'DJX3');
    if (station === 'SHOP') return res.json({ ok: true, station, spots: [] });
    const vanId = String(req.query.vanId || '').trim();
    const snap = await db.collection('spots').where('station', '==', station).limit(500).get();
    const spots = snap.docs.map(docData).filter(spot => !spot.vanId || String(spot.vanId) === vanId);
    spots.sort((a, b) => String(a.spot || a.id).localeCompare(String(b.spot || b.id), undefined, { numeric: true }));
    res.json({ ok: true, station, spots });
  } catch (error) { next(error); }
});

app.get('/v1/inspections/:inspectionId', requireAuth, async (req, res, next) => {
  try {
    const inspectionId = cleanId(req.params.inspectionId, 'inspectionId');
    const inspectionRef = db.collection('inspections').doc(inspectionId);
    const [inspection, photos, damages] = await Promise.all([
      inspectionRef.get(),
      inspectionRef.collection('photos').orderBy('createdAt', 'asc').limit(50).get(),
      inspectionRef.collection('damages').orderBy('createdAt', 'asc').limit(50).get()
    ]);
    if (!inspection.exists) throw httpError(404, 'INSPECTION_NOT_FOUND', 'Inspection was not found.');
    res.json({ ok: true, inspection: docData(inspection), photos: photos.docs.map(docData), damages: damages.docs.map(docData) });
  } catch (error) { next(error); }
});

app.post('/v1/inspection-locks/claim', requireAuth, async (req, res, next) => {
  try {
    const vanId = cleanId(req.body?.vanId, 'vanId');
    const inspectionId = cleanId(req.body?.inspectionId, 'inspectionId');
    const lockRef = db.collection('inspectionLocks').doc(vanId);
    const inspectionRef = db.collection('inspections').doc(inspectionId);
    const vanRef = db.collection('vans').doc(vanId);
    const nowMs = Date.now();
    const result = await db.runTransaction(async tx => {
      const [lockSnap, inspectionSnap, vanSnap] = await Promise.all([tx.get(lockRef), tx.get(inspectionRef), tx.get(vanRef)]);
      if (!vanSnap.exists) throw httpError(404, 'VAN_NOT_FOUND', 'Van was not found.');
      if (lockSnap.exists) {
        const current = lockSnap.data();
        const owned = current.ownerUid === req.user.uid && current.inspectionId === inspectionId;
        if (!owned && !lockExpired(current, nowMs)) {
          throw httpError(409, 'VAN_LOCKED', 'This van is being inspected by another user.', {
            ownerName: current.ownerName || '', expiresAt: current.expiresAt?.toDate?.().toISOString?.() || null
          });
        }
      }
      const expiresAt = Timestamp.fromMillis(nowMs + LOCK_TTL_MS);
      const van = vanSnap.data();
      tx.set(lockRef, {
        vanId, inspectionId, ownerUid: req.user.uid,
        ownerName: req.profile.displayName || req.user.name || req.user.email || '',
        station: req.profile.station || '', acquiredAt: FieldValue.serverTimestamp(), expiresAt
      });
      tx.set(inspectionRef, {
        inspectionId, vanId, vanNumber: van.vanNumber || '', ownerUid: req.user.uid,
        ownerName: req.profile.displayName || req.user.name || req.user.email || '',
        workingStation: req.profile.station || '', station: van.currentStation || req.profile.station || '',
        spot: van.currentSpot || '', previousStation: van.currentStation || '', previousSpot: van.currentSpot || '',
        previousStatus: van.currentStatus || 'Operational', status: van.currentStatus || 'Operational', state: 'InProgress',
        startedAt: inspectionSnap.exists ? inspectionSnap.get('startedAt') : FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
      return { expiresAt: expiresAt.toDate().toISOString(), van: serialize(van) };
    });
    res.status(200).json({ ok: true, vanId, inspectionId, ...result });
  } catch (error) { next(error); }
});

app.post('/v1/inspection-locks/renew', requireAuth, async (req, res, next) => {
  try {
    const vanId = cleanId(req.body?.vanId, 'vanId');
    const inspectionId = cleanId(req.body?.inspectionId, 'inspectionId');
    const ref = db.collection('inspectionLocks').doc(vanId);
    const expiresAt = Timestamp.fromMillis(Date.now() + LOCK_TTL_MS);
    await db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      if (!snap.exists || snap.get('ownerUid') !== req.user.uid || snap.get('inspectionId') !== inspectionId) {
        throw httpError(409, 'LOCK_NOT_OWNED', 'Inspection lock is no longer owned by this user.');
      }
      tx.update(ref, { expiresAt, renewedAt: FieldValue.serverTimestamp() });
    });
    res.json({ ok: true, expiresAt: expiresAt.toDate().toISOString() });
  } catch (error) { next(error); }
});

app.post('/v1/inspections/:inspectionId/photos', requireAuth, async (req, res, next) => {
  try {
    const inspectionId = cleanId(req.params.inspectionId, 'inspectionId');
    const photoId = cleanId(req.body?.photoId || req.body?.part || crypto.randomUUID(), 'photoId');
    const inspectionRef = db.collection('inspections').doc(inspectionId);
    const inspection = await inspectionRef.get();
    if (!inspection.exists) throw httpError(404, 'INSPECTION_NOT_FOUND', 'Inspection was not found.');
    if (inspection.get('ownerUid') !== req.user.uid && req.profile.role !== 'admin') throw httpError(403, 'INSPECTION_NOT_OWNED', 'Cannot attach a photo to another user’s inspection.');
    const storagePath = String(req.body?.storagePath || '').trim();
    if (!storagePath.startsWith(`inspection-photos/${inspectionId}/`)) throw httpError(400, 'INVALID_STORAGE_PATH', 'Photo path does not belong to this inspection.');
    const data = {
      photoId,
      part: String(req.body?.part || '').slice(0, 80),
      assessment: String(req.body?.assessment || '').slice(0, 80),
      notes: String(req.body?.notes || '').slice(0, 1000),
      storagePath,
      contentType: String(req.body?.contentType || 'image/jpeg').slice(0, 100),
      size: Math.max(0, Number(req.body?.size || 0)),
      uploadedByUid: req.user.uid,
      uploadedByName: req.profile.displayName || req.user.name || req.user.email || '',
      createdAt: FieldValue.serverTimestamp()
    };
    await inspectionRef.collection('photos').doc(photoId).set(data, { merge: true });
    res.status(201).json({ ok: true, photo: { ...serialize(data), id: photoId } });
  } catch (error) { next(error); }
});

app.post('/v1/inspections/:inspectionId/damages', requireAuth, async (req, res, next) => {
  try {
    const inspectionId = cleanId(req.params.inspectionId, 'inspectionId');
    const damageId = cleanId(req.body?.damageId || crypto.randomUUID(), 'damageId');
    const inspectionRef = db.collection('inspections').doc(inspectionId);
    const inspection = await inspectionRef.get();
    if (!inspection.exists) throw httpError(404, 'INSPECTION_NOT_FOUND', 'Inspection was not found.');
    if (inspection.get('ownerUid') !== req.user.uid && req.profile.role !== 'admin') throw httpError(403, 'INSPECTION_NOT_OWNED', 'Cannot report damage on another user’s inspection.');
    const storagePath = String(req.body?.storagePath || '').trim();
    if (storagePath && !storagePath.startsWith(`inspection-photos/${inspectionId}/`)) throw httpError(400, 'INVALID_STORAGE_PATH', 'Damage photo path does not belong to this inspection.');
    const data = {
      damageId,
      part: String(req.body?.part || 'Other').slice(0, 100),
      severity: ['Low', 'Medium', 'High', 'Critical'].includes(req.body?.severity) ? req.body.severity : 'Low',
      notes: String(req.body?.notes || '').slice(0, 2000),
      storagePath,
      reportedByUid: req.user.uid,
      reportedByName: req.profile.displayName || req.user.name || req.user.email || '',
      createdAt: FieldValue.serverTimestamp()
    };
    await inspectionRef.collection('damages').doc(damageId).set(data, { merge: true });
    res.status(201).json({ ok: true, damage: { ...serialize(data), id: damageId } });
  } catch (error) { next(error); }
});

app.post('/v1/inspections/finish', requireAuth, async (req, res, next) => {
  try {
    const inspectionId = cleanId(req.body?.inspectionId, 'inspectionId');
    const vanId = cleanId(req.body?.vanId, 'vanId');
    const station = cleanStation(req.body?.station);
    const spot = station === 'SHOP' ? '' : cleanId(req.body?.spot, 'spot');
    const status = ['Operational', 'Downed', 'Grounded'].includes(req.body?.status) ? req.body.status : 'Operational';
    const lockRef = db.collection('inspectionLocks').doc(vanId);
    const inspectionRef = db.collection('inspections').doc(inspectionId);
    const vanRef = db.collection('vans').doc(vanId);
    const newSpotRef = spot ? db.collection('spots').doc(`${station}_${spot}`) : null;

    const result = await db.runTransaction(async tx => {
      const refs = [lockRef, inspectionRef, vanRef];
      if (newSpotRef) refs.push(newSpotRef);
      const snaps = await Promise.all(refs.map(ref => tx.get(ref)));
      const lock = snaps[0];
      const inspection = snaps[1];
      const van = snaps[2];
      const newSpotSnap = newSpotRef ? snaps[3] : null;
      if (!lock.exists || lock.get('ownerUid') !== req.user.uid || lock.get('inspectionId') !== inspectionId || lockExpired(lock.data(), Date.now())) {
        throw httpError(409, 'LOCK_EXPIRED', 'Inspection lock expired. Reopen the van and try again.');
      }
      if (inspection.exists && inspection.get('state') === 'Completed') {
        return { alreadyCompleted: true, inspection: serialize(inspection.data()), van: van.exists ? serialize(van.data()) : null };
      }
      const previousStation = van.exists ? String(van.get('currentStation') || '') : '';
      const previousSpot = van.exists ? String(van.get('currentSpot') || '') : '';
      const oldSpotRef = previousStation && previousSpot ? db.collection('spots').doc(`${previousStation}_${previousSpot}`) : null;
      if (oldSpotRef && (!newSpotRef || oldSpotRef.path !== newSpotRef.path)) {
        const oldSpotSnap = await tx.get(oldSpotRef);
        if (oldSpotSnap.exists && oldSpotSnap.get('vanId') === vanId) {
          tx.set(oldSpotRef, { vanId: null, inspectionId: null, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        }
      }
      if (newSpotRef) {
        const assignedVanId = newSpotSnap?.exists ? String(newSpotSnap.get('vanId') || '') : '';
        if (assignedVanId && assignedVanId !== vanId) {
          const displacedVanRef = db.collection('vans').doc(assignedVanId);
          tx.set(displacedVanRef, { currentSpot: '', updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        }
        tx.set(newSpotRef, { station, spot, vanId, inspectionId, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      }
      const completed = {
        inspectionId, vanId, station, spot, status,
        notes: String(req.body?.notes || '').slice(0, 5000),
        damageFound: req.body?.damageFound === true,
        state: 'Completed', completedByUid: req.user.uid,
        completedByName: req.profile.displayName || req.user.name || req.user.email || '',
        completedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), syncState: 'Pending'
      };
      const updatedVan = {
        vanId, currentStation: station, currentSpot: spot, currentStatus: status,
        lastInspectionId: inspectionId, lastInspectedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp()
      };
      tx.set(inspectionRef, completed, { merge: true });
      tx.set(vanRef, updatedVan, { merge: true });
      tx.delete(lockRef);
      const eventRef = db.collection('syncQueue').doc();
      tx.set(eventRef, { type: 'INSPECTION_COMPLETED', inspectionId, vanId, state: 'Pending', createdAt: FieldValue.serverTimestamp(), attempts: 0 });
      return { alreadyCompleted: false, inspection: serialize(completed), van: serialize(updatedVan) };
    });
    res.json({ ok: true, ...result });
  } catch (error) { next(error); }
});

app.delete('/v1/inspection-locks/:vanId', requireAuth, async (req, res, next) => {
  try {
    const vanId = cleanId(req.params.vanId, 'vanId');
    const ref = db.collection('inspectionLocks').doc(vanId);
    await db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      if (snap.get('ownerUid') !== req.user.uid && req.profile.role !== 'admin') throw httpError(403, 'LOCK_NOT_OWNED', 'Cannot release another user’s lock.');
      tx.delete(ref);
    });
    res.status(204).end();
  } catch (error) { next(error); }
});

app.get('/v1/admin/locks', requireAuth, requireAdmin, async (_req, res, next) => {
  try {
    const snap = await db.collection('inspectionLocks').limit(250).get();
    res.json({ ok: true, locks: snap.docs.map(docData) });
  } catch (error) { next(error); }
});

app.use((error, _req, res, _next) => {
  console.error(error);
  const status = Number(error.status || 500);
  res.status(status).json({ ok: false, error: { code: error.code || 'INTERNAL', message: status >= 500 ? 'Internal server error.' : error.message, details: error.details } });
});

app.listen(PORT, '0.0.0.0', () => console.log(`AAXI Closing API listening on ${PORT}`));
