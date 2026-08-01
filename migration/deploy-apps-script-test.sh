#!/usr/bin/env bash
set -euo pipefail

SCRIPT_ID="${SCRIPT_ID:-}"
if [[ -z "$SCRIPT_ID" ]]; then
  echo "Set SCRIPT_ID to the Apps Script project ID." >&2
  echo "Example: SCRIPT_ID=... bash migration/deploy-apps-script-test.sh" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$HOME/aaxi-closing-apps-script-live"
BACKUPS="$HOME/aaxi-closing-apps-script-backups"
STAMP="$(date +%Y%m%d-%H%M%S)"

command -v npx >/dev/null 2>&1 || { echo 'Node.js/npm is required.' >&2; exit 1; }
mkdir -p "$BACKUPS"
rm -rf "$WORK"
mkdir -p "$WORK"

if [[ ! -f "$HOME/.clasprc.json" ]]; then
  echo "Clasp authorization is required. Follow the URL and paste the authorization code."
  npx --yes @google/clasp login --no-localhost
fi

cd "$WORK"
printf '{"scriptId":"%s","rootDir":"."}\n' "$SCRIPT_ID" > .clasp.json
npx --yes @google/clasp pull

tar -czf "$BACKUPS/apps-script-$STAMP.tar.gz" --exclude='.clasp.json' .
echo "Backup created: $BACKUPS/apps-script-$STAMP.tar.gz"

for file in FirebaseBridge.html FirebaseTestMode.html FirebaseIntegration.html FirebaseInspectionOverrides.html FirebaseBootstrapOverrides.html FirebaseLockGate.html; do
  cp "$ROOT/apps-script/$file" "$WORK/$file"
done

python3 - <<'PY'
from pathlib import Path
path = Path('Index.html')
if not path.exists():
    raise SystemExit('Index.html was not found in the live Apps Script project.')
text = path.read_text()
base = "<?!= include_('Scripts'); ?>"
includes = [
    "<?!= include_('FirebaseBridge'); ?>",
    "<?!= include_('FirebaseTestMode'); ?>",
    "<?!= include_('FirebaseIntegration'); ?>",
    "<?!= include_('FirebaseInspectionOverrides'); ?>",
    "<?!= include_('FirebaseBootstrapOverrides'); ?>",
    "<?!= include_('FirebaseLockGate'); ?>",
]
if base not in text:
    raise SystemExit("The Scripts include was not found in live Index.html; nothing was pushed.")
for include in includes:
    text = text.replace(include + "\n", '').replace("\n" + include, '')
text = text.replace(base, base + "\n" + "\n".join(includes), 1)
path.write_text(text)
PY

npx --yes @google/clasp push -f

echo
echo "Firebase test files were pushed to Apps Script."
echo "No deployment was changed automatically."
echo "Open Apps Script > Deploy > Manage deployments, edit the current web app, choose New version, and deploy."
