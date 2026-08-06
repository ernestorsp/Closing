function exportClosingDataForFirestore() {
  const ss = SpreadsheetApp.getActive();

  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),

    vans: exportSheet_(ss, "VANS"),
    spots: exportSheet_(ss, "SPOTS")
  };

  const file = DriveApp.createFile(
    "closing-firestore-export.json",
    JSON.stringify(payload, null, 2),
    MimeType.PLAIN_TEXT
  );

  Logger.log(file.getUrl());

  SpreadsheetApp.getUi().alert(
    "Archivo creado correctamente:\n\n" + file.getUrl()
  );
}

function exportSheet_(ss, name) {
  const sh = ss.getSheetByName(name);
  if (!sh) return [];

  const values = sh.getDataRange().getValues();
  if (values.length < 2) return [];

  const headers = values[0];

  return values.slice(1).map(r => {
    const obj = {};
    headers.forEach((h, i) => obj[h] = r[i]);
    return obj;
  });
}