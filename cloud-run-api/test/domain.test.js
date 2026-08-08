import assert from 'node:assert/strict';
import test from 'node:test';
import { allowedStations, changedFields, publicUser, sameMoment, station, todayKey } from '../src/domain.js';

test('Firebase profiles preserve current Admin and station behavior', () => {
  const admin = { Email: 'admin@example.com', Name: 'Admin', Role: 'Admin', Active: true, DefaultStation: 'DJX4' };
  assert.deepEqual(allowedStations(admin), ['DJX3', 'DJX4']);
  assert.equal(publicUser(admin, { email: admin.Email }).station, 'DJX4');
  assert.equal(publicUser(admin, { email: admin.Email }).stationAccess, 'Both');
  assert.deepEqual(allowedStations({ Role: 'Lead', StationAccess: 'DJX3', DefaultStation: 'DJX3' }), ['DJX3']);
});

test('stations and optimistic-concurrency timestamps are validated', () => {
  assert.equal(station('djx3'), 'DJX3');
  assert.throws(() => station('F1'), /Station must be/);
  assert.equal(sameMoment('2026-08-08T10:00:00.000Z', '2026-08-08T10:00:01.000Z'), true);
  assert.equal(sameMoment('2026-08-08T10:00:00.000Z', '2026-08-08T10:00:03.000Z'), false);
});

test('audit diffs contain only changed fields', () => {
  assert.deepEqual(changedFields({ Status: 'Operational', Spot: 'A-1' }, { Status: 'Downed', Spot: 'A-1' }, ['Status', 'Spot']), {
    Status: { before: 'Operational', after: 'Downed' }
  });
});

test('New York business date uses YYYY-MM-DD', () => {
  assert.match(todayKey(new Date('2026-08-08T12:00:00Z')), /^2026-08-08$/);
});
