export const WORK_STATIONS = ['DJX3', 'DJX4'];
export const STATIONS = [...WORK_STATIONS, 'SHOP'];
export const STATUSES = ['Operational', 'Downed', 'Grounded'];
export const PHOTO_PARTS = [
  'Front',
  'Driver Side',
  'Rear',
  'Passenger Side',
  'Cargo Interior',
  'Cabin Interior'
];
export const DEFECTS = [
  ...PHOTO_PARTS,
  'Tires',
  'Headlights',
  'Brake Lights',
  'Turn Signals',
  'A/C',
  'Mirrors',
  'Windshield',
  'Doors',
  'Brakes',
  'Battery',
  'Engine / Warning Lights',
  'Horn',
  'Wipers',
  'Seat Belts',
  'Camera / Sensors',
  'Other'
];

export function apiError(status, code, message, details) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  error.details = details;
  return error;
}

export function text(value, max = 5000) {
  return String(value ?? '').trim().slice(0, max);
}

export function identifier(value, field = 'identifier') {
  const id = text(value, 160);
  if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(id)) {
    throw apiError(400, 'INVALID_ARGUMENT', `Invalid ${field}.`);
  }
  return id;
}

export function station(value, { workingOnly = false } = {}) {
  const normalized = text(value, 10).toUpperCase();
  const allowed = workingOnly ? WORK_STATIONS : STATIONS;
  if (!allowed.includes(normalized)) {
    throw apiError(400, 'INVALID_STATION', `Station must be ${allowed.join(', ')}.`);
  }
  return normalized;
}

export function dateKey(value) {
  const normalized = text(value, 20);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw apiError(400, 'INVALID_DATE', 'Date must use YYYY-MM-DD.');
  }
  return normalized;
}

export function todayKey(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(now);
}

export function inspectionDayKey(now = new Date()) {
  return todayKey(new Date(now.getTime() - (2 * 60 * 60 * 1000)));
}

export function isYes(value) {
  return value === true || ['yes', 'true', '1', 'active'].includes(text(value, 20).toLowerCase());
}

export function serialize(value) {
  if (value == null) return value;
  if (typeof value?.toDate === 'function') return value.toDate().toISOString();
  if (Array.isArray(value)) return value.map(serialize);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, serialize(child)]));
  }
  return value;
}

export function docData(snapshot) {
  return snapshot.exists ? { ...serialize(snapshot.data()), _documentId: snapshot.id } : null;
}

export function role(profile) {
  return text(profile?.Role || profile?.role, 30).toLowerCase();
}

export function isAdmin(profile) {
  return role(profile) === 'admin' || isYes(profile?.IsAdmin);
}

export function allowedStations(profile) {
  if (isAdmin(profile)) return [...WORK_STATIONS];
  const direct = Array.isArray(profile?.stationAccess)
    ? profile.stationAccess
    : text(profile?.StationAccess || profile?.stationAccess, 60).split(/[|,]/);
  const normalized = direct.map(value => text(value, 10).toUpperCase()).filter(value => WORK_STATIONS.includes(value));
  if (text(profile?.StationAccess, 20).toLowerCase() === 'both') return [...WORK_STATIONS];
  const fallback = text(profile?.DefaultStation || profile?.WorkingStation || profile?.station, 10).toUpperCase();
  if (WORK_STATIONS.includes(fallback)) normalized.push(fallback);
  return [...new Set(normalized.length ? normalized : ['DJX3'])];
}

export function workingStation(profile) {
  const selected = text(profile?.WorkingStation || profile?.DefaultStation || profile?.station, 10).toUpperCase();
  const allowed = allowedStations(profile);
  return allowed.includes(selected) ? selected : allowed[0];
}

export function assertStationAccess(profile, requested) {
  const normalized = station(requested, { workingOnly: true });
  if (!allowedStations(profile).includes(normalized)) {
    throw apiError(403, 'STATION_ACCESS_DENIED', 'You do not have access to this station.');
  }
  return normalized;
}

export function assertAdmin(profile) {
  if (!isAdmin(profile)) throw apiError(403, 'ADMIN_REQUIRED', 'Administrator access required.');
}

export function publicUser(profile, firebaseUser) {
  const access = allowedStations(profile);
  const selected = workingStation(profile);
  return {
    email: text(firebaseUser?.email || profile?.Email || profile?.email, 320).toLowerCase(),
    name: text(profile?.Name || profile?.displayName || firebaseUser?.name || firebaseUser?.email, 160),
    role: isAdmin(profile) ? 'Admin' : 'Lead',
    isAdmin: isAdmin(profile),
    station: selected,
    stationAccess: access.length > 1 ? 'Both' : access[0],
    allowedStations: access,
    preferredLanguage: ['en', 'es'].includes(text(profile?.PreferredLanguage || profile?.preferredLanguage, 5).toLowerCase())
      ? text(profile?.PreferredLanguage || profile?.preferredLanguage, 5).toLowerCase()
      : 'en'
  };
}

export function vanHomeStation(van) {
  const home = text(van?.HomeStation, 10).toUpperCase();
  const current = text(van?.CurrentStation, 10).toUpperCase();
  return WORK_STATIONS.includes(home) ? home : (WORK_STATIONS.includes(current) ? current : '');
}

export function changedFields(before, after, fields) {
  return fields.reduce((changes, field) => {
    const oldValue = before?.[field] ?? '';
    const newValue = after?.[field] ?? '';
    if (String(oldValue) !== String(newValue)) changes[field] = { before: oldValue, after: newValue };
    return changes;
  }, {});
}

export function sameMoment(left, right) {
  if (!left && !right) return true;
  const a = new Date(left || 0).getTime();
  const b = new Date(right || 0).getTime();
  return Boolean(a && b && Math.abs(a - b) < 2000);
}

export function integer(value, min, max, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw apiError(400, 'INVALID_ARGUMENT', `${label} must be from ${min} to ${max}.`);
  }
  return parsed;
}

export function storagePath(value, prefix) {
  const path = text(value, 700);
  if (!path || !path.startsWith(prefix) || path.includes('..')) {
    throw apiError(400, 'INVALID_STORAGE_PATH', 'Invalid photo storage path.');
  }
  return path;
}
