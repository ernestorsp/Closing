import { FieldValue } from 'firebase-admin/firestore';
import { docData, serialize, text, todayKey } from './domain.js';

export { docData } from './domain.js';

export async function getCollection(db, name, limit = 2500) {
  const snapshot = await db.collection(name).limit(limit).get();
  return snapshot.docs.map(docData);
}

export async function getWhere(db, name, field, operator, value, limit = 1500) {
  const snapshot = await db.collection(name).where(field, operator, value).limit(limit).get();
  return snapshot.docs.map(docData);
}

export async function getByField(db, name, field, value, limit = 10) {
  const rows = await getWhere(db, name, field, '==', value, limit);
  return rows[0] || null;
}

export function auditWrite(db, actor, action, entityType, entityId, details = '') {
  return db.collection('audit').add({
    EventID: crypto.randomUUID(),
    Timestamp: FieldValue.serverTimestamp(),
    UserEmail: text(actor?.email, 320).toLowerCase(),
    UserUid: text(actor?.uid, 128),
    UserName: text(actor?.name, 160),
    Action: text(action, 100),
    EntityType: text(entityType, 80),
    EntityID: text(entityId, 160),
    Details: typeof details === 'string' ? details.slice(0, 12000) : JSON.stringify(serialize(details)).slice(0, 12000)
  });
}

export function actorFromRequest(req) {
  return {
    uid: req.user.uid,
    email: req.user.email || req.profile?.Email || '',
    name: req.profile?.Name || req.profile?.displayName || req.user.name || req.user.email || ''
  };
}

export function keyForDay(station, date = todayKey()) {
  return `${date}_${station}`;
}

export async function vanStatusCounts(db, station, vans) {
  const source = vans || await getCollection(db, 'vans', 2500);
  const counts = { Operational: 0, Downed: 0, Grounded: 0 };
  source.filter(row => row.Active !== false && row.HomeStation === station).forEach(row => {
    const status = row.CurrentStation === 'SHOP' ? 'Grounded' : (row.CurrentStatus || 'Operational');
    if (Object.hasOwn(counts, status)) counts[status] += 1;
  });
  return counts;
}
