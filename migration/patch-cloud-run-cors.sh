#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
python3 - <<'PY'
from pathlib import Path
path=Path('cloud-run-api/src/index.js')
text=path.read_text()
old="""app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
"""
new="""function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  try {
    const url = new URL(origin);
    return url.protocol === 'https:' && (
      url.hostname === 'script.google.com' ||
      url.hostname.endsWith('.googleusercontent.com')
    );
  } catch (_error) { return false; }
}

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (isAllowedOrigin(origin)) {
"""
if 'function isAllowedOrigin(origin)' in text:
    print('Cloud Run CORS already supports Apps Script origins')
elif old not in text:
    raise SystemExit('Expected CORS middleware was not found')
else:
    path.write_text(text.replace(old,new,1))
    print('Cloud Run CORS patched for Apps Script origins')
PY
