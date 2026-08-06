import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

if (!getApps().length) initializeApp({ credential: applicationDefault() });
const db = getFirestore();

async function countCollection(name) {
  const snapshot = await db.collection(name).count().get();
  return snapshot.data().count;
}

async function sampleCollection(name, limit = 3) {
  const snapshot = await db.collection(name).limit(limit).get();
  return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

const collections = ['users', 'vans', 'spots', 'inspections', 'inspectionLocks'];
const counts = {};
for (const name of collections) counts[name] = await countCollection(name);

const result = {
  ok: true,
  projectId: process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || 'application-default',
  counts,
  samples: {
    users: await sampleCollection('users', 2),
    vans: await sampleCollection('vans', 3),
    spots: await sampleCollection('spots', 3)
  }
};

console.log(JSON.stringify(result, null, 2));
