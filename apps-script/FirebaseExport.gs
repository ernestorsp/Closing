const FIREBASE_EXPORT_VERSION = 2;
const FIREBASE_MEDIA_BATCH_SIZE = 20;
const FIREBASE_MEDIA_CURSOR_KEY = 'CLOSING_FIREBASE_MEDIA_CURSOR_V2';

function exportClosingDataForFirebase() {
  const ss = SpreadsheetApp.getActive();
  const sheets = {
    config: 'CONFIG',
    users: 'USERS',
    vans: 'VANS',
    spots: 'SPOTS',
    inspections: 'INSPECTIONS',
    photos: 'PHOTOS',
    damages: 'DAMAGES',
    audit: 'AUDIT_LOG',
    rescueDrivers: 'RESCUE_DRIVERS',
    rescues: 'RESCUES',
    dailyRescueDrivers: 'DAILY_RESCUE_DRIVERS',
    closingDays: 'DAILY_CLOSING',
    closingNotes: 'CLOSING_NOTES',
    inspectionSkipRequests: 'INSPECTION_SKIP_REQUESTS',
    avatarMessages: 'AVATAR_MESSAGES',
    avatarAcks: 'AVATAR_ACKS',
    syncMetadata: 'SYNC_METADATA'
  };
  const data = {};
  Object.keys(sheets).forEach(key => data[key] = firebaseExportRows_(ss.getSheetByName(sheets[key])));
  const payload = {
    version: FIREBASE_EXPORT_VERSION,
    spreadsheetId: ss.getId(),
    spreadsheetName: ss.getName(),
    exportedAt: new Date().toISOString(),
    timeZone: ss.getSpreadsheetTimeZone(),
    data: data
  };
  const folder = firebaseMigrationFolder_();
  const name = 'closing-firebase-export-' + Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'yyyyMMdd-HHmmss') + '.json';
  const file = folder.createFile(name, JSON.stringify(payload, null, 2), MimeType.PLAIN_TEXT);
  const counts = {};
  Object.keys(data).forEach(key => counts[key] = data[key].length);
  return { ok: true, version: FIREBASE_EXPORT_VERSION, fileId: file.getId(), fileName: name, fileUrl: file.getUrl(), counts: counts };
}

function exportClosingDataForFirestore() {
  return exportClosingDataForFirebase();
}

function firebaseExportRows_(sheet) {
  if (!sheet || sheet.getLastRow() < 1) return [];
  const values = sheet.getDataRange().getValues();
  const headers = values[0].map((value, index) => String(value || '').trim() || ('Column' + (index + 1)));
  return values.slice(1).filter(row => row.some(value => String(value == null ? '' : value).trim() !== '')).map((row, index) => {
    const object = { _sourceSheet: sheet.getName(), _sourceRow: index + 2 };
    headers.forEach((header, column) => object[header] = firebaseJsonValue_(row[column]));
    return object;
  });
}

function firebaseJsonValue_(value) {
  return value instanceof Date ? value.toISOString() : value;
}

function firebaseMigrationFolder_() {
  const name = 'Closing Firebase Migration';
  const folders = DriveApp.getFoldersByName(name);
  return folders.hasNext() ? folders.next() : DriveApp.createFolder(name);
}

function firebaseExtension_(blob) {
  const type = String(blob.getContentType() || '').toLowerCase();
  return type.indexOf('png') >= 0 ? 'png' : type.indexOf('webp') >= 0 ? 'webp' : 'jpg';
}

function firebaseMediaManifest_() {
  const ss = SpreadsheetApp.getActive();
  const media = [];
  firebaseExportRows_(ss.getSheetByName('PHOTOS')).forEach(row => {
    const fileId = String(row.FileID || '').trim();
    const inspectionId = String(row.InspectionID || '').trim();
    const photoId = String(row.PhotoID || '').trim();
    if (!fileId || !inspectionId || !photoId) return;
    media.push({
      kind: 'inspection',
      fileId: fileId,
      documentId: photoId,
      inspectionId: inspectionId,
      preferredName: 'inspection_' + photoId
    });
  });
  firebaseExportRows_(ss.getSheetByName('CLOSING_NOTES')).forEach(row => {
    const date = String(row.NoteDate || row.RecordDate || '').slice(0, 10);
    const station = String(row.Station || '').trim();
    String(row.PhotoFileIDs || '').split('|').map(value => value.trim()).filter(Boolean).forEach((fileId, index) => {
      media.push({
        kind: 'closing-note',
        fileId: fileId,
        documentId: String(row.NoteID || row.NoteKey || (date + '_' + station)),
        noteKey: String(row.NoteKey || (date + '_' + station)),
        date: date,
        station: station,
        preferredName: 'closing_' + String(row.NoteID || row.NoteKey || 'note') + '_' + (index + 1)
      });
    });
  });
  return media;
}

function exportNextClosingPhotoArchiveForFirebase() {
  const all = firebaseMediaManifest_();
  const properties = PropertiesService.getScriptProperties();
  const start = Number(properties.getProperty(FIREBASE_MEDIA_CURSOR_KEY) || 0);
  if (start >= all.length) return { ok: true, complete: true, processed: all.length, total: all.length, message: 'All Firebase photo archives were already created.' };
  const selected = all.slice(start, start + FIREBASE_MEDIA_BATCH_SIZE);
  const blobs = [];
  const files = [];
  selected.forEach((item, offset) => {
    try {
      const file = DriveApp.getFileById(item.fileId);
      const blob = file.getBlob();
      const extension = firebaseExtension_(blob);
      const archiveName = String(start + offset + 1).padStart(6, '0') + '_' + item.preferredName.replace(/[^\w.-]+/g, '_') + '.' + extension;
      blobs.push(blob.setName(archiveName));
      files.push(Object.assign({}, item, {
        archiveName: archiveName,
        contentType: blob.getContentType(),
        storagePath: item.kind === 'inspection'
          ? 'inspection-photos/' + item.inspectionId + '/migrated_' + item.documentId.replace(/[^\w.-]+/g, '_') + '.' + extension
          : 'closing-notes/' + item.date + '/' + item.station + '/migrated_' + item.documentId.replace(/[^\w.-]+/g, '_') + '_' + (offset + 1) + '.' + extension
      }));
    } catch (error) {
      files.push(Object.assign({}, item, { error: String(error && error.message || error) }));
    }
  });
  const manifest = { version: FIREBASE_EXPORT_VERSION, startIndex: start, nextIndex: Math.min(all.length, start + selected.length), total: all.length, files: files };
  blobs.push(Utilities.newBlob(JSON.stringify(manifest, null, 2), MimeType.PLAIN_TEXT, 'manifest.json'));
  const name = 'closing-firebase-media-' + String(start + 1).padStart(6, '0') + '-' + String(Math.min(all.length, start + selected.length)).padStart(6, '0') + '.zip';
  const zip = Utilities.zip(blobs, name);
  const file = firebaseMigrationFolder_().createFile(zip);
  const next = Math.min(all.length, start + selected.length);
  properties.setProperty(FIREBASE_MEDIA_CURSOR_KEY, String(next));
  return { ok: true, complete: next >= all.length, processed: next, total: all.length, fileId: file.getId(), fileName: name, fileUrl: file.getUrl(), failures: files.filter(item => item.error).length };
}

function resetClosingPhotoArchiveExport() {
  PropertiesService.getScriptProperties().deleteProperty(FIREBASE_MEDIA_CURSOR_KEY);
  return { ok: true, message: 'Firebase media export cursor reset.' };
}
