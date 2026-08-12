import crypto from 'node:crypto';
import express from 'express';
import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { createClosingNotesSender } from './closing-notes.js';
import { apiError, docData, serialize, text } from './domain.js';
import { createMailer } from './mailer.js';
import { createRpcRouter } from './rpc-router.js';
import { createSyncService } from './sync-service.js';
import { createVanInfoSync } from './van-info-sync.js';
import { captureVanSpots, repairVanInfoSpotConflicts } from './van-info-spot-repair.js';
import { allSelectableSpots, createInspectionPatchService } from './closing-inspection-patches.js';

if (!getApps().length) {
  initializeApp({
    credential: applicationDefault(),
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET || 'aaxi-closing.firebasestorage.app'
  });
}

const db = getFirestore();
const auth = getAuth();
const bucket = getStorage().bucket();
const mailer = createMailer();
const app = express();
const port = Number(process.env.PORT || 8080);
const allowedOrigins = new Set(String(process.env.ALLOWED_ORIGINS || 'https://aaxi-closing.web.app,https://aaxi-closing.firebaseapp.com,https://ernestorsp.github.io')
  .split(',').map(value => value.trim()).filter(Boolean));

app.disable('x-powered-by');
app.use(express.json({ limit: '18mb' }));
app.use((req, res, next) => {
  const origin = String(req.headers.origin || '');
  if (allowedOrigins.has(origin) || (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) && process.env.NODE_ENV !== 'production')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'authorization,content-type,x-request-id');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

async function requireAuth(req, _res, next) {
  try {
    const header = String(req.headers.authorization || '');
    if (!header.startsWith('Bearer ')) throw apiError(401, 'UNAUTHENTICATED', 'Firebase sign-in is required.');
    req.user = await auth.verifyIdToken(header.slice(7), true);
    const profile = await db.collection('users').doc(req.user.uid).get();
    if (!profile.exists || profile.get('Active') === false || profile.get('active') === false) {
      throw apiError(403, 'USER_DISABLED', 'User access is not active.');
    }
    req.profile = profile.data();
    next();
  } catch (error) { next(error); }
}

const sendClosingNotes = createClosingNotesSender({ db, bucket, mailer });
const baseSyncService = createSyncService({ db, sendClosingNotes });
const syncService = createInspectionPatchService({ db, baseSyncService });
const vanInfoSync = createVanInfoSync({ db });
let vanInfoSyncPromise = null;
let lastVanInfoSyncAt = 0;

async function runVanInfoSync({ force = false } = {}) {
  if (!force && Date.now() - lastVanInfoSyncAt < 15000) return { ok: true, skipped: true, reason: 'RECENT_SYNC' };
  if (vanInfoSyncPromise) return vanInfoSyncPromise;

  vanInfoSyncPromise = (async () => {
    const metadataRef = db.collection('syncMetadata').doc('vanInfo');
    const beforeMetadataSnap = await metadataRef.get();
    const beforeMetadata = beforeMetadataSnap.exists ? beforeMetadataSnap.data() : {};
    const beforeFirestoreSpots = await captureVanSpots(db);

    const result = await vanInfoSync.run();
    const repair = await repairVanInfoSpotConflicts({ db, beforeMetadata, beforeFirestoreSpots });

    // A repaired VAN_INFO conflict changes the displaced van in Firestore.
    // Run the existing synchronizer once more so both vans are written back to VAN_INFO.
    const followUp = repair.repaired > 0 ? await vanInfoSync.run() : null;
    lastVanInfoSyncAt = Date.now();
    return { ...result, repairedSpotSwaps: repair.repaired, followUp };
  })()
    .catch(error => {
      console.warn('[VAN_INFO sync]', error?.message || error);
      return { ok: false, error: error?.message || String(error) };
    })
    .finally(() => { vanInfoSyncPromise = null; });

  return vanInfoSyncPromise;
}

setInterval(() => { runVanInfoSync({ force: true }).catch(() => {}); }, 60000).unref();

app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'aaxi-closing-api', backend: 'firebase', time: new Date().toISOString() }));

app.post('/v1/sync/apply', requireAuth, async (req, res, next) => {
  try {
    const result = await syncService.apply(req, req.body?.operation);
    const type = text(req.body?.operation?.type || '', 80).toUpperCase();
    if (['SAVE_DAMAGE', 'FINISH_INSPECTION', 'EDIT_INSPECTION'].includes(type)) {
      runVanInfoSync({ force: true }).catch(() => {});
    }
    res.json(result);
  } catch (error) { next(error); }
});

app.get('/v1/van-note/:vanId', requireAuth, async (req, res, next) => {
  try {
    await runVanInfoSync();
    const vanId = text(req.params.vanId, 160).trim();
    if (!vanId) throw apiError(400, 'INVALID_VAN', 'Van ID is required.');
    const snapshot = await db.collection('vans').doc(vanId).get();
    if (!snapshot.exists) throw apiError(404, 'VAN_NOT_FOUND', 'Van not found.');
    const source = text(snapshot.get('CurrentNoteSource') || '', 30).toUpperCase();
    const storedNote = text(snapshot.get('CurrentNote') || snapshot.get('VanInfoReason') || '', 5000).trim();
    const explicitDamage = snapshot.get('CurrentDamageActive') === true;
    const legacyDamage = source === 'DAMAGE' && Boolean(storedNote);
    const damageActive = explicitDamage || legacyDamage;
    const note = source === 'VAN_INFO' || damageActive ? storedNote : '';
    res.json({
      ok: true,
      vanId,
      note,
      source,
      currentDamage: {
        active: damageActive,
        category: damageActive ? text(snapshot.get('CurrentDamageCategory') || '', 100) : '',
        severity: damageActive ? text(snapshot.get('CurrentDamageSeverity') || 'Medium', 30) : '',
        reason: damageActive ? storedNote : ''
      }
    });
  } catch (error) { next(error); }
});

app.patch('/v1/van-note/:vanId', requireAuth, async (req, res, next) => {
  try {
    const vanId = text(req.params.vanId, 160).trim();
    if (!vanId) throw apiError(400, 'INVALID_VAN', 'Van ID is required.');
    const ref = db.collection('vans').doc(vanId);
    const snapshot = await ref.get();
    if (!snapshot.exists) throw apiError(404, 'VAN_NOT_FOUND', 'Van not found.');
    // General Closing notes must never overwrite VAN_INFO/current van notes.
    // Only SAVE_DAMAGE and explicit No Damage cleanup are allowed to change current Damage/Note state.
    const source = text(snapshot.get('CurrentNoteSource') || '', 30).toUpperCase();
    const storedNote = text(snapshot.get('CurrentNote') || snapshot.get('VanInfoReason') || '', 5000).trim();
    res.json({ ok: true, vanId, note: source === 'VAN_INFO' || snapshot.get('CurrentDamageActive') === true ? storedNote : '', ignored: true });
  } catch (error) { next(error); }
});

app.use('/v1/rpc', async (req, _res, next) => {
  try {
    const method = text(req.path.replace(/^\//, ''), 100);
    if (['getAppData', 'startInspection', 'getInspection'].includes(method)) await runVanInfoSync();
    next();
  } catch (_error) { next(); }
});

// Occupied spots remain selectable. The actual conflict is resolved by the patched inspection transaction.
app.post('/v1/rpc/getAvailableSpots', requireAuth, async (req, res, next) => {
  try {
    const args = Array.isArray(req.body?.args) ? req.body.args : [];
    const spots = await allSelectableSpots(db, args[0]);
    res.json({ ok: true, result: serialize(spots) });
  } catch (error) { next(error); }
});

app.use('/v1/rpc', (req, res, next) => {
  const method = text(req.path.replace(/^\//, ''), 100);
  if (['finishInspection', 'saveDamageReport'].includes(method)) {
    res.on('finish', () => { runVanInfoSync({ force: true }).catch(() => {}); });
  }
  next();
});

app.use('/v1/rpc', createRpcRouter({ db, auth, bucket, mailer, requireAuth, syncService }));

app.get('/v1/public/inspection-skip', async (req, res, next) => {
  try {
    const station = text(req.query.station, 10).toUpperCase();
    const date = text(req.query.date, 20);
    const decision = text(req.query.decision, 20).toLowerCase();
    const token = text(req.query.token, 500);
    if (!['DJX3', 'DJX4'].includes(station) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !['approve', 'deny'].includes(decision) || !token) {
      throw apiError(400, 'INVALID_APPROVAL', 'This approval link is invalid.');
    }
    const ref = db.collection('inspectionSkipRequests').doc(`${date}_${station}`);
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    let status;
    await db.runTransaction(async tx => {
      const snapshot = await tx.get(ref);
      if (!snapshot.exists || snapshot.get('TokenHash') !== tokenHash) throw apiError(400, 'INVALID_APPROVAL', 'This approval link is invalid.');
      if (snapshot.get('Status') !== 'Pending') {
        status = snapshot.get('Status');
        return;
      }
      status = decision === 'approve' ? 'Approved' : 'Denied';
      tx.set(ref, { Status: status, RespondedAt: FieldValue.serverTimestamp(), RespondedByEmail: 'EMAIL_APPROVAL', RespondedByName: 'Admin email approval' }, { merge: true });
    });
    const color = status === 'Approved' ? '#16834b' : '#bd2c2c';
    res.type('html').send(`<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:Arial;background:#f4f7fa;display:grid;place-items:center;min-height:100vh"><main style="background:white;padding:32px;border-radius:18px;text-align:center"><h1 style="color:${color}">${status.toUpperCase()}</h1><p>The inspection skip request was ${status.toLowerCase()}.</p><p>You can close this page.</p></main></body></html>`);
  } catch (error) { next(error); }
});

app.use((_req, _res, next) => next(apiError(404, 'NOT_FOUND', 'Endpoint not found.')));
app.use((error, _req, res, _next) => {
  console.error('[aaxi-closing-api]', error);
  const status = Number(error.status || 500);
  res.status(status).json({
    ok: false,
    error: {
      code: error.code || 'INTERNAL',
      message: status >= 500 ? 'The server could not complete this request.' : error.message,
      details: error.details || null
    }
  });
});

app.listen(port, '0.0.0.0', () => console.log(`AAXI Closing Firebase API listening on ${port}`));
