#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-aaxi-closing}"
ADMIN_EMAIL="${ADMIN_EMAIL:-santiagopiedrae@gmail.com}"
ADMIN_NAME="${ADMIN_NAME:-Ernesto Santiago}"
ADMIN_STATION="${ADMIN_STATION:-DJX3}"

cd "$(dirname "$0")/.."
gcloud config set project "$PROJECT_ID" >/dev/null

if [[ -z "${ADMIN_PASSWORD:-}" ]]; then
  read -rsp "Temporary Firebase password for ${ADMIN_EMAIL}: " ADMIN_PASSWORD
  echo
fi
if [[ ${#ADMIN_PASSWORD} -lt 6 ]]; then
  echo "Password must contain at least 6 characters." >&2
  exit 1
fi

npm install --prefix migration/scripts --no-audit --no-fund
ADMIN_PASSWORD="$ADMIN_PASSWORD" node migration/scripts/bootstrap-admin.mjs "$ADMIN_EMAIL" "$ADMIN_NAME" "$ADMIN_STATION"

echo
echo "Firebase administrator is ready."
echo "Next: import the CLOSING vans/spots JSON with:"
echo "  node migration/scripts/import-firestore-export.mjs /path/to/closing-firestore-export.json"
