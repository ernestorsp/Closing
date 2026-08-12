import { FieldValue } from 'firebase-admin/firestore';

function clean(value, max = 5000) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function upper(value, max = 5000) {
  return clean(value, max).toUpperCase();
}

function normalizeSpot(value) {
  return upper(value, 100);
}

function normalizeVin(value) {
  return upper(value, 160);
}

export async function captureVanSpots(db) {
  const snapshot = await db.collection('vans').get();
  const result = {};
  snapshot.docs.forEach(doc => {
    const data = doc.data();
    const id = normalizeVin(data.VanID || doc.id);
    if (!id) return;
    result[id] = normalizeSpot(data.CurrentStation === 'SHOP' ? '' : data.CurrentSpot);
  });
  return result;
}

export async function repairVanInfoSpotConflicts({ db, beforeMetadata = {}, beforeFirestoreSpots = {} }) {
  if (!beforeMetadata.initialized) return { repaired: 0 };

  const metadataSnap = await db.collection('syncMetadata').doc('vanInfo').get();
  if (!metadataSnap.exists) return { repaired: 0 };
  const afterMetadata = metadataSnap.data() || {};

  const vansSnapshot = await db.collection('vans').get();
  const vans = vansSnapshot.docs.map(doc => ({
    ...doc.data(),
    VanID: doc.data().VanID || doc.id,
    _documentId: doc.id
  })).filter(van => van.Active !== false && van.active !== false);

  const byVin = new Map();
  const bySpot = new Map();
  vans.forEach(van => {
    const id = normalizeVin(van.VanID || van._documentId);
    if (id) byVin.set(id, van);
    const currentSpot = normalizeSpot(van.CurrentStation === 'SHOP' ? '' : van.CurrentSpot);
    if (currentSpot) {
      if (!bySpot.has(currentSpot)) bySpot.set(currentSpot, []);
      bySpot.get(currentSpot).push(van);
    }
  });

  const spotsSnapshot = await db.collection('spots').get();
  const spotRefs = new Map();
  spotsSnapshot.docs.forEach(doc => {
    if (doc.get('Active') === false) return;
    const key = `${upper(doc.get('Station'), 20)}|${normalizeSpot(doc.get('Spot'))}`;
    if (!spotRefs.has(key)) spotRefs.set(key, doc.ref);
  });

  let repaired = 0;
  const handled = new Set();

  for (const [id, van] of byVin.entries()) {
    if (handled.has(id)) continue;
    const priorFire = normalizeSpot(beforeMetadata.firestore?.[id]?.spot || '');
    const priorSheet = normalizeSpot(beforeMetadata.sheet?.[id]?.spot || '');
    const fireBeforeSync = normalizeSpot(beforeFirestoreSpots[id] || '');
    const afterSheet = normalizeSpot(afterMetadata.sheet?.[id]?.spot || '');

    const appChangedBeforeSync = fireBeforeSync !== priorFire;
    const sheetChanged = afterSheet !== priorSheet;
    if (!sheetChanged || appChangedBeforeSync || !afterSheet || afterSheet === 'SHOP') continue;

    const owners = (bySpot.get(afterSheet) || []).filter(other => normalizeVin(other.VanID || other._documentId) !== id);
    if (!owners.length) continue;
    const owner = owners[0];
    const ownerId = normalizeVin(owner.VanID || owner._documentId);
    if (!ownerId || handled.has(ownerId)) continue;

    const oldSpot = priorFire && priorFire !== 'SHOP' ? priorFire : '';
    const selectedStation = upper(van.CurrentStation, 20);
    const ownerStation = upper(owner.CurrentStation, 20);
    const targetSpotRef = spotRefs.get(`${selectedStation}|${afterSheet}`) || null;
    const oldSpotRef = oldSpot && selectedStation === ownerStation
      ? spotRefs.get(`${selectedStation}|${oldSpot}`) || null
      : null;

    const vanRef = db.collection('vans').doc(van._documentId || van.VanID);
    const ownerRef = db.collection('vans').doc(owner._documentId || owner.VanID);

    await db.runTransaction(async tx => {
      const reads = [tx.get(vanRef), tx.get(ownerRef)];
      if (targetSpotRef) reads.push(tx.get(targetSpotRef));
      if (oldSpotRef) reads.push(tx.get(oldSpotRef));
      const snapshots = await Promise.all(reads);
      if (!snapshots[0].exists || !snapshots[1].exists) return;

      const now = FieldValue.serverTimestamp();
      tx.set(vanRef, { CurrentSpot: afterSheet, UpdatedAt: now, VanInfoSyncedAt: now }, { merge: true });
      tx.set(ownerRef, { CurrentSpot: oldSpot, UpdatedAt: now, VanInfoSyncedAt: now }, { merge: true });

      if (targetSpotRef) {
        tx.set(targetSpotRef, {
          OccupiedByVanID: String(van.VanID || van._documentId),
          ReservedByEmail: '',
          ReservationExpires: null,
          UpdatedAt: now
        }, { merge: true });
      }
      if (oldSpotRef) {
        tx.set(oldSpotRef, {
          OccupiedByVanID: String(owner.VanID || owner._documentId),
          ReservedByEmail: '',
          ReservationExpires: null,
          UpdatedAt: now
        }, { merge: true });
      }
    });

    handled.add(id);
    handled.add(ownerId);
    repaired++;
  }

  return { repaired };
}
