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
  const receipts = station === 'DJX4' ? '' : `<tr><td>Drivers with receipts</td><td>${html(shown(record.DriversWithReceipts))}</td></tr>`;
  const operational = vans.filter(van => van.CurrentStation !== 'SHOP' && (van.CurrentStatus || 'Operational') === 'Operational');
  const downed = vans.filter(van => van.CurrentStation !== 'SHOP' && van.CurrentStatus === 'Downed');
  const grounded = vans.filter(van => van.CurrentStation === 'SHOP' || van.CurrentStatus === 'Grounded');
  const vanLine = rows => rows.length ? rows.map(row => html(row.VanNumber || row.VanID)).join(', ') : 'N/A';
  const rescueRows = rescues.length
    ? rescues.map(row => `<tr><td>${html(row.RescuerDriver)}</td><td>${html(row.RecipientDriver)}</td><td>${html(row.Stops)}</td><td>${html(row.Packages)}</td></tr>`).join('')
    : '<tr><td colspan="4">N/A</td></tr>';
  return `<!doctype html><html><body style="margin:0;background:#eef3f6;font-family:Arial,sans-serif;color:#18303f">
    <div style="max-width:760px;margin:24px auto;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #d8e3e8">
      <div style="padding:28px 30px;background:#173f5f;color:#fff"><div style="font-size:12px;letter-spacing:1.6px">AAXI OPERATIONS</div><h1 style="margin:8px 0">Closing Report</h1><div>${html(station)} · ${html(date)}</div><div style="margin-top:8px">Sent by: ${html(senderName)}</div></div>
      <div style="padding:28px 30px">
        ${warnings.length ? `<div style="padding:12px;background:#fff7df;border-left:4px solid #d39b22">Sent with pending items: ${html(warnings.join(', '))}</div>` : ''}
        <h2>Closing details</h2>
        <table style="width:100%;border-collapse:collapse"><tbody>
          <tr><td>Operational vans</td><td>${html(shown(record.OperationalVans))}</td></tr>
          <tr><td>Downed vans</td><td>${html(shown(record.DownedVans))}</td></tr>
          <tr><td>Grounded vans</td><td>${html(shown(record.GroundedVans))}</td></tr>
          <tr><td>Routes tomorrow</td><td>${html(shown(record.RoutesTomorrow))}</td></tr>
          <tr><td>Pick up</td><td>${html(shown(record.PickupAll))}</td></tr>
          <tr><td>Phones</td><td>${html(shown(record.Phones))}</td></tr>
          <tr><td>Battery packs</td><td>${html(shown(record.BatteryPacks))}</td></tr>
          ${receipts}
          <tr><td>Returned packages</td><td>${html(shown(record.ReturnedPackages))}</td></tr>
          <tr><td>Driver RTS</td><td>${html(list(record.LateRTSDrivers))}</td></tr>
          <tr><td>DVIC</td><td>${html(list(record.DVICDrivers))}</td></tr>
        </tbody></table>
        <h2>Fleet</h2><p><b>Operational:</b> ${vanLine(operational)}</p><p><b>Downed:</b> ${vanLine(downed)}</p><p><b>Grounded / SHOP:</b> ${vanLine(grounded)}</p>
        <h2>Rescues</h2><table style="width:100%;border-collapse:collapse"><thead><tr><th>Rescue driver</th><th>Driver rescued</th><th>Stops</th><th>Packages</th></tr></thead><tbody>${rescueRows}</tbody></table>
        <h2>Closing notes</h2><div style="white-space:pre-wrap;padding:16px;background:#f1f9fa;border-left:4px solid #1f9aaa">${html(notes)}</div>
      </div>
    </div></body></html>`;
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
