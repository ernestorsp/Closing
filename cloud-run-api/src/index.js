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

function nowIso() { return new Date().toISOString(); }
function lockExpired(data, nowMs) {
  const expires = data?.expiresAt?.toMillis?.() ?? 0;
  return expires <= nowMs;
}

app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'aaxi-closing-api', time: nowIso() }));

app.post('/v1/inspection-locks/claim', requireAuth, async (req, res, next) => {
  try {
    const vanId = cleanId(req.body?.vanId, 'vanId');
    const inspectionId = cleanId(req.body?.inspectionId, 'inspectionId');
    const lockRef = db.collection('inspectionLocks').doc(vanId);
    const inspectionRef = db.collection('inspections').doc(inspectionId);
    const nowMs = Date.now();
    const result = await db.runTransaction(async tx => {
      const [lockSnap, inspectionSnap] = await Promise.all([tx.get(lockRef), tx.get(inspectionRef)]);
      if (lockSnap.exists) {
        const current = lockSnap.data();
        const owned = current.ownerUid === req.user.uid && current.inspectionId === inspectionId;
        if (!owned && !lockExpired(current, nowMs)) {
          throw httpError(409, 'VAN_LOCKED', 'This van is being inspected by another user.', {
            expiresAt: current.expiresAt?.toDate?.().toISOString?.() || null
          });
        }
      }
      const expiresAt = Timestamp.fromMillis(nowMs + LOCK_TTL_MS);
      tx.set(lockRef, {
        vanId, inspectionId, ownerUid: req.user.uid,
        ownerName: req.profile.displayName || req.user.name || req.user.email || '',
        station: req.profile.station || '', acquiredAt: FieldValue.serverTimestamp(), expiresAt
      });
      tx.set(inspectionRef, {
        inspectionId, vanId, ownerUid: req.user.uid,
        ownerName: req.profile.displayName || req.user.name || req.user.email || '',
        workingStation: req.profile.station || '', state: 'InProgress',
        startedAt: inspectionSnap.exists ? inspectionSnap.get('startedAt') : FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
      return { expiresAt: expiresAt.toDate().toISOString() };
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

app.post('/v1/inspections/finish', requireAuth, async (req, res, next) => {
  try {
    const inspectionId = cleanId(req.body?.inspectionId, 'inspectionId');
    const vanId = cleanId(req.body?.vanId, 'vanId');
    const station = cleanId(req.body?.station, 'station');
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
        return { alreadyCompleted: true, inspection: inspection.data() };
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
        completedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
        syncState: 'Pending'
      };
      tx.set(inspectionRef, completed, { merge: true });
      tx.set(vanRef, {
        vanId, currentStation: station, currentSpot: spot, currentStatus: status,
        lastInspectionId: inspectionId, lastInspectedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
      tx.delete(lockRef);
      const eventRef = db.collection('syncQueue').doc();
      tx.set(eventRef, { type: 'INSPECTION_COMPLETED', inspectionId, vanId, state: 'Pending', createdAt: FieldValue.serverTimestamp(), attempts: 0 });
      return { alreadyCompleted: false, inspection: completed };
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
    res.json({ ok: true, locks: snap.docs.map(doc => ({ id: doc.id, ...doc.data() })) });
  } catch (error) { next(error); }
});

app.use((error, _req, res, _next) => {
  console.error(error);
  const status = Number(error.status || 500);
  res.status(status).json({ ok: false, error: { code: error.code || 'INTERNAL', message: status >= 500 ? 'Internal server error.' : error.message, details: error.details } });
});

app.listen(PORT, '0.0.0.0', () => console.log(`AAXI Closing API listening on ${PORT}`));
