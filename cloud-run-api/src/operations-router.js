import express from 'express';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';

function cleanText(value, max = 2000) {
  return String(value ?? '').trim().slice(0, max);
}

function cleanStation(value) {
  const station = cleanText(value, 10).toUpperCase();
  if (!['DJX3', 'DJX4', 'SHOP'].includes(station)) {
    const error = new Error('Station must be DJX3, DJX4 or SHOP.');
    error.status = 400;
    error.code = 'INVALID_STATION';
    throw error;
  }
  return station;
}

function cleanDateKey(value) {
  const raw = cleanText(value, 20);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const error = new Error('Date must use YYYY-MM-DD.');
    error.status = 400;
    error.code = 'INVALID_DATE';
    throw error;
  }
  return raw;
}

function serialize(value) {
  if (value == null) return value;
  if (typeof value?.toDate === 'function') return value.toDate().toISOString();
  if (Array.isArray(value)) return value.map(serialize);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, serialize(child)]));
  }
  return value;
}

function docData(doc) {
  return { id: doc.id, ...serialize(doc.data()) };
}

function assertAdmin(req) {
  if (req.profile?.role !== 'admin') {
    const error = new Error('Administrator access required.');
    error.status = 403;
    error.code = 'ADMIN_REQUIRED';
    throw error;
  }
}

function assertStationAccess(req, station) {
  if (req.profile?.role === 'admin') return;
  const access = Array.isArray(req.profile?.stationAccess)
    ? req.profile.stationAccess
    : [req.profile?.station].filter(Boolean);
  if (!access.includes(station)) {
    const error = new Error('You do not have access to this station.');
    error.status = 403;
    error.code = 'STATION_ACCESS_DENIED';
    throw error;
  }
}

export function createOperationsRouter({ db, requireAuth }) {
  const router = express.Router();

  router.use(requireAuth);

  router.get('/dashboard', async (req, res, next) => {
    try {
      const station = cleanStation(req.query.station || req.profile.station || 'DJX3');
      const date = cleanDateKey(req.query.date || new Date().toISOString().slice(0, 10));
      assertStationAccess(req, station);
      const key = `${date}_${station}`;
      const [rescues, closing, notes, avatar] = await Promise.all([
        db.collection('rescueDays').doc(key).get(),
        db.collection('closingDays').doc(key).get(),
        db.collection('closingNotes').doc(key).get(),
        db.collection('avatarMessages')
          .where('active', '==', true)
          .where('audience', 'in', ['ALL', station])
          .orderBy('createdAt', 'desc')
          .limit(10)
          .get()
      ]);
      res.json({
        ok: true,
        station,
        date,
        rescues: rescues.exists ? docData(rescues) : null,
        closing: closing.exists ? docData(closing) : null,
        notes: notes.exists ? docData(notes) : null,
        avatarMessages: avatar.docs.map(docData)
      });
    } catch (error) { next(error); }
  });

  router.get('/rescues', async (req, res, next) => {
    try {
      const station = cleanStation(req.query.station || req.profile.station || 'DJX3');
      const date = cleanDateKey(req.query.date || new Date().toISOString().slice(0, 10));
      assertStationAccess(req, station);
      const ref = db.collection('rescueDays').doc(`${date}_${station}`);
      const snap = await ref.get();
      res.json({ ok: true, rescueDay: snap.exists ? docData(snap) : null });
    } catch (error) { next(error); }
  });

  router.put('/rescues', async (req, res, next) => {
    try {
      const station = cleanStation(req.body?.station || req.profile.station || 'DJX3');
      const date = cleanDateKey(req.body?.date || new Date().toISOString().slice(0, 10));
      assertStationAccess(req, station);
      const rescueDrivers = Array.isArray(req.body?.rescueDrivers) ? req.body.rescueDrivers : [];
      const rescues = Array.isArray(req.body?.rescues) ? req.body.rescues : [];
      const normalized = rescues.slice(0, 250).map((item, index) => ({
        id: cleanText(item.id || `rescue_${index + 1}`, 120),
        driver: cleanText(item.driver, 160),
        stops: Math.max(0, Number(item.stops || 0)),
        packages: Math.max(0, Number(item.packages || 0)),
        affects: item.affects === true || String(item.affects).toLowerCase() === 'yes',
        notes: cleanText(item.notes, 1500)
      }));
      const data = {
        date,
        station,
        rescueDrivers: rescueDrivers.slice(0, 50).map(x => cleanText(x, 160)).filter(Boolean),
        rescues: normalized,
        state: 'Ready',
        savedByUid: req.user.uid,
        savedByName: req.profile.displayName || req.user.email || '',
        savedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      };
      const ref = db.collection('rescueDays').doc(`${date}_${station}`);
      await ref.set(data, { merge: true });
      res.json({ ok: true, rescueDay: { id: ref.id, ...serialize(data) } });
    } catch (error) { next(error); }
  });

  router.get('/closing', async (req, res, next) => {
    try {
      const station = cleanStation(req.query.station || req.profile.station || 'DJX3');
      const date = cleanDateKey(req.query.date || new Date().toISOString().slice(0, 10));
      assertStationAccess(req, station);
      const snap = await db.collection('closingDays').doc(`${date}_${station}`).get();
      res.json({ ok: true, closingDay: snap.exists ? docData(snap) : null });
    } catch (error) { next(error); }
  });

  router.put('/closing', async (req, res, next) => {
    try {
      const station = cleanStation(req.body?.station || req.profile.station || 'DJX3');
      const date = cleanDateKey(req.body?.date || new Date().toISOString().slice(0, 10));
      assertStationAccess(req, station);
      const number = value => Math.max(0, Number(value || 0));
      const data = {
        date,
        station,
        routesForTomorrow: number(req.body?.routesForTomorrow),
        pickupComplete: req.body?.pickupComplete === true,
        pickupComment: cleanText(req.body?.pickupComment, 1500),
        phones: number(req.body?.phones),
        batteryPacks: number(req.body?.batteryPacks),
        driversWithReceipts: number(req.body?.driversWithReceipts),
        returnedPackages: number(req.body?.returnedPackages),
        lateRtsDrivers: Array.isArray(req.body?.lateRtsDrivers)
          ? req.body.lateRtsDrivers.slice(0, 100).map(x => cleanText(x, 160)).filter(Boolean)
          : [],
        dvicDrivers: Array.isArray(req.body?.dvicDrivers)
          ? req.body.dvicDrivers.slice(0, 100).map(x => cleanText(x, 160)).filter(Boolean)
          : [],
        state: 'Ready',
        savedByUid: req.user.uid,
        savedByName: req.profile.displayName || req.user.email || '',
        savedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      };
      const ref = db.collection('closingDays').doc(`${date}_${station}`);
      await ref.set(data, { merge: true });
      res.json({ ok: true, closingDay: { id: ref.id, ...serialize(data) } });
    } catch (error) { next(error); }
  });

  router.get('/history', async (req, res, next) => {
    try {
      const vanId = cleanText(req.query.vanId, 120);
      if (!vanId) {
        const error = new Error('vanId is required.');
        error.status = 400;
        error.code = 'VAN_ID_REQUIRED';
        throw error;
      }
      const limit = Math.min(50, Math.max(1, Number(req.query.limit || 10)));
      const snap = await db.collection('inspections')
        .where('vanId', '==', vanId)
        .where('state', '==', 'Completed')
        .orderBy('completedAt', 'desc')
        .limit(limit)
        .get();
      res.json({ ok: true, inspections: snap.docs.map(docData) });
    } catch (error) { next(error); }
  });

  router.get('/avatar/messages', async (req, res, next) => {
    try {
      const station = cleanStation(req.query.station || req.profile.station || 'DJX3');
      assertStationAccess(req, station);
      const snap = await db.collection('avatarMessages')
        .where('active', '==', true)
        .where('audience', 'in', ['ALL', station])
        .orderBy('createdAt', 'desc')
        .limit(25)
        .get();
      res.json({ ok: true, messages: snap.docs.map(docData) });
    } catch (error) { next(error); }
  });

  router.post('/avatar/messages', async (req, res, next) => {
    try {
      assertAdmin(req);
      const audience = cleanText(req.body?.audience || 'ALL', 10).toUpperCase();
      if (!['ALL', 'DJX3', 'DJX4'].includes(audience)) {
        const error = new Error('Audience must be ALL, DJX3 or DJX4.');
        error.status = 400;
        error.code = 'INVALID_AUDIENCE';
        throw error;
      }
      const text = cleanText(req.body?.message, 1200);
      if (!text) {
        const error = new Error('Message is required.');
        error.status = 400;
        error.code = 'MESSAGE_REQUIRED';
        throw error;
      }
      const ref = db.collection('avatarMessages').doc();
      const data = {
        audience,
        message: text,
        active: true,
        createdByUid: req.user.uid,
        createdByName: req.profile.displayName || req.user.email || '',
        createdAt: FieldValue.serverTimestamp(),
        acceptedByUid: '',
        acceptedByName: '',
        acceptedAt: null
      };
      await ref.set(data);
      res.status(201).json({ ok: true, message: { id: ref.id, ...serialize(data) } });
    } catch (error) { next(error); }
  });

  router.post('/avatar/messages/:messageId/accept', async (req, res, next) => {
    try {
      const id = cleanText(req.params.messageId, 120);
      const ref = db.collection('avatarMessages').doc(id);
      await db.runTransaction(async tx => {
        const snap = await tx.get(ref);
        if (!snap.exists) {
          const error = new Error('Message was not found.');
          error.status = 404;
          error.code = 'MESSAGE_NOT_FOUND';
          throw error;
        }
        if (snap.get('active') === false) return;
        tx.update(ref, {
          active: false,
          acceptedByUid: req.user.uid,
          acceptedByName: req.profile.displayName || req.user.email || '',
          acceptedAt: FieldValue.serverTimestamp()
        });
      });
      res.json({ ok: true });
    } catch (error) { next(error); }
  });

  router.get('/admin/users', async (req, res, next) => {
    try {
      assertAdmin(req);
      const snap = await db.collection('users').orderBy('displayName', 'asc').limit(500).get();
      res.json({ ok: true, users: snap.docs.map(docData) });
    } catch (error) { next(error); }
  });

  router.patch('/admin/users/:uid', async (req, res, next) => {
    try {
      assertAdmin(req);
      const uid = cleanText(req.params.uid, 128);
      const role = ['admin', 'lead'].includes(req.body?.role) ? req.body.role : 'lead';
      const station = cleanStation(req.body?.station || 'DJX3');
      const stationAccess = Array.isArray(req.body?.stationAccess)
        ? req.body.stationAccess.map(cleanStation)
        : [station];
      const data = {
        displayName: cleanText(req.body?.displayName, 160),
        role,
        station,
        stationAccess: [...new Set(stationAccess)],
        active: req.body?.active !== false,
        updatedByUid: req.user.uid,
        updatedAt: FieldValue.serverTimestamp()
      };
      await db.collection('users').doc(uid).set(data, { merge: true });
      res.json({ ok: true, user: { id: uid, ...serialize(data) } });
    } catch (error) { next(error); }
  });

  router.delete('/admin/users/:uid', async (req, res, next) => {
    try {
      assertAdmin(req);
      const uid = cleanText(req.params.uid, 128);
      if (uid === req.user.uid) {
        const error = new Error('You cannot remove your own administrator account.');
        error.status = 409;
        error.code = 'CANNOT_REMOVE_SELF';
        throw error;
      }
      await db.collection('users').doc(uid).set({
        active: false,
        removedAt: FieldValue.serverTimestamp(),
        removedByUid: req.user.uid
      }, { merge: true });
      res.json({ ok: true });
    } catch (error) { next(error); }
  });

  router.get('/notes', async (req, res, next) => {
    try {
      const station = cleanStation(req.query.station || req.profile.station || 'DJX3');
      const date = cleanDateKey(req.query.date || new Date().toISOString().slice(0, 10));
      assertStationAccess(req, station);
      const snap = await db.collection('closingNotes').doc(`${date}_${station}`).get();
      res.json({ ok: true, note: snap.exists ? docData(snap) : null });
    } catch (error) { next(error); }
  });

  router.put('/notes', async (req, res, next) => {
    try {
      const station = cleanStation(req.body?.station || req.profile.station || 'DJX3');
      const date = cleanDateKey(req.body?.date || new Date().toISOString().slice(0, 10));
      assertStationAccess(req, station);
      const data = {
        date,
        station,
        notes: cleanText(req.body?.notes, 10000),
        photoPaths: Array.isArray(req.body?.photoPaths)
          ? req.body.photoPaths.slice(0, 6).map(x => cleanText(x, 500)).filter(Boolean)
          : [],
        state: cleanText(req.body?.state || 'Draft', 30),
        savedByUid: req.user.uid,
        savedByName: req.profile.displayName || req.user.email || '',
        updatedAt: FieldValue.serverTimestamp()
      };
      const ref = db.collection('closingNotes').doc(`${date}_${station}`);
      await ref.set(data, { merge: true });
      res.json({ ok: true, note: { id: ref.id, ...serialize(data) } });
    } catch (error) { next(error); }
  });

  router.get('/audit', async (req, res, next) => {
    try {
      assertAdmin(req);
      const since = req.query.since ? new Date(String(req.query.since)) : new Date(Date.now() - 7 * 86400000);
      const snap = await db.collection('audit')
        .where('createdAt', '>=', Timestamp.fromDate(since))
        .orderBy('createdAt', 'desc')
        .limit(500)
        .get();
      res.json({ ok: true, events: snap.docs.map(docData) });
    } catch (error) { next(error); }
  });

  return router;
}
