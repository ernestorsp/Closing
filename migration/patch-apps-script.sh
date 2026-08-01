#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
python3 - <<'PY'
from pathlib import Path
path = Path('apps-script/Index.html')
text = path.read_text()
base = "<?!= include_('Scripts'); ?>"
includes = [
    "<?!= include_('FirebaseBridge'); ?>",
    "<?!= include_('FirebaseTestMode'); ?>",
    "<?!= include_('FirebaseIntegration'); ?>",
    "<?!= include_('FirebaseInspectionOverrides'); ?>",
    "<?!= include_('FirebaseBootstrapOverrides'); ?>",
]
if base not in text:
    raise SystemExit('Scripts include was not found in apps-script/Index.html')
for include in includes:
    text = text.replace(include + "\n", '').replace("\n" + include, '')
replacement = base + "\n" + "\n".join(includes)
text = text.replace(base, replacement, 1)
path.write_text(text)
print('Firebase migration includes synchronized in Index.html')
PY
