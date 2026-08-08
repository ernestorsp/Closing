import process from 'node:process';
import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';

if (!getApps().length) initializeApp({ credential: applicationDefault() });
const db = getFirestore();
const auth = getAuth();
const apiKey = String(process.env.RESEND_API_KEY || '').trim();
const from = String(process.env.EMAIL_FROM || '').trim();
const appUrl = String(process.env.PUBLIC_APP_URL || 'https://aaxi-closing.web.app').trim();
const dryRun = process.argv.includes('--dry-run');
const confirm = process.argv.includes('--confirm-send');
if (!dryRun && !confirm) throw new Error('Run with --dry-run first, then add --confirm-send to email password links.');
if (!dryRun && (!apiKey || !from)) throw new Error('RESEND_API_KEY and EMAIL_FROM are required.');

const profiles = await db.collection('users').limit(1000).get();
let eligible = 0;
let sent = 0;
let skipped = 0;
for (const profile of profiles.docs) {
  if (profile.get('Active') === false || profile.get('active') === false) { skipped += 1; continue; }
  const email = String(profile.get('Email') || profile.get('email') || '').trim().toLowerCase();
  if (!email) { skipped += 1; continue; }
  eligible += 1;
  if (dryRun) continue;
  const link = await auth.generatePasswordResetLink(email, { url: appUrl });
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + apiKey, 'content-type': 'application/json', 'Idempotency-Key': 'firebase-cutover-' + profile.id },
    body: JSON.stringify({
      from,
      to: [email],
      subject: 'Create your AAXI Closing Firebase password',
      html: '<div style="font-family:Arial,sans-serif"><h2>AAXI Closing moved to Firebase</h2><p>Create your password to access the new application.</p><p><a href="' + link + '">CREATE PASSWORD</a></p></div>',
      text: 'Create your AAXI Closing password: ' + link
    })
  });
  if (!response.ok) throw new Error('Could not send password link to ' + email + ': ' + await response.text());
  await profile.ref.set({ PasswordResetSentAt: FieldValue.serverTimestamp() }, { merge: true });
  sent += 1;
}
if (!dryRun) await db.collection('system').doc('migration').set({ PasswordResetLinksSent: true, PasswordResetLinksSentAt: FieldValue.serverTimestamp(), PasswordResetLinksSentCount: sent }, { merge: true });
console.log(JSON.stringify({ ok: true, dryRun, eligible, sent, skipped }, null, 2));
