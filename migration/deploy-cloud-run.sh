#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-aaxi-closing}"
REGION="${REGION:-us-east1}"
SERVICE="${SERVICE:-aaxi-closing-api}"
ORIGINS="${ALLOWED_ORIGINS:-https://ernestorsp.github.io}"

command -v gcloud >/dev/null 2>&1 || { echo 'gcloud CLI is required.' >&2; exit 1; }

gcloud config set project "$PROJECT_ID"
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  firestore.googleapis.com \
  firebase.googleapis.com \
  firebasestorage.googleapis.com \
  secretmanager.googleapis.com

gcloud run deploy "$SERVICE" \
  --project "$PROJECT_ID" \
  --source cloud-run-api \
  --region "$REGION" \
  --allow-unauthenticated \
  --set-env-vars "GOOGLE_CLOUD_PROJECT=$PROJECT_ID,ALLOWED_ORIGINS=$ORIGINS,INSPECTION_LOCK_TTL_MS=300000" \
  --min 0 \
  --max 10 \
  --concurrency 40 \
  --memory 512Mi \
  --cpu 1 \
  --quiet

SERVICE_URL="$(gcloud run services describe "$SERVICE" --project "$PROJECT_ID" --region "$REGION" --format='value(status.url)')"
echo "Cloud Run deployed: $SERVICE_URL"
echo "Set migration/web/firebase-project-config.js apiBaseUrl to: $SERVICE_URL"
