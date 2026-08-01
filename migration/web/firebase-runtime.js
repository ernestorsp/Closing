import { initializeApp, getApps } from 'https://www.gstatic.com/firebasejs/12.1.0/firebase-app.js';
import {
  browserLocalPersistence,
  getAuth,
  onAuthStateChanged,
  setPersistence,
  signInWithEmailAndPassword,
  signOut
} from 'https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js';
import {
  getStorage,
  ref,
  uploadBytesResumable,
  getDownloadURL
} from 'https://www.gstatic.com/firebasejs/12.1.0/firebase-storage.js';
import { AAXI_FIREBASE_CONFIG, AAXI_MIGRATION_CONFIG, shouldUseFirebaseBackend } from './firebase-project-config.js';
import { ClosingApiClient } from './firebase-api-client.js';
import { OfflineOperationQueue } from './offline-operation-queue.js';

const app = getApps()[0] || initializeApp(AAXI_FIREBASE_CONFIG);
const auth = getAuth(app);
const storage = getStorage(app);
const queue = new OfflineOperationQueue();
await setPersistence(auth, browserLocalPersistence);

export const firebaseRuntime = {
  app,
  auth,
  storage,
  queue,
  get user() { return auth.currentUser; },
  get enabled() { return shouldUseFirebaseBackend(auth.currentUser); },
  async signIn(email, password) {
    const result = await signInWithEmailAndPassword(auth, email, password);
    return result.user;
  },
  signOut() { return signOut(auth); },
  onUserChanged(callback) { return onAuthStateChanged(auth, callback); },
  api() {
    return new ClosingApiClient({
      baseUrl: AAXI_MIGRATION_CONFIG.apiBaseUrl,
      getIdToken: async () => auth.currentUser ? auth.currentUser.getIdToken() : ''
    });
  },
  uploadInspectionPhoto({ inspectionId, file, fileName = crypto.randomUUID(), metadata = {} }) {
    if (!auth.currentUser) throw new Error('Firebase sign-in is required.');
    if (!file?.type?.startsWith('image/')) throw new Error('Only images can be uploaded.');
    if (file.size > 8 * 1024 * 1024) throw new Error('Photo is larger than 8 MB.');
    const extension = (file.name?.split('.').pop() || 'jpg').replace(/[^a-z0-9]/gi, '').toLowerCase();
    const path = `${AAXI_MIGRATION_CONFIG.storageRoot}/${inspectionId}/${fileName}.${extension}`;
    const storageRef = ref(storage, path);
    const task = uploadBytesResumable(storageRef, file, {
      contentType: file.type,
      customMetadata: {
        inspectionId: String(inspectionId),
        uploadedBy: auth.currentUser.uid,
        ...Object.fromEntries(Object.entries(metadata).map(([key, value]) => [key, String(value)]))
      }
    });
    const completed = new Promise((resolve, reject) => {
      task.on('state_changed', undefined, reject, async () => resolve({
        path,
        url: await getDownloadURL(task.snapshot.ref),
        size: task.snapshot.totalBytes,
        contentType: file.type
      }));
    });
    return { task, completed };
  }
};

window.AAXI_FIREBASE_RUNTIME = firebaseRuntime;
