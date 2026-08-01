import process from 'node:process';
import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';

if (!getApps().length) initializeApp({ credential: applicationDefault() });
const auth = getAuth();
const db = getFirestore();

const email = String(process.argv[2] || process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const displayName = String(process.argv[3] || process.env.ADMIN_NAME || 'AAXI Administrator').trim();
const station = String(process.argv[4] || process.env.ADMIN_STATION || 'DJX3').trim().toUpperCase();

if (!email || !email.includes('@')) {
  console.error('Usage: node bootstrap-admin.mjs <email> [displayName] [DJX3|DJX4]');
  process.exit(1);
}
if (!['DJX3', 'DJX4'].includes(station)) throw new Error('Station must be DJX3 or DJX4.');

let user;
try {
  user = await auth.getUserByEmail(email);
  console.log(`Using existing Firebase Auth user: ${user.uid}`);
} catch (error) {
  if (error.code !== 'auth/user-not-found') throw error;
  user = await auth.createUser({ email, displayName, emailVerified: false, disabled: false });
  console.log(`Created Firebase Auth user: ${user.uid}`);
}

await db.collection('users').doc(user.uid).set({
  uid: user.uid,
  email,
  displayName,
  role: 'admin',
  station,
  stations: ['DJX3', 'DJX4'],
  active: true,
  migrationEnabled: true,
  updatedAt: FieldValue.serverTimestamp(),
  createdAt: FieldValue.serverTimestamp()
}, { merge: true });

console.log(JSON.stringify({
  ok: true,
  uid: user.uid,
  email,
  displayName,
  role: 'admin',
  station,
  passwordSetup: 'Use Firebase password reset or create a temporary password in Authentication.'
}, null, 2));
