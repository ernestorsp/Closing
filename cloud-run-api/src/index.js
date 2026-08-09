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
const syncService = createSyncService({ db, sendClosingNotes });

app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'aaxi-closing-api', backend: 'firebase', time: new Date().toISOString() }));

app.post('/v1/sync/apply', requireAuth, async (req, res, next) => {
  try {
    res.json(await syncService.apply(req, req.body?.operation));
  } catch (error) { next(error); }
});

app.get('/v1/van-note/:vanId', requireAuth, async (req, res, next) => {
  try {
    const vanId = text(req.params.vanId, 160).trim();
    if (!vanId) throw apiError(400, 'INVALID_VAN', 'Van ID is required.');
    const snapshot = await db.collection('vans').doc(vanId).get();
    if (!snapshot.exists) throw apiError(404, 'VAN_NOT_FOUND', 'Van not found.');
    res.json({ ok: true, vanId, note: text(snapshot.get('CurrentNote') || snapshot.get('VanInfoReason') || '', 5000) });
  } catch (error) { next(error); }
});

app.patch('/v1/van-note/:vanId', requireAuth, async (req, res, next) => {
  try {
    const vanId = text(req.params.vanId, 160).trim();
    if (!vanId) throw apiError(400, 'INVALID_VAN', 'Van ID is required.');
    const note = text(req.body?.note || '', 5000).trim();
    const ref = db.collection('vans').doc(vanId);
    const snapshot = await ref.get();
    if (!snapshot.exists) throw apiError(404, 'VAN_NOT_FOUND', 'Van not found.');
    await ref.set({ CurrentNote: note, VanInfoReason: note, NoteUpdatedAt: FieldValue.serverTimestamp(), NoteUpdatedByUid: req.user.uid, NoteUpdatedByEmail: req.user.email || '' }, { merge: true });
    res.json({ ok: true, vanId, note });
  } catch (error) { next(error); }
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
