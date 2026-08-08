#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-aaxi-closing}"
REGION="${REGION:-us-east1}"
SERVICE="${SERVICE:-aaxi-closing-api}"
ORIGINS="${ALLOWED_ORIGINS:-https://aaxi-closing.web.app,https://aaxi-closing.firebaseapp.com}"
STORAGE_BUCKET="${FIREBASE_STORAGE_BUCKET:-aaxi-closing.firebasestorage.app}"
PUBLIC_APP_URL="${PUBLIC_APP_URL:-https://aaxi-closing.web.app}"
EMAIL_FROM="${EMAIL_FROM:-}"
CLOSING_EMAIL_RECIPIENTS="${CLOSING_EMAIL_RECIPIENTS:-}"
RESEND_SECRET_NAME="${RESEND_SECRET_NAME:-aaxi-closing-resend-api-key}"

command -v gcloud >/dev/null 2>&1 || { echo 'gcloud CLI is required.' >&2; exit 1; }
test -n "$EMAIL_FROM" || { echo 'EMAIL_FROM is required.' >&2; exit 1; }
test -n "$CLOSING_EMAIL_RECIPIENTS" || { echo 'CLOSING_EMAIL_RECIPIENTS is required.' >&2; exit 1; }

gcloud config set project "$PROJECT_ID"
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  firestore.googleapis.com \
  firebase.googleapis.com \
  firebasestorage.googleapis.com \
  secretmanager.googleapis.com

gcloud secrets describe "$RESEND_SECRET_NAME" --project "$PROJECT_ID" >/dev/null

gcloud run deploy "$SERVICE" \
  --project "$PROJECT_ID" \
  --source cloud-run-api \
  --region "$REGION" \
  --allow-unauthenticated \
  --set-env-vars "GOOGLE_CLOUD_PROJECT=$PROJECT_ID,FIREBASE_STORAGE_BUCKET=$STORAGE_BUCKET,ALLOWED_ORIGINS=$ORIGINS,INSPECTION_LOCK_TTL_MS=1800000,PUBLIC_APP_URL=$PUBLIC_APP_URL,EMAIL_FROM=$EMAIL_FROM,CLOSING_EMAIL_RECIPIENTS=$CLOSING_EMAIL_RECIPIENTS" \
  --set-secrets "RESEND_API_KEY=$RESEND_SECRET_NAME:latest" \
  --min 0 \
  --max 10 \
  --concurrency 40 \
  --memory 512Mi \
  --cpu 1 \
  --quiet

SERVICE_URL="$(gcloud run services describe "$SERVICE" --project "$PROJECT_ID" --region "$REGION" --format='value(status.url)')"
gcloud run services update "$SERVICE" \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --update-env-vars "API_PUBLIC_URL=$SERVICE_URL" \
  --quiet
echo "Cloud Run deployed: $SERVICE_URL"
