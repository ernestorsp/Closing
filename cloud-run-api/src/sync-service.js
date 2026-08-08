import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import {
  DEFECTS,
  PHOTO_PARTS,
  STATUSES,
  STATIONS,
  WORK_STATIONS,
  apiError,
  assertStationAccess,
  changedFields,
  dateKey,
  identifier,
  integer,
  isAdmin,
  sameMoment,
  serialize,
  station,
  storagePath,
  text,
  todayKey,
  vanHomeStation,
  workingStation
} from './domain.js';
import { actorFromRequest, auditWrite, docData, getCollection, getWhere, keyForDay } from './firestore-helpers.js';

const OPERATION_TYPES = [
  'START_INSPECTION',
  'SAVE_INSPECTION_PHOTO',
  'SAVE_DAMAGE',
  'FINISH_INSPECTION',
  'SAVE_CLOSING',
  'SAVE_RESCUES',
  'SEND_NOTES',
  'EDIT_INSPECTION'
];
const PROCESSING_TIMEOUT_MS = 4 * 60 * 1000;
const LOCK_TTL_MS = Number(process.env.INSPECTION_LOCK_TTL_MS || 30 * 60 * 1000);

function scrub(value) {
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined).map(([key, child]) => [key, scrub(child)]));
  }
  return value;
}

function sortNewest(left, right) {
  return new Date(right.CompletedAt || right.UpdatedAt || right.StartedAt || 0) - new Date(left.CompletedAt || left.UpdatedAt || left.StartedAt || 0);
}

function canEditInspection(req, inspection) {
  if (isAdmin(req.profile)) return true;
  const access = assertStationAccess.bind(null, req.profile);
  try {
    access(inspection.WorkingStation || inspection.Station);
  } catch (_error) {
    return false;
  }
  return String(inspection.InspectionDate || '').slice(0, 10) === todayKey();
}

function assertInspectionOwner(req, inspection, { completedAllowed = false } = {}) {
  if (!inspection) throw apiError(404, 'INSPECTION_NOT_FOUND', 'Inspection not found.');
  if (inspection.InspectionState === 'Completed') {
    if (!completedAllowed || !canEditInspection(req, inspection)) {
      throw apiError(403, 'INSPECTION_NOT_EDITABLE', 'Permission required to edit this inspection.');
    }
    return;
  }
  if (text(inspection.UserUid || '').trim()) {
    if (inspection.UserUid !== req.user.uid) throw apiError(409, 'INSPECTION_OWNED', 'Inspection belongs to another user.');
  } else if (text(inspection.UserEmail).toLowerCase() !== text(req.user.email).toLowerCase()) {
    throw apiError(409, 'INSPECTION_OWNED', 'Inspection belongs to another user.');
  }
  if (!['In Progress', 'Cancelled'].includes(inspection.InspectionState)) {
    throw apiError(409, 'INSPECTION_NOT_EDITABLE', 'Inspection is no longer editable.');
  }
}

async function inspectionData(db, inspectionId, req, { editable = true } = {}) {
  const ref = db.collection('inspections').doc(inspectionId);
  const [inspectionSnap, photos, damages] = await Promise.all([
    ref.get(),
    getWhere(db, 'photos', 'InspectionID', '==', inspectionId, 100),
    getWhere(db, 'damages', 'InspectionID', '==', inspectionId, 100)
  ]);
  const inspection = docData(inspectionSnap);
  if (editable) assertInspectionOwner(req, inspection, { completedAllowed: true });
  if (!inspection) throw apiError(404, 'INSPECTION_NOT_FOUND', 'Inspection not found.');
  const history = await getWhere(db, 'inspections', 'VanID', '==', inspection.VanID, 100);
  const last = history.filter(row => row.InspectionState === 'Completed' && row.InspectionID !== inspectionId).sort(sortNewest)[0] || null;
  let spots = [];
  if (inspection.Station !== 'SHOP' && inspection.Station === inspection.WorkingStation) {
    spots = await availableSpots(db, inspection.Station, inspection.VanID, req.user.email);
  }
  return {
    inspection,
    lastInspection: last ? { CompletedAt: last.CompletedAt, UserName: last.UserName, UserEmail: last.UserEmail } : null,
    photos: photos.filter(row => PHOTO_PARTS.includes(row.Part)),
    damages,
    spots,
    requiredParts: PHOTO_PARTS,
    statuses: STATUSES
  };
}

export async function availableSpots(db, requestedStation, vanId = '', email = '') {
  const selected = station(requestedStation);
  if (selected === 'SHOP') return [];
  const [spots, todaysInspections] = await Promise.all([
    getWhere(db, 'spots', 'Station', '==', selected, 500),
    getWhere(db, 'inspections', 'InspectionDate', '==', todayKey(), 1500)
  ]);
  const completedVanIds = new Set(todaysInspections.filter(row => row.InspectionState === 'Completed').map(row => String(row.VanID)));
  const now = Date.now();
  return spots.filter(row => {
    if (row.Active === false) return false;
    const occupied = String(row.OccupiedByVanID || '');
    const reservedUntil = new Date(row.ReservationExpires || 0).getTime();
    const reservedByOther = row.ReservedByEmail && text(row.ReservedByEmail).toLowerCase() !== text(email).toLowerCase() && reservedUntil > now;
    return (!occupied || occupied === String(vanId) || !completedVanIds.has(occupied)) && !reservedByOther;
  }).map(row => ({
    ...row,
    SpotID: String(row.SpotID || row._documentId),
    Station: String(row.Station),
    Spot: String(row.Spot),
    OccupiedByVanID: String(row.OccupiedByVanID || '')
  })).sort((a, b) => a.Spot.localeCompare(b.Spot, undefined, { numeric: true }));
}

async function startInspection({ db, req, operation, payload, actor }) {
  const inspectionId = identifier(payload.inspectionId || operation.id, 'inspectionId');
  const vanId = identifier(payload.vanId, 'vanId');
  const workStation = assertStationAccess(req.profile, operation.station || payload.station || workingStation(req.profile));
  const inspectionRef = db.collection('inspections').doc(inspectionId);
  const vanRef = db.collection('vans').doc(vanId);
  const lockRef = db.collection('inspectionLocks').doc(vanId);
  const expiresAt = Timestamp.fromMillis(Date.now() + LOCK_TTL_MS);
  let clientInspectionId = '';
  await db.runTransaction(async tx => {
    const [inspectionSnap, vanSnap, lockSnap] = await Promise.all([tx.get(inspectionRef), tx.get(vanRef), tx.get(lockRef)]);
    if (!vanSnap.exists || vanSnap.get('Active') === false) throw apiError(404, 'VAN_NOT_FOUND', 'Van not found.');
    if (inspectionSnap.exists) {
      const current = inspectionSnap.data();
      assertInspectionOwner(req, current, { completedAllowed: true });
      if (current.InspectionState === 'Cancelled') {
        tx.set(inspectionRef, { InspectionState: 'In Progress', StartedAt: FieldValue.serverTimestamp(), UpdatedAt: FieldValue.serverTimestamp() }, { merge: true });
      }
    }
    if (lockSnap.exists) {
      const lock = lockSnap.data();
      const live = lock.ExpiresAt?.toMillis?.() > Date.now();
      if (live && lock.OwnerUid !== req.user.uid) {
        throw apiError(409, 'VAN_LOCKED', 'This van is being inspected by another user.');
      }
      if (live && lock.OwnerUid === req.user.uid && lock.InspectionID !== inspectionId) clientInspectionId = lock.InspectionID;
    }
    const actualId = clientInspectionId || inspectionId;
    const actualRef = db.collection('inspections').doc(actualId);
    const van = vanSnap.data();
    const currentStation = text(van.CurrentStation || workStation, 10).toUpperCase();
    const currentSpot = currentStation === 'SHOP' ? 'SHOP' : text(van.CurrentSpot, 40);
    tx.set(lockRef, {
      VanID: vanId,
      InspectionID: actualId,
      OwnerUid: req.user.uid,
      OwnerEmail: actor.email,
      OwnerName: actor.name,
      ExpiresAt: expiresAt,
      UpdatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    tx.set(actualRef, {
      InspectionID: actualId,
      InspectionDate: dateKey(operation.day),
      StartedAt: FieldValue.serverTimestamp(),
      UserUid: req.user.uid,
      UserEmail: actor.email,
      UserName: actor.name,
      WorkingStation: workStation,
      VanID: vanId,
      VanNumber: van.VanNumber || vanId,
      PreviousStation: currentStation,
      Station: currentStation,
      PreviousSpot: currentSpot,
      Spot: currentSpot,
      PreviousStatus: van.CurrentStatus || 'Operational',
      Status: van.CurrentStatus || 'Operational',
      LocationChanged: false,
      PhotoProgress: '0/6',
      InspectionState: 'In Progress',
      UpdatedAt: FieldValue.serverTimestamp(),
      Version: Number(inspectionSnap.get('Version') || 0) || 1,
      LastOperationID: operation.id
    }, { merge: true });
  });
  await auditWrite(db, actor, 'START_INSPECTION_LOCAL_FIRST', 'INSPECTION', clientInspectionId || inspectionId, `Van ${vanId}`);
  const result = await inspectionData(db, clientInspectionId || inspectionId, req);
  if (clientInspectionId) result.clientInspectionId = inspectionId;
  return result;
}

async function saveInspectionPhoto({ db, req, operation, payload, actor }) {
  const inspectionId = identifier(payload.inspectionId, 'inspectionId');
  const part = text(payload.part, 80);
  if (!PHOTO_PARTS.includes(part)) throw apiError(400, 'INVALID_PHOTO_PART', 'Invalid photo position.');
  const path = storagePath(payload.storagePath, `inspection-photos/${inspectionId}/`);
  const inspectionRef = db.collection('inspections').doc(inspectionId);
  const photoId = `photo_${inspectionId}_${part.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`.slice(0, 160);
  const photoRef = db.collection('photos').doc(photoId);
  await db.runTransaction(async tx => {
    const [inspectionSnap, photoSnap] = await Promise.all([tx.get(inspectionRef), tx.get(photoRef)]);
    const inspection = docData(inspectionSnap);
    assertInspectionOwner(req, inspection, { completedAllowed: true });
    tx.set(photoRef, {
      PhotoID: photoId,
      InspectionID: inspectionId,
      VanID: inspection.VanID,
      VanNumber: inspection.VanNumber,
      Part: part,
      StoragePath: path,
      ContentType: text(payload.contentType || 'image/jpeg', 100),
      Size: Math.max(0, Number(payload.size || 0)),
      CapturedAt: FieldValue.serverTimestamp(),
      CapturedBy: actor.email,
      CapturedByUid: actor.uid,
      PreviousPhotoID: photoSnap.exists ? photoSnap.get('PreviousPhotoID') || '' : '',
      DamageAssessment: 'No Damage',
      DamageNotes: '',
      OperationID: operation.id
    }, { merge: true });
    tx.set(inspectionRef, { LastOperationID: operation.id, UpdatedAt: FieldValue.serverTimestamp() }, { merge: true });
  });
  const photos = await getWhere(db, 'photos', 'InspectionID', '==', inspectionId, 100);
  await inspectionRef.set({ PhotoProgress: `${new Set(photos.filter(row => PHOTO_PARTS.includes(row.Part)).map(row => row.Part)).size}/6` }, { merge: true });
  await auditWrite(db, actor, 'SAVE_PHOTO', 'INSPECTION', inspectionId, part);
  return inspectionData(db, inspectionId, req);
}

async function saveDamage({ db, req, operation, payload, actor }) {
  const inspectionId = identifier(payload.inspectionId, 'inspectionId');
  const part = text(payload.part, 100);
  if (!DEFECTS.includes(part)) throw apiError(400, 'INVALID_DAMAGE_PART', 'Select the van defect or affected part.');
  const path = storagePath(payload.storagePath, `inspection-photos/${inspectionId}/`);
  const inspectionRef = db.collection('inspections').doc(inspectionId);
  const damageId = `damage_${operation.id}`;
  const photoId = `damage_photo_${operation.id}`;
  const damageRef = db.collection('damages').doc(damageId);
  const photoRef = db.collection('photos').doc(photoId);
  await db.runTransaction(async tx => {
    const inspectionSnap = await tx.get(inspectionRef);
    const inspection = docData(inspectionSnap);
    assertInspectionOwner(req, inspection, { completedAllowed: true });
    tx.set(photoRef, {
      PhotoID: photoId,
      InspectionID: inspectionId,
      VanID: inspection.VanID,
      VanNumber: inspection.VanNumber,
      Part: `Damage - ${part}`,
      StoragePath: path,
      ContentType: text(payload.contentType || 'image/jpeg', 100),
      Size: Math.max(0, Number(payload.size || 0)),
      CapturedAt: FieldValue.serverTimestamp(),
      CapturedBy: actor.email,
      CapturedByUid: actor.uid,
      DamageAssessment: 'New Damage',
      DamageNotes: part,
      OperationID: operation.id
    }, { merge: true });
    tx.set(damageRef, {
      DamageID: damageId,
      InspectionID: inspectionId,
      VanID: inspection.VanID,
      VanNumber: inspection.VanNumber,
      Part: part,
      Assessment: 'New Damage',
      Severity: ['Low', 'Medium', 'High', 'Critical'].includes(payload.severity) ? payload.severity : 'Medium',
      Description: '',
      PhotoID: photoId,
      ReportedAt: FieldValue.serverTimestamp(),
      ReportedBy: actor.email,
      ReportedByUid: actor.uid,
      ResolutionStatus: 'Open',
      OperationID: operation.id
    }, { merge: true });
    tx.set(inspectionRef, { NewDamageFound: 'Yes', LastOperationID: operation.id, UpdatedAt: FieldValue.serverTimestamp() }, { merge: true });
  });
  await auditWrite(db, actor, 'REPORT_DAMAGE', 'INSPECTION', inspectionId, part);
  return inspectionData(db, inspectionId, req);
}

async function finishInspection({ db, req, operation, payload, actor }) {
  const inspectionId = identifier(payload.inspectionId, 'inspectionId');
  const inspectionRef = db.collection('inspections').doc(inspectionId);
  const firstInspection = await inspectionRef.get();
  if (!firstInspection.exists) throw apiError(404, 'INSPECTION_NOT_FOUND', 'Inspection not found.');
  const initial = firstInspection.data();
  assertInspectionOwner(req, initial, { completedAllowed: true });
  if (initial.InspectionState === 'Completed') {
    const van = await db.collection('vans').doc(initial.VanID).get();
    return { ok: true, alreadyCompleted: true, message: 'Inspection completed.', inspection: docData(firstInspection), van: docData(van) };
  }
  const vanId = identifier(initial.VanID, 'vanId');
  const selectedStation = station(payload.station || initial.Station);
  const transfer = text(initial.WorkingStation, 10) !== selectedStation;
  const atShop = selectedStation === 'SHOP';
  const spotId = !transfer && !atShop ? identifier(payload.spotId, 'spotId') : '';
  const vanRef = db.collection('vans').doc(vanId);
  const lockRef = db.collection('inspectionLocks').doc(vanId);
  const targetSpotRef = spotId ? db.collection('spots').doc(spotId) : null;
  const occupiedQuery = db.collection('spots').where('OccupiedByVanID', '==', vanId).limit(10);
  const completedQuery = db.collection('inspections').where('InspectionDate', '==', todayKey()).limit(1500);
  const damagesQuery = db.collection('damages').where('InspectionID', '==', inspectionId).limit(100);
  await db.runTransaction(async tx => {
    const [inspectionSnap, vanSnap, lockSnap, occupiedSnap, targetSpotSnap, completedSnap, damagesSnap] = await Promise.all([
      tx.get(inspectionRef),
      tx.get(vanRef),
      tx.get(lockRef),
      tx.get(occupiedQuery),
      targetSpotRef ? tx.get(targetSpotRef) : Promise.resolve(null),
      tx.get(completedQuery),
      tx.get(damagesQuery)
    ]);
    const inspection = docData(inspectionSnap);
    assertInspectionOwner(req, inspection, { completedAllowed: true });
    if (inspection.InspectionState === 'Completed') return;
    if (lockSnap.exists) {
      const lock = lockSnap.data();
      const live = lock.ExpiresAt?.toMillis?.() > Date.now();
      if (live && lock.OwnerUid !== req.user.uid) throw apiError(409, 'VAN_LOCKED', 'This van is being inspected by another user.');
    }
    let spot = '';
    if (targetSpotRef) {
      if (!targetSpotSnap?.exists || targetSpotSnap.get('Active') === false || targetSpotSnap.get('Station') !== selectedStation) {
        throw apiError(400, 'INVALID_SPOT', 'Select an available spot.');
      }
      const owner = text(targetSpotSnap.get('OccupiedByVanID'));
      if (owner && owner !== vanId) {
        const completedOwners = new Set(completedSnap.docs.filter(doc => doc.get('InspectionState') === 'Completed').map(doc => String(doc.get('VanID'))));
        if (completedOwners.has(owner)) throw apiError(409, 'SPOT_CONFLICT', `Spot ${targetSpotSnap.get('Spot')} is occupied by another van.`);
        tx.set(db.collection('vans').doc(owner), { CurrentSpot: '', UpdatedAt: FieldValue.serverTimestamp() }, { merge: true });
      }
      spot = text(targetSpotSnap.get('Spot'), 40);
    }
    const status = atShop ? 'Grounded' : transfer ? (inspection.Status || inspection.PreviousStatus || 'Operational') : text(payload.status, 30);
    if (!STATUSES.includes(status)) throw apiError(400, 'INVALID_STATUS', 'Select a valid van status.');
    const damageAnswer = text(payload.newDamageFound, 10);
    if (!transfer && !['Yes', 'No'].includes(damageAnswer)) throw apiError(400, 'DAMAGE_ANSWER_REQUIRED', 'Answer whether new damage was found.');
    if (!transfer && damageAnswer === 'Yes' && !damagesSnap.docs.some(doc => doc.get('Assessment') === 'New Damage')) {
      throw apiError(400, 'DAMAGE_PHOTO_REQUIRED', 'Add the new defect and close-up photo.');
    }
    const finalSpot = atShop ? 'SHOP' : spot;
    const notes = transfer
      ? `Moved from ${inspection.PreviousStation || inspection.WorkingStation || 'unknown'} to ${selectedStation}.`
      : text(payload.notes, 5000);
    const now = FieldValue.serverTimestamp();
    occupiedSnap.docs.forEach(doc => tx.set(doc.ref, { OccupiedByVanID: '', ReservedByEmail: '', ReservationExpires: null, UpdatedAt: now }, { merge: true }));
    if (targetSpotRef) tx.set(targetSpotRef, { OccupiedByVanID: vanId, ReservedByEmail: '', ReservationExpires: null, UpdatedAt: now }, { merge: true });
    tx.set(inspectionRef, {
      Station: selectedStation,
      Spot: finalSpot,
      CompletedAt: now,
      Status: status,
      Notes: atShop ? (notes ? `${notes} · At SHOP.` : 'At SHOP.') : notes,
      NewDamageFound: transfer ? inspection.NewDamageFound || '' : damageAnswer,
      InspectionState: 'Completed',
      LocationChanged: text(inspection.PreviousStation) !== selectedStation,
      UpdatedAt: now,
      Version: Number(inspection.Version || 0) + 1,
      LastOperationID: operation.id
    }, { merge: true });
    const van = vanSnap.exists ? vanSnap.data() : {};
    tx.set(vanRef, {
      VanID: vanId,
      HomeStation: WORK_STATIONS.includes(selectedStation) ? selectedStation : vanHomeStation(van),
      CurrentStation: selectedStation,
      CurrentSpot: finalSpot,
      CurrentStatus: status,
      LastInspectionAt: now,
      LastInspectionID: inspectionId,
      UpdatedAt: now
    }, { merge: true });
    tx.delete(lockRef);
  });
  await auditWrite(db, actor, transfer ? 'TRANSFER_VAN' : 'FINISH_INSPECTION', 'INSPECTION', inspectionId, selectedStation);
  const [inspection, van] = await Promise.all([inspectionRef.get(), vanRef.get()]);
  return { ok: true, message: transfer ? `Van moved to ${selectedStation}.` : 'Inspection completed.', inspection: docData(inspection), van: docData(van) };
}

async function resolveDrivers(db, ids) {
  const unique = [...new Set((ids || []).map(value => text(value, 160)).filter(Boolean))];
  const snapshots = await Promise.all(unique.map(id => db.collection('rescueDrivers').doc(id).get()));
  const map = new Map();
  snapshots.forEach((snapshot, index) => {
    if (snapshot.exists && snapshot.get('Active') !== false) map.set(unique[index], docData(snapshot));
  });
  return map;
}

async function saveClosing({ db, req, operation, payload, actor }) {
  const selectedStation = assertStationAccess(req.profile, operation.station || workingStation(req.profile));
  const date = dateKey(payload.date || operation.day);
  const key = keyForDay(selectedStation, date);
  const ref = db.collection('closingDays').doc(key);
  const lateIds = [...new Set((payload.lateDriverIds || []).map(value => text(value, 160)).filter(Boolean))];
  const dvicIds = [...new Set((payload.dvicDriverIds || []).map(value => text(value, 160)).filter(Boolean))];
  const drivers = await resolveDrivers(db, [...lateIds, ...dvicIds]);
  if (drivers.size !== new Set([...lateIds, ...dvicIds]).size) throw apiError(409, 'DRIVER_CHANGED', 'A selected driver is no longer available.');
  const vansQuery = db.collection('vans').where('HomeStation', '==', selectedStation).limit(1500);
  let record;
  await db.runTransaction(async tx => {
    const [existingSnap, vansSnap] = await Promise.all([tx.get(ref), tx.get(vansQuery)]);
    const existing = docData(existingSnap);
    const expected = payload.expectedUpdatedAt || payload.expectedSavedAt || '';
    const actual = existing?.UpdatedAt || existing?.SavedAt;
    const sameEditor = existing && text(existing.SavedByEmail).toLowerCase() === actor.email.toLowerCase();
    if (existing && (!expected || !sameMoment(expected, actual)) && !sameEditor) {
      throw apiError(409, 'CLOSING_CONFLICT', 'Closing was changed by another user. Synchronize and review the newer version.');
    }
    const counts = { Operational: 0, Downed: 0, Grounded: 0 };
    vansSnap.docs.filter(doc => doc.get('Active') !== false).forEach(doc => {
      const status = doc.get('CurrentStation') === 'SHOP' ? 'Grounded' : (doc.get('CurrentStatus') || 'Operational');
      if (Object.hasOwn(counts, status)) counts[status] += 1;
    });
    const pickup = text(payload.pickupAll, 10);
    if (!['Yes', 'No'].includes(pickup)) throw apiError(400, 'INVALID_PICKUP', 'Select whether all pickups were collected.');
    record = {
      RecordKey: key,
      RecordID: existing?.RecordID || crypto.randomUUID(),
      RecordDate: date,
      Station: selectedStation,
      OperationalVans: counts.Operational,
      DownedVans: counts.Downed,
      GroundedVans: counts.Grounded,
      RoutesTomorrow: integer(payload.routesTomorrow, 1, 100, 'Routes for Tomorrow'),
      PickupAll: pickup,
      PickupComment: pickup === 'No' ? text(payload.pickupComment, 1500) : '',
      Phones: integer(payload.phones, 1, 100, 'Phones'),
      BatteryPacks: integer(payload.batteryPacks, 1, 100, 'Battery Packs'),
      DriversWithReceipts: selectedStation === 'DJX4' ? '' : integer(payload.driversWithReceipts, 1, 25, 'Drivers with Receipts'),
      ReturnedPackages: integer(payload.returnedPackages, 0, 99999, 'Returned Packages'),
      LateRTSDriverIDs: lateIds.join(' | '),
      LateRTSDrivers: lateIds.map(id => drivers.get(id).Driver).join(' | '),
      DVICDriverIDs: dvicIds.join(' | '),
      DVICDrivers: dvicIds.map(id => drivers.get(id).Driver).join(' | '),
      SavedAt: FieldValue.serverTimestamp(),
      SavedByEmail: actor.email,
      SavedByName: actor.name,
      SavedByUid: actor.uid,
      Version: Number(existing?.Version || 0) + 1,
      UpdatedAt: FieldValue.serverTimestamp(),
      LastOperationID: operation.id
    };
    tx.set(ref, record);
  });
  const saved = docData(await ref.get());
  await auditWrite(db, actor, saved.Version > 1 ? 'EDIT_DAILY_CLOSING' : 'SAVE_DAILY_CLOSING', 'CLOSING', key, changedFields({}, saved, Object.keys(record)));
  return { ok: true, record: saved, vanCounts: { Operational: saved.OperationalVans, Downed: saved.DownedVans, Grounded: saved.GroundedVans }, message: `Closing synchronized for ${selectedStation}.` };
}

async function saveRescues({ db, req, operation, payload, actor }) {
  const selectedStation = assertStationAccess(req.profile, operation.station || workingStation(req.profile));
  const date = dateKey(operation.day);
  const key = keyForDay(selectedStation, date);
  const ref = db.collection('rescueDays').doc(key);
  const dailyInput = Array.isArray(payload.dailyDrivers) ? payload.dailyDrivers : [];
  const rescueInput = Array.isArray(payload.rescues) ? payload.rescues : [];
  if (dailyInput.length > 100 || rescueInput.length > 300) throw apiError(400, 'TOO_MANY_RESCUES', 'Too many rescues in one save.');
  const driverIds = [
    ...dailyInput.map(item => item.driverId),
    ...rescueInput.flatMap(item => [item.rescuerDriverId, item.recipientDriverId])
  ];
  const drivers = await resolveDrivers(db, driverIds);
  const requireDriver = (id, message) => {
    const driver = drivers.get(text(id, 160));
    if (!driver) throw apiError(409, 'DRIVER_CHANGED', message);
    return driver;
  };
  const daily = [...new Map(dailyInput.map(item => {
    const driver = requireDriver(item.driverId, 'A selected rescue driver is no longer available.');
    return [String(driver.DriverID), {
      AssignmentID: `assignment_${date.replaceAll('-', '')}_${selectedStation}_${driver.DriverID}`,
      AssignmentDate: date,
      UserEmail: actor.email,
      UserName: actor.name,
      Station: selectedStation,
      DriverID: driver.DriverID,
      Driver: driver.Driver,
      Deleted: false
    }];
  })).values()];
  const dailyIds = new Set(daily.map(row => String(row.DriverID)));
  const rescues = rescueInput.map((item, index) => {
    const rescuer = requireDriver(item.rescuerDriverId, `Rescue ${index + 1}: select a valid rescue driver.`);
    const recipient = requireDriver(item.recipientDriverId, `Rescue ${index + 1}: select the driver who received it.`);
    if (!dailyIds.has(String(rescuer.DriverID))) throw apiError(400, 'INVALID_RESCUER', `Rescue ${index + 1}: select a valid rescue driver.`);
    const affects = text(item.affects, 10);
    if (!['Yes', 'No'].includes(affects)) throw apiError(400, 'INVALID_AFFECTS', `Rescue ${index + 1}: select Affects.`);
    return {
      RescueID: identifier(item.rescueId || `rescue_${operation.id}_${index}`, 'rescueId'),
      RescueDate: date,
      CreatedAt: new Date().toISOString(),
      UpdatedAt: new Date().toISOString(),
      UserEmail: actor.email,
      UserName: actor.name,
      Station: selectedStation,
      RescuerDriverID: rescuer.DriverID,
      RescuerDriver: rescuer.Driver,
      RecipientDriverID: recipient.DriverID,
      RecipientDriver: recipient.Driver,
      Stops: integer(item.stops, 1, 9999, `Rescue ${index + 1}: Stops`),
      Packages: integer(item.packages, 1, 99999, `Rescue ${index + 1}: Packages`),
      Affects: affects,
      Notes: text(item.notes, 1500),
      Deleted: false,
      Status: 'Saved',
      SavedAt: new Date().toISOString()
    };
  });
  let version;
  await db.runTransaction(async tx => {
    const snapshot = await tx.get(ref);
    const currentVersion = Number(snapshot.get('Version') || 0);
    const expectedVersion = Number(payload.expectedVersion || 0);
    if (currentVersion !== expectedVersion) throw apiError(409, 'RESCUE_CONFLICT', 'Rescue was changed by another user. Synchronize and review the newer version.');
    version = currentVersion + 1;
    tx.set(ref, {
      RecordKey: key,
      Date: date,
      Station: selectedStation,
      DailyDrivers: daily,
      Rescues: rescues,
      Finalized: true,
      Version: version,
      SavedAt: FieldValue.serverTimestamp(),
      UpdatedAt: FieldValue.serverTimestamp(),
      SavedByEmail: actor.email,
      SavedByName: actor.name,
      SavedByUid: actor.uid,
      LastOperationID: operation.id
    });
  });
  await auditWrite(db, actor, version > 1 ? 'EDIT_DAILY_RESCUES' : 'FINALIZE_DAILY_RESCUES', 'RESCUE', selectedStation, { date, count: rescues.length, version });
  return { ok: true, count: rescues.length, version, message: rescues.length ? `${rescues.length} rescues synchronized.` : `No rescues today. ${selectedStation} was closed successfully.` };
}

async function editInspection({ db, req, operation, payload, actor }) {
  const inspectionId = identifier(payload.inspectionId, 'inspectionId');
  const inspectionRef = db.collection('inspections').doc(inspectionId);
  const initialSnap = await inspectionRef.get();
  const initial = docData(initialSnap);
  if (!initial || initial.InspectionState !== 'Completed') throw apiError(404, 'INSPECTION_NOT_FOUND', 'Completed inspection not found.');
  if (!canEditInspection(req, initial)) throw apiError(403, 'INSPECTION_NOT_EDITABLE', 'Permission required to edit this inspection.');
  const selectedStation = station(payload.station || initial.Station);
  const atShop = selectedStation === 'SHOP';
  const status = atShop ? 'Grounded' : text(payload.status, 30);
  if (!STATUSES.includes(status)) throw apiError(400, 'INVALID_STATUS', 'Select a valid van status.');
  const spotId = atShop ? '' : identifier(payload.spotId, 'spotId');
  const spotRef = spotId ? db.collection('spots').doc(spotId) : null;
  const vanRef = db.collection('vans').doc(initial.VanID);
  const occupiedQuery = db.collection('spots').where('OccupiedByVanID', '==', initial.VanID).limit(10);
  const completedQuery = db.collection('inspections').where('InspectionDate', '==', todayKey()).limit(1500);
  const damagesQuery = db.collection('damages').where('InspectionID', '==', inspectionId).limit(100);
  let changes;
  await db.runTransaction(async tx => {
    const [inspectionSnap, vanSnap, occupiedSnap, spotSnap, completedSnap, damagesSnap] = await Promise.all([
      tx.get(inspectionRef), tx.get(vanRef), tx.get(occupiedQuery), spotRef ? tx.get(spotRef) : Promise.resolve(null), tx.get(completedQuery), tx.get(damagesQuery)
    ]);
    const inspection = docData(inspectionSnap);
    if (!inspection || inspection.InspectionState !== 'Completed') throw apiError(404, 'INSPECTION_NOT_FOUND', 'Completed inspection not found.');
    if (!canEditInspection(req, inspection)) throw apiError(403, 'INSPECTION_NOT_EDITABLE', 'Permission required to edit this inspection.');
    const expectedVersion = Number(payload.expectedVersion || 0);
    const currentVersion = Number(inspection.Version || 0);
    const timestampCurrent = payload.expectedUpdatedAt && sameMoment(payload.expectedUpdatedAt, inspection.UpdatedAt || inspection.EditedAt || inspection.CompletedAt);
    const stale = expectedVersion ? expectedVersion !== currentVersion : !timestampCurrent;
    const sameEditor = text(inspection.EditedByEmail).toLowerCase() === actor.email.toLowerCase();
    if (stale && inspection.EditedByEmail && !sameEditor) throw apiError(409, 'INSPECTION_CONFLICT', 'This inspection has a newer version. Synchronize before saving your changes.');
    let spot = 'SHOP';
    if (spotRef) {
      if (!spotSnap?.exists || spotSnap.get('Active') === false || spotSnap.get('Station') !== selectedStation) throw apiError(400, 'INVALID_SPOT', 'Select an available spot.');
      const owner = text(spotSnap.get('OccupiedByVanID'));
      if (owner && owner !== inspection.VanID) {
        const completedOwners = new Set(completedSnap.docs.filter(doc => doc.get('InspectionState') === 'Completed').map(doc => String(doc.get('VanID'))));
        if (completedOwners.has(owner)) throw apiError(409, 'SPOT_CONFLICT', `Spot ${spotSnap.get('Spot')} is occupied by another van.`);
        tx.set(db.collection('vans').doc(owner), { CurrentSpot: '', UpdatedAt: FieldValue.serverTimestamp() }, { merge: true });
      }
      spot = text(spotSnap.get('Spot'), 40);
    }
    const hasDamage = text(inspection.NewDamageFound) === 'Yes' || damagesSnap.docs.some(doc => doc.get('Assessment') === 'New Damage');
    const damageAnswer = hasDamage ? 'Yes' : text(payload.newDamageFound, 10);
    if (!['Yes', 'No'].includes(damageAnswer)) throw apiError(400, 'DAMAGE_ANSWER_REQUIRED', 'Select whether new damage was found.');
    const after = { Station: selectedStation, Spot: spot, Status: status, Notes: text(payload.notes, 5000), NewDamageFound: damageAnswer };
    changes = changedFields(inspection, after, Object.keys(after));
    const now = FieldValue.serverTimestamp();
    occupiedSnap.docs.forEach(doc => tx.set(doc.ref, { OccupiedByVanID: '', UpdatedAt: now }, { merge: true }));
    if (spotRef) tx.set(spotRef, { OccupiedByVanID: inspection.VanID, ReservedByEmail: '', ReservationExpires: null, UpdatedAt: now }, { merge: true });
    tx.set(inspectionRef, { ...after, UpdatedAt: now, EditedAt: now, EditedByEmail: actor.email, EditedByUid: actor.uid, Version: currentVersion + 1, LastOperationID: operation.id }, { merge: true });
    const van = vanSnap.exists ? vanSnap.data() : {};
    if (!van.LastInspectionID || van.LastInspectionID === inspectionId) {
      tx.set(vanRef, {
        HomeStation: WORK_STATIONS.includes(selectedStation) ? selectedStation : vanHomeStation(van),
        CurrentStation: selectedStation,
        CurrentSpot: spot,
        CurrentStatus: status,
        UpdatedAt: now
      }, { merge: true });
    }
  });
  await auditWrite(db, actor, 'EDIT_COMPLETED_INSPECTION', 'INSPECTION', inspectionId, changes);
  const [inspection, van] = await Promise.all([inspectionRef.get(), vanRef.get()]);
  return { ok: true, inspection: docData(inspection), van: docData(van), changes, message: 'Inspection changes synchronized.' };
}

export function createSyncService({ db, sendClosingNotes }) {
  const handlers = {
    START_INSPECTION: startInspection,
    SAVE_INSPECTION_PHOTO: saveInspectionPhoto,
    SAVE_DAMAGE: saveDamage,
    FINISH_INSPECTION: finishInspection,
    SAVE_CLOSING: saveClosing,
    SAVE_RESCUES: saveRescues,
    SEND_NOTES: sendClosingNotes,
    EDIT_INSPECTION: editInspection
  };

  return {
    async apply(req, rawOperation) {
      const operation = rawOperation || {};
      operation.id = identifier(operation.id, 'operation ID');
      operation.type = text(operation.type, 80).toUpperCase();
      operation.day = dateKey(operation.day || todayKey());
      operation.station = assertStationAccess(req.profile, operation.station || workingStation(req.profile));
      operation.payload = operation.payload || {};
      if (!OPERATION_TYPES.includes(operation.type)) throw apiError(400, 'UNSUPPORTED_OPERATION', 'Unsupported synchronization operation.');
      const ref = db.collection('syncOperations').doc(operation.id);
      const actor = actorFromRequest(req);
      let duplicateResult = null;
      await db.runTransaction(async tx => {
        const snapshot = await tx.get(ref);
        if (snapshot.exists && snapshot.get('Status') === 'synced') {
          duplicateResult = serialize(snapshot.get('Result') || {});
          return;
        }
        const updatedAt = snapshot.exists ? snapshot.get('UpdatedAt')?.toMillis?.() || 0 : 0;
        if (snapshot.exists && snapshot.get('Status') === 'syncing' && Date.now() - updatedAt < PROCESSING_TIMEOUT_MS) {
          throw apiError(409, 'SYNC_BUSY', 'Operation is already syncing.');
        }
        tx.set(ref, {
          OperationID: operation.id,
          Type: operation.type,
          Status: 'syncing',
          Day: operation.day,
          Station: operation.station,
          EntityID: text(operation.entityId, 160),
          UserUid: req.user.uid,
          UserEmail: actor.email,
          Attempts: Number(snapshot.get('Attempts') || 0) + 1,
          CreatedAt: snapshot.exists ? snapshot.get('CreatedAt') || FieldValue.serverTimestamp() : FieldValue.serverTimestamp(),
          UpdatedAt: FieldValue.serverTimestamp(),
          LastError: ''
        }, { merge: true });
      });
      if (duplicateResult) return { ok: true, duplicate: true, operationId: operation.id, result: duplicateResult };
      try {
        const result = await handlers[operation.type]({ db, req, operation, payload: operation.payload, actor });
        const stored = scrub(serialize(result || {}));
        await ref.set({ Status: 'synced', Result: stored, CompletedAt: FieldValue.serverTimestamp(), UpdatedAt: FieldValue.serverTimestamp(), LastError: '' }, { merge: true });
        return { ok: true, operationId: operation.id, result: stored };
      } catch (error) {
        await ref.set({ Status: 'retry', UpdatedAt: FieldValue.serverTimestamp(), LastError: text(error?.message || error, 4000) }, { merge: true }).catch(() => {});
        throw error;
      }
    },
    inspectionData: (inspectionId, req, options) => inspectionData(db, inspectionId, req, options)
  };
}
