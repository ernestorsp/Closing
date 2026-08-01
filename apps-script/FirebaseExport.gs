function exportClosingDataForFirestore() {
  const ss = SpreadsheetApp.getActive();
  const payload = {
    version: 1,
    spreadsheetId: ss.getId(),
    exportedAt: new Date().toISOString(),
    vans: firebaseExportSheet_(ss, ['VANS', 'Vans', 'VAN_INFO']),
    spots: firebaseExportSheet_(ss, ['SPOTS', 'Spots']),
    inspections: [],
    users: []
  };
  const name = 'closing-firestore-export-' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd-HHmmss') + '.json';
  const file = DriveApp.createFile(name, JSON.stringify(payload, null, 2), MimeType.PLAIN_TEXT);
  console.log(file.getUrl());
  return { ok: true, fileId: file.getId(), fileName: name, fileUrl: file.getUrl(), vans: payload.vans.length, spots: payload.spots.length };
}

function firebaseExportSheet_(ss, candidateNames) {
  const sheet = candidateNames.map(name => ss.getSheetByName(name)).find(Boolean);
  if (!sheet) return [];
  const values = sheet.getDataRange().getDisplayValues();
  if (!values.length) return [];
  const headers = values[0].map((value, index) => firebaseExportHeader_(value, index));
  return values.slice(1).filter(row => row.some(value => String(value).trim() !== '')).map((row, rowIndex) => {
    const result = { _sourceSheet: sheet.getName(), _sourceRow: rowIndex + 2 };
    headers.forEach((header, index) => result[header] = row[index] == null ? '' : row[index]);
    return result;
  });
}

function firebaseExportHeader_(value, index) {
  const raw = String(value || '').trim();
  if (!raw) return 'column' + (index + 1);
  return raw.replace(/[^A-Za-z0-9]+(.)/g, (_, chr) => String(chr).toUpperCase()).replace(/^[A-Z]/, chr => chr.toLowerCase());
}
