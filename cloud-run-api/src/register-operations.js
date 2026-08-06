import express from 'express';
import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { createOperationsRouter } from './operations-router.js';

if (!getApps().length) initializeApp({ credential: applicationDefault() });

const db = getFirestore();
const auth = getAuth();
const originalListen = express.application.listen;
let mounted = false;

function apiError(status, code, message, details = undefined) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  error.details = details;
  return error;
}

async function requireAuth(req, _res, next) {
  try {
    const header = String(req.headers.authorization || '');
    if (!header.startsWith('Bearer ')) {
      throw apiError(401, 'UNAUTHENTICATED', 'Missing Firebase ID token.');
    }

    req.user = await auth.verifyIdToken(header.slice(7), true);
    const profile = await db.collection('users').doc(req.user.uid).get();
    if (!profile.exists || profile.get('active') === false) {
      throw apiError(403, 'USER_DISABLED', 'User is not active.');
    }

    req.profile = profile.data();
    next();
  } catch (error) {
    next(error);
  }
}

function operationsErrorHandler(error, _req, res, _next) {
  console.error('[operations-router]', error);
  const status = Number(error.status || 500);
  res.status(status).json({
    ok: false,
    error: {
      code: error.code || 'INTERNAL',
      message: status >= 500 ? 'Internal server error.' : error.message,
      details: error.details
    }
  });
}

express.application.listen = function patchedListen(...args) {
  if (!mounted) {
    this.use('/v1/operations', createOperationsRouter({ db, requireAuth }));
    this.use('/v1/operations', operationsErrorHandler);
    mounted = true;
    console.info('[operations-router] mounted at /v1/operations');
  }
  return originalListen.apply(this, args);
};
