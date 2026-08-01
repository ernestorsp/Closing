export const AAXI_FIREBASE_CONFIG = Object.freeze({
  apiKey: 'AIzaSyCtc1vuIVnEH93CWqmVr8JDFPQP7YRlNZs',
  authDomain: 'aaxi-closing.firebaseapp.com',
  projectId: 'aaxi-closing',
  storageBucket: 'aaxi-closing.firebasestorage.app',
  messagingSenderId: '263781869863',
  appId: '1:263781869863:web:daeff766d19dc6ff1d6102',
  measurementId: 'G-WPQDMFJ8D1'
});

export const AAXI_MIGRATION_CONFIG = Object.freeze({
  enabled: false,
  apiBaseUrl: '',
  rolloutUsers: [],
  storageRoot: 'inspection-photos',
  lockHeartbeatMs: 90_000
});

export function shouldUseFirebaseBackend(user = null) {
  if (!AAXI_MIGRATION_CONFIG.enabled) return false;
  if (!AAXI_MIGRATION_CONFIG.rolloutUsers.length) return true;
  const keys = [user?.uid, user?.email].filter(Boolean).map(value => String(value).toLowerCase());
  return keys.some(key => AAXI_MIGRATION_CONFIG.rolloutUsers.map(value => String(value).toLowerCase()).includes(key));
}
