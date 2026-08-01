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
const password = String(process.env.ADMIN_PASSWORD || '');

if (!email || !email.includes('@')) {
  console.error('Usage: ADMIN_PASSWORD=... node bootstrap-admin.mjs <email> [displayName] [DJX3|DJX4]');
  process.exit(1);
}
if (!['DJX3', 'DJX4'].includes(station)) throw new Error('Station must be DJX3 or DJX4.');
if (password && password.length < 6) throw new Error('ADMIN_PASSWORD must have at least 6 characters.');

let user;
try {
  user = await auth.getUserByEmail(email);
  const changes = { displayName, disabled: false };
  if (password) changes.password = password;
  user = await auth.updateUser(user.uid, changes);
  console.log(`Updated existing Firebase Auth user: ${user.uid}`);
} catch (error) {
  if (error.code !== 'auth/user-not-found') throw error;
  user = await auth.createUser({
    email,
    displayName,
    emailVerified: false,
    disabled: false,
    ...(password ? { password } : {})
  });
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
  passwordConfigured: Boolean(password)
}, null, 2));
