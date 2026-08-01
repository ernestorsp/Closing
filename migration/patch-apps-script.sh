#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
python3 - <<'PY'
from pathlib import Path
path = Path('apps-script/Index.html')
text = path.read_text()
base = "<?!= include_('Scripts'); ?>"
replacement = """<?!= include_('Scripts'); ?>
<?!= include_('FirebaseBridge'); ?>
<?!= include_('FirebaseIntegration'); ?>
<?!= include_('FirebaseInspectionOverrides'); ?>"""
if "include_('FirebaseInspectionOverrides')" not in text:
    if base not in text:
        raise SystemExit('Scripts include was not found in apps-script/Index.html')
    text = text.replace(base, replacement, 1)
    path.write_text(text)
    print('Firebase inspection includes added to Index.html')
else:
    print('Firebase inspection includes already present')
PY
