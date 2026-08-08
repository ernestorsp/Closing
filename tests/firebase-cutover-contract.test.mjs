import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');

test('Firebase runtime has no Apps Script fallback or test-mode flag', () => {
  const runtime = read('web/FirebaseRuntime.html');
  assert.doesNotMatch(runtime, /originalCall|google\.script\.run\s*=|setEnabled|migrationEnabled|Firebase test/i);
  assert.match(runtime, /\/v1\/sync\/apply/);
  assert.match(runtime, /firebase\.auth/);
  assert.match(runtime, /firebase\.storage/);
});

test('every frontend server method has a Firebase implementation or explicit Auth implementation', () => {
  const frontend = read('apps-script/Scripts.html') + read('apps-script/LocalFirst.html');
  const names = [...frontend.matchAll(/\.([A-Za-z][A-Za-z0-9_]*)\((?:TOKEN|x\.email|CLOSING_ENTRY\.token|t\b)/g)].map(match => match[1]);
  const runtime = read('web/FirebaseRuntime.html');
  const router = read('cloud-run-api/src/rpc-router.js');
  const special = new Set(['login', 'logout', 'changePassword', 'requestPasswordReset', 'resetPasswordWithCode', 'acceptUserInvitation']);
  for (const name of new Set(names)) {
    assert.ok(special.has(name) ? runtime.includes(`method==='${name}'`) : router.includes(`async ${name}(`), `Missing Firebase implementation for ${name}`);
  }
});

test('critical local-first operations are idempotent Cloud Run operations', () => {
  const service = read('cloud-run-api/src/sync-service.js');
  for (const type of ['START_INSPECTION', 'SAVE_INSPECTION_PHOTO', 'SAVE_DAMAGE', 'FINISH_INSPECTION', 'SAVE_CLOSING', 'SAVE_RESCUES', 'SEND_NOTES', 'EDIT_INSPECTION']) {
    assert.match(service, new RegExp(type));
  }
  assert.match(service, /collection\('syncOperations'\)\.doc\(operation\.id\)/);
  assert.match(service, /runTransaction/);
});

test('Firebase Hosting output is static and keeps background sync private', () => {
  const built = read('web/dist/index.html');
  assert.doesNotMatch(built, /<\?!=/);
  assert.doesNotMatch(built, /Saved on this device\s*[·.]?\s*Remote synchronization|Remote synchronization is pending/i);
  assert.match(built, /CLOSING_ENTRY=\{mode:"app"/);
});

test('Closing email preserves DVIC N/A and hides receipts for DJX4', () => {
  const notes = read('cloud-run-api/src/closing-notes.js');
  assert.match(notes, /station === 'DJX4' \? ''/);
  assert.match(notes, /<td>DVIC<\/td><td>\$\{html\(list\(record\.DVICDrivers\)\)\}/);
  assert.match(notes, /return values\.length \? values\.join\(', '\) : 'N\/A'/);
});
