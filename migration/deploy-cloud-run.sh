#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${PROJECT_ID:?Set PROJECT_ID}"
REGION="${REGION:-us-east1}"
SERVICE="${SERVICE:-aaxi-closing-api}"
ORIGINS="${ALLOWED_ORIGINS:-https://ernestorsp.github.io}"

gcloud config set project "$PROJECT_ID"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com firestore.googleapis.com firebase.googleapis.com

gcloud run deploy "$SERVICE" \
  --source cloud-run-api \
  --region "$REGION" \
  --allow-unauthenticated \
  --set-env-vars "ALLOWED_ORIGINS=$ORIGINS,INSPECTION_LOCK_TTL_MS=300000" \
  --min 0 \
  --max 10 \
  --concurrency 40 \
  --memory 512Mi \
  --cpu 1
