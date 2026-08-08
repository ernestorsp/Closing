#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-aaxi-closing}"
command -v firebase >/dev/null 2>&1 || { echo 'Firebase CLI is required.' >&2; exit 1; }
npm run build:web
firebase deploy \
  --project "$PROJECT_ID" \
  --config firebase/firebase.json \
  --only firestore:rules,firestore:indexes,storage,hosting
