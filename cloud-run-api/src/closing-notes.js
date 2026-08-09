import { FieldValue } from 'firebase-admin/firestore';
import { apiError, dateKey, isYes, serialize, text, todayKey, vanHomeStation } from './domain.js';
import { auditWrite, getCollection, getWhere, keyForDay } from './firestore-helpers.js';

function html(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function shown(value) {
  return value === 0 || value === '0' ? String(value) : String(value || 'N/A');
}

function list(value) {
  const values = String(value || '').split('|').map(item => item.trim()).filter(Boolean);
  return values.length ? values.join(', ') : 'N/A';
}

function emailHtml({ station, date, record, rescues, notes, warnings, senderName, vans }) {
  const operational = vans.filter(van =>
    van.CurrentStation !== 'SHOP' &&
    (van.CurrentStatus || 'Operational') === 'Operational'
  );

  const downed = vans.filter(van =>
    van.CurrentStation !== 'SHOP' &&
    van.CurrentStatus === 'Downed'
  );

  const grounded = vans.filter(van =>
    van.CurrentStation !== 'SHOP' &&
    van.CurrentStatus === 'Grounded'
  );

  const shop = vans.filter(van =>
    van.CurrentStation === 'SHOP'
  );

  const vanLabel = van => {
    const number = html(van.VanNumber || van.VanID || 'N/A');
    const note = html(
      van.CurrentNote ||
      van.Note ||
      van.Reason ||
      ''
    );

    return note
      ? `${number} (${note})`
      : number;
  };

  const pills = (rows, background, color) => {
    if (!rows.length) {
      return `
        <div style="
          border:1px dashed #cbd7df;
          border-radius:8px;
          padding:14px;
          color:#667b89;
          font-size:13px;
          background:#fbfcfd;
        ">No vans in this category.</div>`;
    }

    return rows.map(row => `
      <span style="
        display:inline-block;
        margin:0 5px 6px 0;
        padding:7px 11px;
        border-radius:18px;
        background:${background};
        color:${color};
        font-size:12px;
        line-height:16px;
        font-weight:700;
      ">${vanLabel(row)}</span>
    `).join('');
  };

  const rescueContent = rescues.length
    ? rescues.map(row => `
        <tr>
          <td style="padding:8px 10px;border-bottom:1px solid #e6edf1;font-size:12px;">
            ${html(row.RescuerDriver || 'N/A')}
          </td>
          <td style="padding:8px 10px;border-bottom:1px solid #e6edf1;font-size:12px;">
            ${html(row.RecipientDriver || 'N/A')}
          </td>
          <td style="padding:8px 10px;border-bottom:1px solid #e6edf1;font-size:12px;text-align:center;">
            ${html(shown(row.Stops))}
          </td>
          <td style="padding:8px 10px;border-bottom:1px solid #e6edf1;font-size:12px;text-align:center;">
            ${html(shown(row.Packages))}
          </td>
        </tr>
      `).join('')
    : `
      <tr>
        <td colspan="4" style="
          padding:15px;
          color:#6b7f8b;
          font-size:12px;
          text-align:left;
        ">No rescues recorded.</td>
      </tr>`;

  const detailRow = (icon, label, value, iconColor = '#1683c4') => `
    <tr>
      <td style="
        width:30px;
        padding:10px 4px 10px 12px;
        border-bottom:1px solid #e4ebef;
        color:${iconColor};
        font-size:16px;
        vertical-align:middle;
      ">${icon}</td>

      <td style="
        padding:10px 8px;
        border-bottom:1px solid #e4ebef;
        color:#173f5f;
        font-size:12px;
        font-weight:700;
        text-transform:uppercase;
        vertical-align:middle;
      ">${label}</td>

      <td style="
        padding:10px 12px 10px 8px;
        border-bottom:1px solid #e4ebef;
        color:#102a43;
        font-size:12px;
        font-weight:700;
        text-align:right;
        vertical-align:middle;
      ">${html(shown(value))}</td>
    </tr>
  `;

  const receiptRow = station === 'DJX4'
    ? ''
    : detailRow(
        '▣',
        'Drivers with receipts',
        record.DriversWithReceipts,
        '#12a1b4'
      );

  const warningHtml = warnings.length
    ? `
      <div style="
        margin:0 0 18px 0;
        padding:12px 14px;
        border-left:4px solid #e4a11b;
        background:#fff8e5;
        color:#604700;
        font-size:12px;
        line-height:18px;
        border-radius:4px;
      ">
        <strong>Pending items:</strong>
        ${html(warnings.join(', '))}
      </div>`
    : '';

  const routes = shown(record.RoutesTomorrow);
  const operationalCount = shown(record.OperationalVans);
  const downedCount = shown(record.DownedVans);
  const groundedCount = shown(record.GroundedVans);

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
</head>

<body style="
  margin:0;
  padding:0;
  background:#edf3f6;
  font-family:Arial,Helvetica,sans-serif;
  color:#102a43;
">

<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"
       style="width:100%;background:#edf3f6;margin:0;padding:0;">
<tr>
<td align="center" style="padding:22px 10px;">

<table role="presentation" width="900" cellspacing="0" cellpadding="0" border="0"
       style="
         width:100%;
         max-width:900px;
         background:#ffffff;
         border:1px solid #d8e3e9;
         border-radius:14px;
         overflow:hidden;
       ">

  <!-- TOP NAVY BAR -->
  <tr>
    <td style="
      padding:15px 28px;
      background:#062f5d;
      color:#ffffff;
      font-size:12px;
      font-weight:700;
      letter-spacing:1.5px;
    ">
      AAXI OPERATIONS
    </td>

    <td align="right" style="
      padding:15px 28px;
      background:#062f5d;
      color:#ffffff;
      font-size:12px;
    ">
      ${html(station)} &nbsp;•&nbsp; ${html(date)}
    </td>
  </tr>

  <!-- TITLE -->
  <tr>
    <td colspan="2" style="padding:24px 30px 8px 30px;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
        <tr>

          <td style="vertical-align:middle;">
            <div style="
              color:#062f5d;
              font-size:30px;
              line-height:34px;
              font-weight:800;
              letter-spacing:.5px;
              text-transform:uppercase;
            ">
              Closing Report
            </div>

            <div style="
              margin-top:8px;
              color:#405b6b;
              font-size:13px;
            ">
              Sent by:
              <strong style="color:#062f5d;">
                ${html(senderName)}
              </strong>
            </div>
          </td>

          <td align="right" style="vertical-align:middle;">
            <div style="
              color:#1683c4;
              font-size:38px;
              line-height:38px;
              font-weight:900;
              letter-spacing:-2px;
            ">
              A&amp;A
            </div>

            <div style="
              color:#1683c4;
              font-size:11px;
              line-height:12px;
              font-weight:700;
              letter-spacing:6px;
              padding-left:6px;
            ">
              EXPRESS
            </div>
          </td>

        </tr>
      </table>

      <div style="
        margin-top:16px;
        border-top:2px solid #d8edf8;
      "></div>
    </td>
  </tr>

  <!-- GREETING -->
  <tr>
    <td colspan="2" style="
      padding:8px 30px 18px 30px;
      color:#263e4c;
      font-size:13px;
      line-height:20px;
    ">
      Good afternoon,
      <span style="color:#c83232;">A&amp;A Express Management Team,</span>
      <br>
      Below is the completed closing summary for
      <strong>${html(station)}</strong>.
    </td>
  </tr>

  <tr>
    <td colspan="2" style="padding:0 28px 18px 28px;">
      ${warningHtml}

      <!-- TOMORROW AT A GLANCE -->
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"
             style="
               border:1px solid #d8e3e9;
               border-radius:10px;
               overflow:hidden;
             ">
        <tr>
          <td colspan="4" style="padding:15px 16px 10px 16px;">
            <div style="
              color:#062f5d;
              font-size:16px;
              font-weight:800;
              text-transform:uppercase;
            ">
              📅 &nbsp; Tomorrow at a glance
            </div>
            <div style="
              color:#657b88;
              font-size:11px;
              margin-top:3px;
            ">
              Fleet readiness and planned routes
            </div>
          </td>
        </tr>

        <tr>

          <td width="25%" style="padding:8px 7px 15px 15px;">
            <div style="
              border:1px solid #c9ead6;
              background:#fbfffc;
              border-radius:10px;
              padding:16px;
            ">
              <div style="
                color:#148342;
                font-size:10px;
                font-weight:800;
                text-transform:uppercase;
              ">
                🚚 &nbsp; Operational
              </div>
              <div style="
                color:#062f5d;
                font-size:25px;
                font-weight:800;
                margin-top:7px;
              ">
                ${html(operationalCount)}
              </div>
            </div>
          </td>

          <td width="25%" style="padding:8px 7px 15px 7px;">
            <div style="
              border:1px solid #f3d5a8;
              background:#fffdfa;
              border-radius:10px;
              padding:16px;
            ">
              <div style="
                color:#d47a00;
                font-size:10px;
                font-weight:800;
                text-transform:uppercase;
              ">
                🔧 &nbsp; Downed
              </div>
              <div style="
                color:#062f5d;
                font-size:25px;
                font-weight:800;
                margin-top:7px;
              ">
                ${html(downedCount)}
              </div>
            </div>
          </td>

          <td width="25%" style="padding:8px 7px 15px 7px;">
            <div style="
              border:1px solid #f1c6c6;
              background:#fffafa;
              border-radius:10px;
              padding:16px;
            ">
              <div style="
                color:#c92c2c;
                font-size:10px;
                font-weight:800;
                text-transform:uppercase;
              ">
                ⚠ &nbsp; Grounded
              </div>
              <div style="
                color:#062f5d;
                font-size:25px;
                font-weight:800;
                margin-top:7px;
              ">
                ${html(groundedCount)}
              </div>
            </div>
          </td>

          <td width="25%" style="padding:8px 15px 15px 7px;">
            <div style="
              border:1px solid #c7dfef;
              background:#fbfdff;
              border-radius:10px;
              padding:16px;
            ">
              <div style="
                color:#1483c4;
                font-size:10px;
                font-weight:800;
                text-transform:uppercase;
              ">
                ⤴ &nbsp; Routes
              </div>
              <div style="
                color:#062f5d;
                font-size:25px;
                font-weight:800;
                margin-top:7px;
              ">
                ${html(routes)}
              </div>
            </div>
          </td>

        </tr>
      </table>

    </td>
  </tr>

  <!-- CLOSING DETAILS -->
  <tr>
    <td colspan="2" style="padding:0 28px 18px 28px;">

      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"
             style="
               border:1px solid #d8e3e9;
               border-radius:10px;
               overflow:hidden;
             ">

        <tr>
          <td colspan="2" style="padding:15px 16px 10px 16px;">
            <div style="
              color:#062f5d;
              font-size:16px;
              font-weight:800;
              text-transform:uppercase;
            ">
              ☑ &nbsp; Closing details
            </div>

            <div style="
              color:#657b88;
              font-size:11px;
              margin-top:3px;
            ">
              End-of-day operational counts
            </div>
          </td>
        </tr>

        <tr>

          <!-- LEFT DETAILS -->
          <td width="43%" valign="top" style="padding:8px 8px 15px 15px;">

            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"
                   style="
                     border:1px solid #e1e9ed;
                     border-radius:8px;
                     overflow:hidden;
                   ">

              ${detailRow('✓', 'Pick up', record.PickupAll, '#15995b')}
              ${detailRow('☎', 'Phones', record.Phones, '#7d43c7')}
              ${detailRow('▣', 'Battery packs', record.BatteryPacks, '#ed8c14')}
              ${receiptRow}
              ${detailRow('◇', 'Returned packages', record.ReturnedPackages, '#1683c4')}

            </table>

          </td>

          <!-- RIGHT DETAILS -->
          <td width="57%" valign="top" style="padding:8px 15px 15px 8px;">

            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"
                   style="
                     border:1px solid #e1e9ed;
                     border-radius:8px;
                     overflow:hidden;
                   ">

              <tr>
                <td style="padding:12px 14px;border-bottom:1px solid #e4ebef;">
                  <div style="
                    color:#173f5f;
                    font-size:11px;
                    font-weight:800;
                    text-transform:uppercase;
                  ">
                    ◷ &nbsp; Driver RTS after ${
                      station === 'DJX3' ? '21:20' : '20:00'
                    }
                  </div>

                  <div style="
                    color:#1b303c;
                    font-size:12px;
                    line-height:18px;
                    margin-top:7px;
                  ">
                    ${html(list(record.LateRTSDrivers))}
                  </div>
                </td>
              </tr>

              <tr>
                <td style="padding:12px 14px;">
                  <div style="
                    color:#173f5f;
                    font-size:11px;
                    font-weight:800;
                    text-transform:uppercase;
                  ">
                    👤 &nbsp; DVIC
                  </div>

                  <div style="
                    color:#1b303c;
                    font-size:12px;
                    line-height:18px;
                    margin-top:7px;
                  ">
                    ${html(list(record.DVICDrivers))}
                  </div>
                </td>
              </tr>

            </table>

          </td>
        </tr>

      </table>

    </td>
  </tr>

  <!-- FLEET TWO COLUMNS -->
  <tr>
    <td colspan="2" style="padding:0 28px 18px 28px;">

      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
        <tr>

          <!-- OPERATIONAL -->
          <td width="61%" valign="top" style="padding-right:8px;">
            <div style="
              border:1px solid #d8e3e9;
              border-radius:10px;
              padding:15px;
              min-height:230px;
            ">
              <div style="
                color:#062f5d;
                font-size:15px;
                font-weight:800;
                text-transform:uppercase;
              ">
                🚚 &nbsp; Operational vans
              </div>

              <div style="
                color:#657b88;
                font-size:11px;
                margin:3px 0 12px 0;
              ">
                Ready for service
              </div>

              ${pills(operational, '#e6f6ec', '#087638')}
            </div>
          </td>

          <!-- DOWNED + GROUNDED -->
          <td width="39%" valign="top" style="padding-left:8px;">

            <div style="
              border:1px solid #d8e3e9;
              border-radius:10px;
              padding:15px;
              margin-bottom:12px;
            ">
              <div style="
                color:#062f5f;
                font-size:15px;
                font-weight:800;
                text-transform:uppercase;
              ">
                🚑 &nbsp; Downed vans
              </div>

              <div style="
                color:#657b88;
                font-size:11px;
                margin:3px 0 12px 0;
              ">
                Recorded notes
              </div>

              ${pills(downed, '#fff0e8', '#b64b14')}
            </div>

            <div style="
              border:1px solid #d8e3e9;
              border-radius:10px;
              padding:15px;
            ">
              <div style="
                color:#062f5f;
                font-size:15px;
                font-weight:800;
                text-transform:uppercase;
              ">
                ⚠ &nbsp; Grounded vans
              </div>

              <div style="
                color:#657b88;
                font-size:11px;
                margin:3px 0 12px 0;
              ">
                Recorded notes
              </div>

              ${pills(grounded, '#ffe8e8', '#ad1e1e')}
            </div>

          </td>

        </tr>
      </table>

    </td>
  </tr>

  <!-- SHOP / RESCUES / NOTES -->
  <tr>
    <td colspan="2" style="padding:0 28px 25px 28px;">

      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
        <tr>

          <!-- SHOP -->
          <td width="35%" valign="top" style="padding-right:7px;">
            <div style="
              border:1px solid #d8e3e9;
              border-radius:10px;
              padding:15px;
              min-height:245px;
            ">
              <div style="
                color:#062f5f;
                font-size:14px;
                font-weight:800;
                text-transform:uppercase;
              ">
                🔧 &nbsp; ${html(station)} vans at SHOP
              </div>

              <div style="
                color:#657b88;
                font-size:11px;
                margin:3px 0 12px 0;
              ">
                Current workshop status
              </div>

              ${pills(shop, '#eee8fb', '#57329a')}
            </div>
          </td>

          <!-- RESCUES -->
          <td width="31%" valign="top" style="padding:0 7px;">
            <div style="
              border:1px solid #d8e3e9;
              border-radius:10px;
              padding:15px;
              min-height:245px;
            ">
              <div style="
                color:#062f5f;
                font-size:14px;
                font-weight:800;
                text-transform:uppercase;
              ">
                🛡 &nbsp; Rescues
              </div>

              <div style="
                color:#657b88;
                font-size:11px;
                margin:3px 0 12px 0;
              ">
                Completed rescue activity
              </div>

              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"
                     style="
                       border:1px solid #e1e9ed;
                       border-radius:7px;
                       overflow:hidden;
                     ">

                <tr style="background:#f6f9fb;">
                  <th style="padding:7px;font-size:10px;text-align:left;color:#46606f;">RESCUER</th>
                  <th style="padding:7px;font-size:10px;text-align:left;color:#46606f;">DRIVER</th>
                  <th style="padding:7px;font-size:10px;color:#46606f;">STOPS</th>
                  <th style="padding:7px;font-size:10px;color:#46606f;">PKGS</th>
                </tr>

                ${rescueContent}

              </table>
            </div>
          </td>

          <!-- NOTES -->
          <td width="34%" valign="top" style="padding-left:7px;">
            <div style="
              border:1px solid #d8e3e9;
              border-radius:10px;
              padding:15px;
              min-height:245px;
            ">
              <div style="
                color:#062f5f;
                font-size:14px;
                font-weight:800;
                text-transform:uppercase;
              ">
                💬 &nbsp; Closing notes
              </div>

              <div style="
                color:#657b88;
                font-size:11px;
                margin:3px 0 12px 0;
              ">
                Management summary
              </div>

              <div style="
                background:#eef8fb;
                border-left:4px solid #16a0b8;
                border-radius:7px;
                padding:13px;
                color:#294754;
                font-size:12px;
                line-height:18px;
                white-space:pre-wrap;
              ">${html(notes)}</div>
            </div>
          </td>

        </tr>
      </table>

    </td>
  </tr>

  <!-- FOOTER -->
  <tr>
    <td colspan="2" align="center" style="
      padding:15px;
      background:#062f5d;
      color:#ffffff;
      font-size:10px;
    ">
      Generated automatically by AAXI Closing
      &nbsp;•&nbsp;
      ${html(station)}
    </td>
  </tr>

</table>

</td>
</tr>
</table>

</body>
</html>`;
}

async function attachmentsFromPaths(bucket, paths) {
  const output = [];
  for (const path of paths.slice(0, 6)) {
    const file = bucket.file(path);
    const [exists] = await file.exists();
    if (!exists) continue;
    const [metadata] = await file.getMetadata();
    if (!String(metadata.contentType || '').startsWith('image/')) continue;
    const [bytes] = await file.download();
    output.push({
      filename: path.split('/').pop() || 'closing-photo.jpg',
      content: bytes.toString('base64')
    });
  }
  return output;
}

export function createClosingNotesSender({ db, bucket, mailer }) {
  return async function sendClosingNotes({ req, operation, payload, actor }) {
    const station = operation.station;
    const date = dateKey(operation.day || todayKey());
    const key = keyForDay(station, date);
    const noteRef = db.collection('closingNotes').doc(key);
    const existing = await noteRef.get();
    if (existing.exists && existing.get('Status') === 'Sent') {
      return { ok: true, alreadySent: true, record: serialize(existing.data()), message: 'Closing notes were already sent.' };
    }
    const notes = text(payload.notes, 10000);
    if (!notes) throw apiError(400, 'NOTES_REQUIRED', 'Write the closing notes before sending.');
    const [closingSnap, rescueSnap, vans, inspections, skipSnap] = await Promise.all([
      db.collection('closingDays').doc(key).get(),
      db.collection('rescueDays').doc(key).get(),
      getCollection(db, 'vans', 2500),
      getWhere(db, 'inspections', 'InspectionDate', '==', date, 1500),
      db.collection('inspectionSkipRequests').doc(key).get()
    ]);
    const stationVans = vans.filter(van => van.Active !== false && vanHomeStation(van) === station);
    const completedIds = new Set(inspections.filter(row => row.InspectionState === 'Completed' && (row.WorkingStation || row.Station) === station).map(row => String(row.VanID)));
    const warnings = [];
    if (!stationVans.every(van => completedIds.has(String(van.VanID))) && skipSnap.get('Status') !== 'Approved') warnings.push('vans without a completed inspection');
    if (!rescueSnap.exists || rescueSnap.get('Finalized') !== true) warnings.push('Rescue not finalized');
    if (!closingSnap.exists) warnings.push('Closing data not saved');
    if (warnings.length && payload.force !== true) throw apiError(409, 'PENDING_CONFIRMATION', warnings.join(', '), { warnings });
    const counts = { Operational: 0, Downed: 0, Grounded: 0 };
    stationVans.forEach(van => {
      const status = van.CurrentStation === 'SHOP' ? 'Grounded' : (van.CurrentStatus || 'Operational');
      if (Object.hasOwn(counts, status)) counts[status] += 1;
    });
    const record = closingSnap.exists ? serialize(closingSnap.data()) : {
      RecordDate: date,
      OperationalVans: counts.Operational,
      DownedVans: counts.Downed,
      GroundedVans: counts.Grounded,
      RoutesTomorrow: 'N/A',
      PickupAll: 'N/A',
      Phones: 'N/A',
      BatteryPacks: 'N/A',
      DriversWithReceipts: 'N/A',
      ReturnedPackages: 'N/A',
      LateRTSDrivers: 'N/A',
      DVICDrivers: 'N/A'
    };
    const photoPaths = Array.isArray(payload.photoPaths) ? payload.photoPaths.map(path => text(path, 700)).filter(path => path.startsWith(`closing-notes/${date}/${station}/`)).slice(0, 6) : [];
    const config = await db.collection('system').doc('config').get();
    const recipients = mailer.recipients(config.get('CLOSING_EMAIL_RECIPIENTS') || actor.email);
    const displayDate = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'long', month: '2-digit', day: '2-digit', year: 'numeric' }).format(new Date(`${date}T12:00:00-04:00`));
    const subject = `${station} - Closing Notes - ${displayDate}`;
    await noteRef.set({
      NoteKey: key,
      NoteID: existing.get('NoteID') || crypto.randomUUID(),
      NoteDate: date,
      Station: station,
      Notes: notes,
      PhotoStoragePaths: photoPaths,
      PhotoCount: photoPaths.length,
      EmailRecipients: recipients.join(', '),
      EmailSubject: subject,
      SentByEmail: actor.email,
      SentByName: actor.name,
      SentByUid: actor.uid,
      Status: 'Sending',
      OperationID: operation.id,
      WarningSummary: warnings.join(' | '),
      UpdatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    const attachments = await attachmentsFromPaths(bucket, photoPaths);
    const rescues = rescueSnap.exists && Array.isArray(rescueSnap.get('Rescues')) ? rescueSnap.get('Rescues') : [];
    const htmlBody = emailHtml({ station, date: displayDate, record, rescues, notes, warnings, senderName: actor.name || actor.email, vans: stationVans });
    const delivery = await mailer.send({
      to: recipients,
      subject,
      html: htmlBody,
      textBody: `${station} Closing Notes for ${displayDate}\n\n${notes}`,
      attachments,
      idempotencyKey: `closing-notes-${operation.id}`
    });
    await noteRef.set({ Status: 'Sent', SentAt: FieldValue.serverTimestamp(), DeliveryID: delivery.id || '', UpdatedAt: FieldValue.serverTimestamp() }, { merge: true });
    await auditWrite(db, actor, 'SEND_CLOSING_NOTES', 'CLOSING_NOTES', key, { recipients, warnings });
    const saved = await noteRef.get();
    return { ok: true, record: serialize(saved.data()), warnings, message: `Closing notes emailed to ${recipients.length} recipient${recipients.length === 1 ? '' : 's'}.` };
  };
}
