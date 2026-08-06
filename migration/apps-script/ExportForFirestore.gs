const FIRESTORE_EXPORT_VERSION = 1;

/**
 * Creates a JSON file in Drive containing normalized CLOSING data.
 * This is read-only: it does not modify operational sheets.
 */
function exportClosingDataForFirestore() {
  const ss = SpreadsheetApp.getActive();
  const exportedAt = new Date().toISOString();
  const payload = {
    version: FIRESTORE_EXPORT_VERSION,
    spreadsheetId: ss.getId(),
    exportedAt,
    vans: exportSheetAsObjects_(ss, ['VANS', 'Vans', 'VAN_INFO']),
    spots: exportSheetAsObjects_(ss, ['SPOTS', 'Spots']),
    inspections: exportSheetAsObjects_(ss, ['INSPECTIONS', 'Inspections']),
    users: exportSheetAsObjects_(ss, ['USERS', 'Users']),
    rescuesDjx3: exportSheetAsObjects_(ss, ['RESCUES DJX3']),
    rescuesDjx4: exportSheetAsObjects_(ss, ['RESCUES DJX4'])
  };

  validateExport_(payload);
  const name = 'closing-firestore-export-' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd-HHmmss') + '.json';
  const file = DriveApp.createFile(name, JSON.stringify(payload, null, 2), MimeType.PLAIN_TEXT);
  console.log('Firestore migration export created: ' + file.getUrl());
  return { ok: true, fileId: file.getId(), fileName: name, fileUrl: file.getUrl(), counts: exportCounts_(payload) };
}

function exportSheetAsObjects_(ss, candidateNames) {
  const sheet = candidateNames.map(name => ss.getSheetByName(name)).find(Boolean);
  if (!sheet) return [];
  const values = sheet.getDataRange().getDisplayValues();
  if (!values.length) return [];
  const headers = values[0].map((value, index) => normalizeHeader_(value, index));
  return values.slice(1).filter(row => row.some(value => String(value).trim() !== '')).map((row, rowIndex) => {
    const object = { _sourceSheet: sheet.getName(), _sourceRow: rowIndex + 2 };
    headers.forEach((header, index) => { object[header] = row[index] == null ? '' : row[index]; });
    return object;
  });
}

function normalizeHeader_(value, index) {
  const cleaned = String(value || '').trim().replace(/[^A-Za-z0-9]+(.)/g, (_, chr) => String(chr).toUpperCase());
  return cleaned || 'column' + (index + 1);
}

function validateExport_(payload) {
  if (!payload.spreadsheetId) throw new Error('Spreadsheet ID is missing.');
  if (!Array.isArray(payload.vans)) throw new Error('Vans export is invalid.');
  const duplicateVanIds = findDuplicates_(payload.vans.map(row => firstValue_(row, ['vanId', 'VanID', 'id', 'ID'])).filter(Boolean));
  if (duplicateVanIds.length) console.warn('Duplicate van IDs found: ' + duplicateVanIds.join(', '));
}

function firstValue_(object, keys) {
  for (let i = 0; i < keys.length; i++) {
    const value = object[keys[i]];
    if (value !== undefined && String(value).trim() !== '') return String(value).trim();
  }
  return '';
}

function findDuplicates_(values) {
  const seen = new Set();
  const duplicates = new Set();
  values.forEach(value => seen.has(value) ? duplicates.add(value) : seen.add(value));
  return Array.from(duplicates);
}

function exportCounts_(payload) {
  return {
    vans: payload.vans.length,
    spots: payload.spots.length,
    inspections: payload.inspections.length,
    users: payload.users.length,
    rescuesDjx3: payload.rescuesDjx3.length,
    rescuesDjx4: payload.rescuesDjx4.length
  };
}
