import fs from 'node:fs/promises';
import process from 'node:process';
import AdmZip from 'adm-zip';
import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';

if (!getApps().length) initializeApp({
  credential: applicationDefault(),
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET || 'aaxi-closing.firebasestorage.app'
});
const db = getFirestore();
const bucket = getStorage().bucket();
const archives = process.argv.slice(2).filter(value => !value.startsWith('--'));
const dryRun = process.argv.includes('--dry-run');
const complete = process.argv.includes('--complete-media');
if (!archives.length) {
  console.error('Usage: node import-photo-archives.mjs <archive.zip> [more.zip ...] [--dry-run] [--complete-media]');
  process.exit(1);
}

let uploaded = 0;
let skipped = 0;
const notePaths = new Map();
for (const archivePath of archives) {
  const archive = new AdmZip(archivePath);
  const manifestEntry = archive.getEntry('manifest.json');
  if (!manifestEntry) throw new Error('manifest.json is missing from ' + archivePath);
  const manifest = JSON.parse(manifestEntry.getData().toString('utf8'));
  if (manifest.version !== 2) throw new Error('Unsupported media manifest version in ' + archivePath);
  for (const item of manifest.files || []) {
    if (item.error) { skipped += 1; continue; }
    const entry = archive.getEntry(item.archiveName);
    if (!entry) throw new Error('Missing ' + item.archiveName + ' in ' + archivePath);
    const buffer = entry.getData();
    if (!dryRun) {
      await bucket.file(item.storagePath).save(buffer, {
        resumable: false,
        contentType: item.contentType || 'image/jpeg',
        metadata: { metadata: { migratedFromDriveFileId: item.fileId || '' } }
      });
      if (item.kind === 'inspection') {
        await db.collection('photos').doc(String(item.documentId)).set({
          StoragePath: item.storagePath,
          ContentType: item.contentType || 'image/jpeg',
          Size: buffer.length,
          MediaMigratedAt: FieldValue.serverTimestamp()
        }, { merge: true });
      } else if (item.kind === 'closing-note') {
        const key = String(item.noteKey || (item.date + '_' + item.station));
        if (!notePaths.has(key)) notePaths.set(key, []);
        notePaths.get(key).push(item.storagePath);
      }
    }
    uploaded += 1;
  }
}
if (!dryRun) {
  for (const [key, paths] of notePaths) {
    const ref = db.collection('closingNotes').doc(key);
    const snapshot = await ref.get();
    const existing = Array.isArray(snapshot.get('PhotoStoragePaths')) ? snapshot.get('PhotoStoragePaths') : [];
    await ref.set({ PhotoStoragePaths: [...new Set([...existing, ...paths])], MediaMigratedAt: FieldValue.serverTimestamp() }, { merge: true });
  }
  await db.collection('system').doc('migration').set({
    MediaImported: complete,
    LastMediaImportAt: FieldValue.serverTimestamp(),
    LastMediaImportCount: uploaded
  }, { merge: true });
}
console.log(JSON.stringify({ ok: true, dryRun, complete, archives: archives.length, uploaded, skipped }, null, 2));
