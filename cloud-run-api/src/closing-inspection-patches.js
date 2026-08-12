import { FieldValue } from 'firebase-admin/firestore';

function clean(value, max = 5000) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function normalizeStation(value) {
  const station = clean(value, 10).toUpperCase();
  return ['DJX3', 'DJX4', 'SHOP'].includes(station) ? station : '';
}

function currentDamage(van = {}) {
  const source = clean(van.CurrentNoteSource, 30).toUpperCase();
  const note = clean(van.CurrentNote || van.VanInfoReason || '', 5000);
  const explicitActive = van.CurrentDamageActive === true;
  const legacyActive = source === 'DAMAGE' && Boolean(note);
  const active = explicitActive || legacyActive;
  return {
    active,
    category: active ? clean(van.CurrentDamageCategory || '', 100) : '',
    severity: active ? clean(van.CurrentDamageSeverity || 'Medium', 30) : '',
    reason: active ? note : '',
    source
  };
}

export async function allSelectableSpots(db, requestedStation) {
  const station = normalizeStation(requestedStation);
  if (!station || station === 'SHOP') return [];
  const snapshot = await db.collection('spots').where('Station', '==', station).limit(1000).get();
  return snapshot.docs
    .map(doc => ({ ...doc.data(), SpotID: String(doc.get('SpotID') || doc.id) }))
    .filter(row => row.Active !== false)
    .map(row => ({
      ...row,
      Station: String(row.Station || station),
      Spot: String(row.Spot || ''),
      OccupiedByVanID: String(row.OccupiedByVanID || '')
    }))
    .sort((a, b) => a.Spot.localeCompare(b.Spot, undefined, { numeric: true }));
}

async function augmentInspection(db, payload) {
  const result = payload || {};
  const inspection = result.inspection || {};
  const vanId = clean(inspection.VanID, 160);
  if (!vanId) return result;
  const vanSnap = await db.collection('vans').doc(vanId).get();
  if (!vanSnap.exists) return result;
  const van = vanSnap.data();
  const damage = currentDamage(van);
  const noteSource = clean(van.CurrentNoteSource, 30).toUpperCase();
  const currentNote = noteSource === 'VAN_INFO'
    ? clean(van.CurrentNote || van.VanInfoReason || '', 5000)
    : damage.active
      ? damage.reason
      : '';
  const patch = {
    CurrentDamageActive: damage.active,
    CurrentDamageCategory: damage.category,
    CurrentDamageSeverity: damage.severity,
    CurrentDamageReason: damage.reason,
    CurrentVanNote: currentNote,
    CurrentVanNoteSource: noteSource
  };
  result.inspection = { ...inspection, ...patch };
  result.currentDamage = damage;
  result.currentNote = currentNote;
  const selectedStation = normalizeStation(inspection.Station || van.CurrentStation);
  result.spots = await allSelectableSpots(db, selectedStation);
  return result;
}

async function persistInspectionCurrentState(db, operation, applyResult) {
  const inspection = applyResult?.result?.inspection || {};
  const inspectionId = clean(inspection.InspectionID || operation?.payload?.inspectionId, 160);
  const vanId = clean(inspection.VanID || operation?.payload?.vanId, 160);
  if (!inspectionId || !vanId) return;
  const vanSnap = await db.collection('vans').doc(vanId).get();
  if (!vanSnap.exists) return;
  const van = vanSnap.data();
  const damage = currentDamage(van);
  const noteSource = clean(van.CurrentNoteSource, 30).toUpperCase();
  const currentNote = noteSource === 'VAN_INFO'
    ? clean(van.CurrentNote || van.VanInfoReason || '', 5000)
    : damage.active
      ? damage.reason
      : '';
  await db.collection('inspections').doc(inspectionId).set({
    CurrentDamageActive: damage.active,
    CurrentDamageCategory: damage.category,
    CurrentDamageSeverity: damage.severity,
    CurrentDamageReason: damage.reason,
    CurrentVanNote: currentNote,
    CurrentVanNoteSource: noteSource,
    UpdatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
  Object.assign(applyResult.result.inspection, {
    CurrentDamageActive: damage.active,
    CurrentDamageCategory: damage.category,
    CurrentDamageSeverity: damage.severity,
    CurrentDamageReason: damage.reason,
    CurrentVanNote: currentNote,
    CurrentVanNoteSource: noteSource
  });
  applyResult.result.currentDamage = damage;
  applyResult.result.currentNote = currentNote;
  applyResult.result.spots = await allSelectableSpots(db, inspection.Station || van.CurrentStation);
}

async function markDamageCurrent(db, operation, applyResult) {
  const inspection = applyResult?.result?.inspection || {};
  const vanId = clean(inspection.VanID, 160);
  const inspectionId = clean(inspection.InspectionID || operation?.payload?.inspectionId, 160);
  if (!vanId) return;
  const payload = operation.payload || {};
  const category = clean(payload.part, 100);
  const severity = ['Low', 'Medium', 'High', 'Critical'].includes(payload.severity) ? payload.severity : 'Medium';
  const reason = clean(payload.description || payload.notes || payload.comment || payload.comments || category, 5000);
  const now = FieldValue.serverTimestamp();
  await Promise.all([
    db.collection('vans').doc(vanId).set({
      CurrentDamageActive: true,
      CurrentDamageCategory: category,
      CurrentDamageSeverity: severity,
      CurrentDamageReason: reason,
      CurrentNote: reason,
      CurrentNoteSource: 'DAMAGE',
      VanInfoDamageNotePending: true,
      DamageUpdatedAt: now,
      UpdatedAt: now
    }, { merge: true }),
    inspectionId ? db.collection('inspections').doc(inspectionId).set({
      CurrentDamageActive: true,
      CurrentDamageCategory: category,
      CurrentDamageSeverity: severity,
      CurrentDamageReason: reason,
      CurrentVanNote: reason,
      CurrentVanNoteSource: 'DAMAGE',
      UpdatedAt: now
    }, { merge: true }) : Promise.resolve()
  ]);
  if (applyResult?.result?.inspection) {
    Object.assign(applyResult.result.inspection, {
      CurrentDamageActive: true,
      CurrentDamageCategory: category,
      CurrentDamageSeverity: severity,
      CurrentDamageReason: reason,
      CurrentVanNote: reason,
      CurrentVanNoteSource: 'DAMAGE'
    });
  }
  if (applyResult?.result) {
    applyResult.result.currentDamage = { active: true, category, severity, reason, source: 'DAMAGE' };
    applyResult.result.currentNote = reason;
  }
}

async function prepareOccupiedSpot(db, operation) {
  const payload = operation?.payload || {};
  const inspectionId = clean(payload.inspectionId, 160);
  const targetSpotId = clean(payload.spotId, 160);
  if (!inspectionId || !targetSpotId) return null;
  const inspectionSnap = await db.collection('inspections').doc(inspectionId).get();
  if (!inspectionSnap.exists) return null;
  const inspection = inspectionSnap.data();
  const vanId = clean(inspection.VanID, 160);
  const vanSnap = await db.collection('vans').doc(vanId).get();
  if (!vanSnap.exists) return null;
  const van = vanSnap.data();
  const targetRef = db.collection('spots').doc(targetSpotId);
  let prepared = null;
  await db.runTransaction(async tx => {
    const target = await tx.get(targetRef);
    if (!target.exists || target.get('Active') === false) return;
    const owner = clean(target.get('OccupiedByVanID'), 160);
    if (!owner || owner === vanId) return;
    prepared = {
      targetSpotId,
      targetSpot: clean(target.get('Spot'), 100),
      targetStation: clean(target.get('Station'), 20),
      ownerVanId: owner,
      vanId,
      oldSpot: clean(van.CurrentStation === 'SHOP' ? '' : van.CurrentSpot, 100),
      oldStation: clean(van.CurrentStation, 20)
    };
    tx.set(targetRef, {
      OccupiedByVanID: '',
      ReservedByEmail: '',
      ReservationExpires: null,
      UpdatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
  });
  return prepared;
}

async function restorePreparedSpot(db, prepared) {
  if (!prepared) return;
  const ref = db.collection('spots').doc(prepared.targetSpotId);
  await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    if (!clean(snap.get('OccupiedByVanID'), 160)) {
      tx.set(ref, { OccupiedByVanID: prepared.ownerVanId, UpdatedAt: FieldValue.serverTimestamp() }, { merge: true });
    }
  }).catch(() => {});
}

async function finalizeSwap(db, prepared) {
  if (!prepared) return;
  const ownerRef = db.collection('vans').doc(prepared.ownerVanId);
  const targetRef = db.collection('spots').doc(prepared.targetSpotId);
  const spots = prepared.oldSpot && prepared.oldSpot !== 'SHOP' && prepared.oldStation === prepared.targetStation
    ? await db.collection('spots').where('Station', '==', prepared.targetStation).where('Spot', '==', prepared.oldSpot).limit(2).get()
    : null;
  const oldSpotRef = spots && !spots.empty ? spots.docs[0].ref : null;
  await db.runTransaction(async tx => {
    const reads = [tx.get(ownerRef), tx.get(targetRef)];
    if (oldSpotRef) reads.push(tx.get(oldSpotRef));
    const [ownerSnap, targetSnap, oldSpotSnap] = await Promise.all(reads);
    if (!ownerSnap.exists || !targetSnap.exists) return;
    if (clean(targetSnap.get('OccupiedByVanID'), 160) !== prepared.vanId) return;
    const now = FieldValue.serverTimestamp();
    const ownerNewSpot = oldSpotRef && oldSpotSnap?.exists ? prepared.oldSpot : '';
    tx.set(ownerRef, { CurrentSpot: ownerNewSpot, UpdatedAt: now }, { merge: true });
    if (oldSpotRef && oldSpotSnap?.exists) {
      tx.set(oldSpotRef, {
        OccupiedByVanID: prepared.ownerVanId,
        ReservedByEmail: '',
        ReservationExpires: null,
        UpdatedAt: now
      }, { merge: true });
    }
  });
}

async function ensureExistingDamageCanFinish(db, operation) {
  const payload = operation?.payload || {};
  if (clean(payload.newDamageFound, 10) !== 'Yes') return null;
  const inspectionId = clean(payload.inspectionId, 160);
  if (!inspectionId) return null;
  const inspectionSnap = await db.collection('inspections').doc(inspectionId).get();
  if (!inspectionSnap.exists) return null;
  const vanId = clean(inspectionSnap.get('VanID'), 160);
  const vanSnap = await db.collection('vans').doc(vanId).get();
  if (!vanSnap.exists) return null;
  const damage = currentDamage(vanSnap.data());
  if (!damage.active) return null;
  const existing = await db.collection('damages').where('InspectionID', '==', inspectionId).limit(100).get();
  if (existing.docs.some(doc => doc.get('Assessment') === 'New Damage')) return null;
  const id = `carried_${inspectionId}`;
  await db.collection('damages').doc(id).set({
    DamageID: id,
    InspectionID: inspectionId,
    VanID: vanId,
    VanNumber: inspectionSnap.get('VanNumber') || vanId,
    Part: damage.category || 'Other',
    Assessment: 'New Damage',
    Severity: damage.severity || 'Medium',
    Description: damage.reason,
    ResolutionStatus: 'Open',
    CarriedForward: true,
    ReportedAt: FieldValue.serverTimestamp(),
    OperationID: operation.id
  }, { merge: true });
  return id;
}

async function finishCurrentState(db, operation, applyResult, carriedDamageId) {
  const payload = operation?.payload || {};
  const inspection = applyResult?.result?.inspection || {};
  const vanId = clean(inspection.VanID, 160);
  if (!vanId) return;
  const station = normalizeStation(payload.station || inspection.Station);
  const isTransfer = clean(inspection.WorkingStation, 20) && clean(inspection.WorkingStation, 20) !== station;
  if (!isTransfer && clean(payload.newDamageFound, 10) === 'No') {
    const now = FieldValue.serverTimestamp();
    await db.collection('vans').doc(vanId).set({
      CurrentDamageActive: false,
      CurrentDamageCategory: '',
      CurrentDamageSeverity: '',
      CurrentDamageReason: '',
      CurrentNote: '',
      CurrentNoteSource: '',
      VanInfoReason: '',
      VanInfoDamageNotePending: true,
      DamageClearedAt: now,
      UpdatedAt: now
    }, { merge: true });
    await db.collection('inspections').doc(clean(inspection.InspectionID, 160)).set({
      CurrentDamageActive: false,
      CurrentDamageCategory: '',
      CurrentDamageSeverity: '',
      CurrentDamageReason: '',
      CurrentVanNote: '',
      CurrentVanNoteSource: '',
      UpdatedAt: now
    }, { merge: true });
  }
  if (carriedDamageId) {
    await db.collection('damages').doc(carriedDamageId).set({
      Assessment: 'Existing Damage',
      ConfirmedAt: FieldValue.serverTimestamp()
    }, { merge: true });
  }
  const vanSnap = await db.collection('vans').doc(vanId).get();
  if (applyResult?.result) {
    applyResult.result.van = vanSnap.exists ? { ...vanSnap.data(), _documentId: vanSnap.id } : applyResult.result.van;
  }
}

export function createInspectionPatchService({ db, baseSyncService }) {
  return {
    async apply(req, operation) {
      const type = clean(operation?.type, 80).toUpperCase();
      let preparedSpot = null;
      let carriedDamageId = null;
      if (type === 'FINISH_INSPECTION') {
        preparedSpot = await prepareOccupiedSpot(db, operation);
        carriedDamageId = await ensureExistingDamageCanFinish(db, operation);
      }
      try {
        const result = await baseSyncService.apply(req, operation);
        if (type === 'START_INSPECTION') await persistInspectionCurrentState(db, operation, result);
        if (type === 'SAVE_DAMAGE') await markDamageCurrent(db, operation, result);
        if (type === 'FINISH_INSPECTION') {
          await finalizeSwap(db, preparedSpot);
          await finishCurrentState(db, operation, result, carriedDamageId);
        }
        return result;
      } catch (error) {
        await restorePreparedSpot(db, preparedSpot);
        if (carriedDamageId) await db.collection('damages').doc(carriedDamageId).delete().catch(() => {});
        throw error;
      }
    },
    inspectionData: async (inspectionId, req, options) => {
      const result = await baseSyncService.inspectionData(inspectionId, req, options);
      return augmentInspection(db, result);
    }
  };
}
