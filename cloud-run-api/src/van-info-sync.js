import { google } from 'googleapis';
import { FieldValue } from 'firebase-admin/firestore';

const DEFAULT_SPREADSHEET_ID =
  '1veZ6qMIoK58t2O2-SIiaD2bbOk0iwhcGI4hmo2uLF1Y';

const DEFAULT_SHEET_NAME = 'VAN_INFO';

function clean(value, max = 5000) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function upper(value, max = 5000) {
  return clean(value, max).toUpperCase();
}

function normalizeVin(value) {
  return upper(value, 100);
}

function normalizeVanNumber(value) {
  return upper(value, 100).replace(/^EDV\s*/, '').trim();
}

function normalizeStatus(value) {
  const v = clean(value, 50).toLowerCase();
  if (v === 'operational') return 'Operational';
  if (v === 'grounded') return 'Grounded';
  if (v === 'downed') return 'Downed';
  return '';
}

function normalizeSpot(value) {
  return upper(value, 100);
}

function normalizeBag(value) {
  return clean(value, 100);
}

function normalizeNote(value) {
  return clean(value, 5000);
}

function activeVan(van) {
  return van.Active !== false && van.active !== false;
}

function eligibleForVanInfo(van) {
  if (!activeVan(van)) return false;

  const home = upper(van.HomeStation || van.homeStation || '', 20);
  const current = upper(van.CurrentStation || van.currentStation || '', 20);

  // Rules:
  // - Any van currently at DJX3 is included, even if its home station is DJX4.
  // - DJX3-home vans at SHOP are included.
  // - DJX4 vans at DJX4 are excluded.
  // - DJX3-home vans currently at DJX4 are excluded.
  return current === 'DJX3' || (home === 'DJX3' && current === 'SHOP');
}

function firestoreState(van) {
  return {
    spot: normalizeSpot(van.CurrentStation === 'SHOP' ? 'SHOP' : van.CurrentSpot),
    bag: normalizeBag(van.BagNumber || van.Bag || ''),
    status: normalizeStatus(van.CurrentStatus || 'Operational') || 'Operational',
    note: normalizeNote(van.CurrentNote || van.Note || van.Reason || '')
  };
}

function sheetState(row) {
  return {
    spot: normalizeSpot(row[0]),
    bag: normalizeBag(row[2]),
    status: normalizeStatus(row[4]),
    note: normalizeNote(row[5])
  };
}

function equal(a, b) {
  return String(a ?? '') === String(b ?? '');
}

function resolveField({ fire, sheet, previousFire, previousSheet, initial }) {
  if (equal(fire, sheet)) {
    return { fire, sheet, action: 'none' };
  }

  // On first sync, preserve useful existing VAN_INFO data.
  if (initial) {
    if (sheet !== '' && sheet != null) {
      return { fire: sheet, sheet, action: 'sheet_to_fire' };
    }
    return { fire, sheet: fire, action: 'fire_to_sheet' };
  }

  const fireChanged = !equal(fire, previousFire);
  const sheetChanged = !equal(sheet, previousSheet);

  if (sheetChanged && !fireChanged) {
    return { fire: sheet, sheet, action: 'sheet_to_fire' };
  }

  // Firestore/app wins if both changed or a mismatch cannot be attributed.
  return { fire, sheet: fire, action: 'fire_to_sheet' };
}

async function commitFirestoreUpdates(db, updates) {
  const entries = [...updates.entries()];

  for (let offset = 0; offset < entries.length; offset += 400) {
    const batch = db.batch();

    for (const [docId, values] of entries.slice(offset, offset + 400)) {
      batch.set(
        db.collection('vans').doc(docId),
        {
          ...values,
          UpdatedAt: FieldValue.serverTimestamp(),
          VanInfoSyncedAt: FieldValue.serverTimestamp()
        },
        { merge: true }
      );
    }

    await batch.commit();
  }
}

export function createVanInfoSync({ db }) {
  const spreadsheetId =
    process.env.VAN_INFO_SPREADSHEET_ID || DEFAULT_SPREADSHEET_ID;

  const sheetName =
    process.env.VAN_INFO_SHEET_NAME || DEFAULT_SHEET_NAME;

  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });

  const sheets = google.sheets({ version: 'v4', auth });

  let running = false;

  async function run() {
    if (running) {
      return { ok: true, skipped: true, reason: 'SYNC_ALREADY_RUNNING' };
    }

    running = true;

    try {
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `'${sheetName}'!A2:K`
      });

      const sheetRows = response.data.values || [];

      const vanSnapshot = await db.collection('vans').get();

      const allVans = vanSnapshot.docs.map(doc => ({
        ...doc.data(),
        VanID: doc.data().VanID || doc.id,
        _documentId: doc.id
      }));

      const eligibleVans = allVans.filter(eligibleForVanInfo);

      const eligibleByVin = new Map();
      const eligibleByNumber = new Map();

      for (const van of eligibleVans) {
        const vin = normalizeVin(van.VanID || van._documentId);
        const number = normalizeVanNumber(van.VanNumber || '');

        if (vin && !eligibleByVin.has(vin)) {
          eligibleByVin.set(vin, van);
        }

        if (number && !eligibleByNumber.has(number)) {
          eligibleByNumber.set(number, van);
        }
      }

      const sheetByVin = new Map();
      const sheetByNumber = new Map();

      const duplicateVins = [];
      const duplicateNumbers = [];

      sheetRows.forEach((row, index) => {
        while (row.length < 11) row.push('');

        const rowNumber = index + 2;
        const vin = normalizeVin(row[10]);
        const number = normalizeVanNumber(row[1]);

        const record = {
          rowNumber,
          row,
          vin,
          number,
          state: sheetState(row)
        };

        if (vin) {
          if (!sheetByVin.has(vin)) {
            sheetByVin.set(vin, record);
          } else {
            duplicateVins.push({ vin, row: rowNumber });
          }
        }

        if (number) {
          if (!sheetByNumber.has(number)) {
            sheetByNumber.set(number, record);
          } else {
            duplicateNumbers.push({ number, row: rowNumber });
          }
        }
      });

      const metadataRef = db.collection('syncMetadata').doc('vanInfo');
      const metadataSnap = await metadataRef.get();

      const previous = metadataSnap.exists ? metadataSnap.data() : {};
      const previousFirestore = previous.firestore || {};
      const previousSheet = previous.sheet || {};
      const initial = !metadataSnap.exists || !previous.initialized;

      const appendRows = [];
      const identityUpdates = [];

      for (const [vin, van] of eligibleByVin.entries()) {
        const numberRaw = clean(van.VanNumber || '', 100);
        const number = normalizeVanNumber(numberRaw);

        let sheetRecord = sheetByVin.get(vin);

        // If VAN_INFO already has the same van number but blank VIN,
        // fill the VIN instead of appending a duplicate.
        if (!sheetRecord && number) {
          const numberRecord = sheetByNumber.get(number);

          if (numberRecord && !numberRecord.vin) {
            identityUpdates.push({
              range: `'${sheetName}'!K${numberRecord.rowNumber}`,
              values: [[vin]]
            });

            numberRecord.vin = vin;
            numberRecord.row[10] = vin;
            sheetByVin.set(vin, numberRecord);
            sheetRecord = numberRecord;
          }
        }

        if (sheetRecord) continue;

        const fire = firestoreState(van);
        const vanType = clean(van.VanType || van.Type || '', 100);

        const row = new Array(11).fill('');
        row[0] = fire.spot;      // A Spot
        row[1] = numberRaw;      // B Van Number
        row[2] = fire.bag;       // C Bag
        row[3] = vanType;        // D Size
        row[4] = fire.status;    // E Status
        row[5] = fire.note;      // F Reason / Note
        row[9] = vanType;        // J Type
        row[10] = vin;           // K VIN

        appendRows.push(row);

        sheetByVin.set(vin, {
          rowNumber: null,
          row,
          vin,
          number,
          state: sheetState(row),
          newlyAppended: true
        });

        if (number) {
          sheetByNumber.set(number, sheetByVin.get(vin));
        }
      }

      if (identityUpdates.length) {
        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId,
          requestBody: {
            valueInputOption: 'USER_ENTERED',
            data: identityUpdates
          }
        });
      }

      if (appendRows.length) {
        await sheets.spreadsheets.values.append({
          spreadsheetId,
          range: `'${sheetName}'!A:K`,
          valueInputOption: 'USER_ENTERED',
          insertDataOption: 'INSERT_ROWS',
          requestBody: { values: appendRows }
        });
      }

      const refreshedResponse = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `'${sheetName}'!A2:K`
      });

      const refreshedRows = refreshedResponse.data.values || [];
      const refreshedByVin = new Map();

      refreshedRows.forEach((row, index) => {
        while (row.length < 11) row.push('');

        const vin = normalizeVin(row[10]);

        if (vin && !refreshedByVin.has(vin)) {
          refreshedByVin.set(vin, {
            rowNumber: index + 2,
            row,
            state: sheetState(row)
          });
        }
      });

      const firestoreUpdates = new Map();
      const sheetUpdates = [];

      const nextFirestoreSnapshot = {};
      const nextSheetSnapshot = {};

      let sheetToFirestore = 0;
      let firestoreToSheet = 0;

      for (const [vin, van] of eligibleByVin.entries()) {
        const sheetRecord = refreshedByVin.get(vin);
        if (!sheetRecord) continue;

        const fire = firestoreState(van);
        const external = sheetRecord.state;

        const priorFire = previousFirestore[vin] || {};
        const priorSheet = previousSheet[vin] || {};

        const resolvedSpot = resolveField({
          fire: fire.spot,
          sheet: external.spot,
          previousFire: priorFire.spot,
          previousSheet: priorSheet.spot,
          initial
        });

        const resolvedBag = resolveField({
          fire: fire.bag,
          sheet: external.bag,
          previousFire: priorFire.bag,
          previousSheet: priorSheet.bag,
          initial
        });

        const resolvedStatus = resolveField({
          fire: fire.status,
          sheet: external.status,
          previousFire: priorFire.status,
          previousSheet: priorSheet.status,
          initial
        });

        const damageNotePending = van.VanInfoDamageNotePending === true;

        let resolvedNote;

        if (damageNotePending) {
          resolvedNote = {
            fire: fire.note,
            sheet: fire.note,
            action: equal(fire.note, external.note) ? 'none' : 'fire_to_sheet'
          };
        } else if (!equal(external.note, fire.note)) {
          resolvedNote = {
            fire: external.note,
            sheet: external.note,
            action: 'sheet_to_fire'
          };
        } else {
          resolvedNote = {
            fire: fire.note,
            sheet: external.note,
            action: 'none'
          };
        }

        const firePatch = {};

        if (resolvedSpot.action === 'sheet_to_fire') {
          firePatch.CurrentSpot = resolvedSpot.fire;
          sheetToFirestore++;
        }

        if (resolvedBag.action === 'sheet_to_fire') {
          firePatch.BagNumber = resolvedBag.fire;
          sheetToFirestore++;
        }

        if (
          resolvedStatus.action === 'sheet_to_fire' &&
          resolvedStatus.fire
        ) {
          firePatch.CurrentStatus = resolvedStatus.fire;
          sheetToFirestore++;
        }

        if (resolvedNote.action === 'sheet_to_fire') {
          firePatch.CurrentNote = resolvedNote.fire;
          firePatch.CurrentNoteSource = 'VAN_INFO';
          firePatch.VanInfoDamageNotePending = false;
          sheetToFirestore++;
        }

        if (Object.keys(firePatch).length) {
          firestoreUpdates.set(van._documentId || vin, firePatch);
        }

        if (resolvedSpot.action === 'fire_to_sheet') {
          sheetUpdates.push({
            range: `'${sheetName}'!A${sheetRecord.rowNumber}`,
            values: [[resolvedSpot.sheet]]
          });
          firestoreToSheet++;
        }

        if (resolvedBag.action === 'fire_to_sheet') {
          sheetUpdates.push({
            range: `'${sheetName}'!C${sheetRecord.rowNumber}`,
            values: [[resolvedBag.sheet]]
          });
          firestoreToSheet++;
        }

        if (resolvedStatus.action === 'fire_to_sheet') {
          sheetUpdates.push({
            range: `'${sheetName}'!E${sheetRecord.rowNumber}`,
            values: [[resolvedStatus.sheet]]
          });
          firestoreToSheet++;
        }

        if (resolvedNote.action === 'fire_to_sheet') {
          sheetUpdates.push({
            range: `'${sheetName}'!F${sheetRecord.rowNumber}`,
            values: [[resolvedNote.sheet]]
          });

          const currentPatch = firestoreUpdates.get(
            van._documentId || vin
          ) || {};

          currentPatch.VanInfoDamageNotePending = false;
          currentPatch.CurrentNoteSource = 'DAMAGE';

          firestoreUpdates.set(
            van._documentId || vin,
            currentPatch
          );
          firestoreToSheet++;
        }

        const desiredNumber = clean(van.VanNumber || '', 100);
        const desiredType = clean(van.VanType || van.Type || '', 100);

        if (clean(sheetRecord.row[1]) !== desiredNumber) {
          sheetUpdates.push({
            range: `'${sheetName}'!B${sheetRecord.rowNumber}`,
            values: [[desiredNumber]]
          });
        }

        if (clean(sheetRecord.row[3]) !== desiredType) {
          sheetUpdates.push({
            range: `'${sheetName}'!D${sheetRecord.rowNumber}`,
            values: [[desiredType]]
          });
        }

        if (clean(sheetRecord.row[9]) !== desiredType) {
          sheetUpdates.push({
            range: `'${sheetName}'!J${sheetRecord.rowNumber}`,
            values: [[desiredType]]
          });
        }

        if (normalizeVin(sheetRecord.row[10]) !== vin) {
          sheetUpdates.push({
            range: `'${sheetName}'!K${sheetRecord.rowNumber}`,
            values: [[vin]]
          });
        }

        nextFirestoreSnapshot[vin] = {
          spot: resolvedSpot.fire,
          bag: resolvedBag.fire,
          status: resolvedStatus.fire,
          note: resolvedNote.fire
        };

        nextSheetSnapshot[vin] = {
          spot: resolvedSpot.sheet,
          bag: resolvedBag.sheet,
          status: resolvedStatus.sheet,
          note: resolvedNote.sheet
        };
      }

      if (firestoreUpdates.size) {
        await commitFirestoreUpdates(db, firestoreUpdates);
      }

      if (sheetUpdates.length) {
        for (let offset = 0; offset < sheetUpdates.length; offset += 400) {
          await sheets.spreadsheets.values.batchUpdate({
            spreadsheetId,
            requestBody: {
              valueInputOption: 'USER_ENTERED',
              data: sheetUpdates.slice(offset, offset + 400)
            }
          });
        }
      }

      await metadataRef.set(
        {
          initialized: true,
          firestore: nextFirestoreSnapshot,
          sheet: nextSheetSnapshot,
          spreadsheetId,
          sheetName,
          eligibleVanCount: eligibleVans.length,
          duplicateVins,
          duplicateNumbers,
          lastResult: {
            added: appendRows.length,
            vinFilled: identityUpdates.length,
            sheetToFirestore,
            firestoreToSheet
          },
          LastSyncAt: FieldValue.serverTimestamp()
        },
        { merge: true }
      );

      return {
        ok: true,
        eligible: eligibleVans.length,
        added: appendRows.length,
        vinFilled: identityUpdates.length,
        sheetToFirestore,
        firestoreToSheet,
        duplicateVins: duplicateVins.length,
        duplicateNumbers: duplicateNumbers.length
      };

    } finally {
      running = false;
    }
  }

  return { run };
}
