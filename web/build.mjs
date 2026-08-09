import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = path => readFile(join(root, path), 'utf8');
const [source, styles, runtime, vanNoteRuntime, syncCore, scripts, localFirst, manifest, serviceWorker] = await Promise.all([
  read('apps-script/Index.html'),
  read('apps-script/Styles.html'),
  read('web/FirebaseRuntime.html'),
  read('web/VanNoteRuntime.html'),
  read('apps-script/SyncCore.html'),
  read('apps-script/Scripts.html'),
  read('apps-script/LocalFirst.html'),
  read('manifest.webmanifest'),
  read('web/service-worker.js')
]);

let output = source
  .replace("<base target=\"_top\"><?!= include_('Styles'); ?>", `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover"><meta name="theme-color" content="#173f5f"><link rel="manifest" href="/manifest.webmanifest">${styles}`)
  .replace(/<script>window\.CLOSING_ENTRY=\{mode:[\s\S]*?<\/script>/, '<script>window.CLOSING_ENTRY={mode:"app",token:""};</script>')
  .replace("<?!= include_('SyncCore'); ?>", `${runtime}\n${vanNoteRuntime}\n${syncCore}`)
  .replace("<?!= include_('Scripts'); ?>", scripts)
  .replace("<?!= include_('LocalFirst'); ?>", `${localFirst}\n<script>if('serviceWorker' in navigator)navigator.serviceWorker.register('/service-worker.js').catch(console.error);</script>`);

const outDir = join(root, 'web', 'dist');
await mkdir(outDir, { recursive: true });
await Promise.all([
  writeFile(join(outDir, 'index.html'), output),
  writeFile(join(outDir, '404.html'), output),
  writeFile(join(outDir, 'manifest.webmanifest'), manifest),
  writeFile(join(outDir, 'service-worker.js'), serviceWorker)
]);
console.log(`Built Firebase Hosting app: ${join(outDir, 'index.html')}`);
