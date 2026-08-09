import { FieldValue, Timestamp } from 'firebase-admin/firestore';
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
  const operational = vans.filter(van => van.CurrentStation !== 'SHOP' && (van.CurrentStatus || 'Operational') === 'Operational');
  const downed = vans.filter(van => van.CurrentStation !== 'SHOP' && van.CurrentStatus === 'Downed');
  const grounded = vans.filter(van => van.CurrentStation !== 'SHOP' && van.CurrentStatus === 'Grounded');
  const shop = vans.filter(van => van.CurrentStation === 'SHOP');
  const shownList = value => html(list(value));
  const metric = (label, value, color) => `<div style="display:inline-block;vertical-align:top;width:145px;min-height:78px;margin:0 8px 10px 0;padding:14px;box-sizing:border-box;border:1px solid #dce7ec;border-top:4px solid ${color};border-radius:10px;background:#ffffff"><div style="font-size:11px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:#6b7d87">${html(label)}</div><div style="margin-top:7px;font-size:25px;font-weight:800;color:#173f5f">${html(shown(value))}</div></div>`;
  const detail = (label, value, alreadyEscaped = false) => `<div style="padding:11px 0;border-bottom:1px solid #e7eef1"><div style="font-size:12px;font-weight:700;color:#687b86;text-transform:uppercase;letter-spacing:.35px">${html(label)}</div><div style="margin-top:4px;font-size:15px;font-weight:600;color:#18303f;line-height:1.45">${alreadyEscaped ? value : html(shown(value))}</div></div>`;
  const title = (heading, subtitle) => `<div style="margin:28px 0 12px"><div style="font-size:18px;font-weight:800;color:#173f5f">${html(heading)}</div>${subtitle ? `<div style="margin-top:3px;font-size:13px;color:#6b7d87">${html(subtitle)}</div>` : ''}</div>`;
  const empty = message => `<div style="padding:14px;border:1px dashed #c9d7de;border-radius:9px;background:#f8fbfc;color:#71818a;font-size:14px">${html(message)}</div>`;
  const vanChips = (rows, color, background) => rows.length
    ? `<div>${rows.map(van => `<span style="display:inline-block;margin:0 7px 7px 0;padding:8px 11px;border-radius:999px;background:${background};color:${color};font-size:13px;font-weight:800">${html(van.VanNumber || van.VanID)}</span>`).join('')}</div>`
    : empty('No vans in this category.');
  const rescueGroups = new Map();
  rescues.forEach(rescue => {
    const driver = shown(rescue.RescuerDriver);
    rescueGroups.set(driver, [...(rescueGroups.get(driver) || []), rescue]);
  });
  const rescueCards = rescues.length
    ? [...rescueGroups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([driver, rows]) => `<div style="margin-bottom:16px;overflow:hidden;border:1px solid #cbdde5;border-radius:12px;background:#ffffff"><div style="padding:14px 16px;background:#173f5f;color:#ffffff"><div style="font-size:10px;font-weight:800;letter-spacing:1.2px;text-transform:uppercase;color:#a9dce2">Rescue driver</div><div style="margin-top:4px;font-size:18px;font-weight:800">${html(driver)}</div></div><div style="padding:5px 16px 13px">${rows.map(rescue => `<div style="margin-top:10px;padding:12px;border-left:4px solid #1f9aaa;border-radius:8px;background:#f2f9fa"><div style="font-size:10px;font-weight:800;letter-spacing:.8px;text-transform:uppercase;color:#63808b">Driver rescued</div><div style="margin-top:3px;font-size:16px;font-weight:800;color:#18303f">${html(shown(rescue.RecipientDriver))}</div><div style="margin-top:8px"><span style="display:inline-block;margin-right:6px;padding:5px 8px;border-radius:999px;background:#e1f2f4;color:#176c78;font-size:12px;font-weight:800">${html(shown(rescue.Stops || 0))} stops</span><span style="display:inline-block;padding:5px 8px;border-radius:999px;background:#e8eef5;color:#365773;font-size:12px;font-weight:800">${html(shown(rescue.Packages || 0))} packages</span></div></div>`).join('')}</div></div>`).join('')
    : empty('No rescues recorded.');
  const lateLabel = station === 'DJX3' ? 'Driver RTS After 21:20' : 'Driver RTS After 20:00';
  const pickup = `${shown(record.PickupAll)}${record.PickupComment ? ` — ${record.PickupComment}` : ''}`;
  const warningBlock = warnings.length ? `<div style="margin-bottom:20px;padding:13px 15px;border-left:4px solid #d39b22;border-radius:8px;background:#fff7df;color:#6d542d;font-size:14px"><b>Sent with pending items:</b> ${html(warnings.join(', '))}</div>` : '';
  const receipts = station === 'DJX4' ? '' : detail('Drivers with Receipts', record.DriversWithReceipts);
  return `<!doctype html><html><body style="margin:0;padding:0;background:#eef3f6"><div style="margin:0;padding:24px 10px;background:#eef3f6;font-family:Arial,Helvetica,sans-serif;color:#18303f">
    <div style="max-width:760px;margin:0 auto;overflow:hidden;border:1px solid #d8e3e8;border-radius:16px;background:#ffffff;box-shadow:0 8px 28px rgba(23,63,95,.10)">
      <div style="padding:28px 30px;background:#173f5f;background:linear-gradient(135deg,#173f5f,#1f9aaa);color:#ffffff"><div style="font-size:12px;font-weight:800;letter-spacing:1.8px;text-transform:uppercase;opacity:.85">AAXI Operations</div><div style="margin-top:8px;font-size:28px;font-weight:800">Closing Report</div><div style="margin-top:8px;font-size:15px;opacity:.92">${html(station)} &nbsp;•&nbsp; ${html(date)}</div><div style="margin-top:9px;font-size:14px;font-weight:700;opacity:.96">Sent by: ${html(senderName || 'Unknown user')}</div></div>
      <div style="padding:28px 30px">${warningBlock}<p style="margin:0 0 8px;font-size:16px;line-height:1.55">Good afternoon, A&amp;A Express Management Team,</p><p style="margin:0;color:#62747e;line-height:1.55">Below is the completed closing summary for <b style="color:#18303f">${html(station)}</b>.</p>
        ${title('Tomorrow at a glance', 'Fleet readiness and planned routes')}<div>${metric('Operational', record.OperationalVans, '#16834b')}${metric('Downed', record.DownedVans, '#d08018')}${metric('Grounded', record.GroundedVans, '#bd2c2c')}${metric('Routes', record.RoutesTomorrow, '#1f9aaa')}</div>
        ${title('Closing details', 'End-of-day operational counts')}<div style="padding:4px 16px;border:1px solid #dce7ec;border-radius:10px;background:#fbfcfd">${detail('Pick up', pickup)}${detail('Phones', record.Phones)}${detail('Battery Packs', record.BatteryPacks)}${receipts}${detail('Returned Packages', record.ReturnedPackages)}${detail(lateLabel, shownList(record.LateRTSDrivers), true)}${detail('DVIC', shownList(record.DVICDrivers), true)}</div>
        ${title('Operational vans', 'Ready for service')}${vanChips(operational, '#126b3d', '#e5f5eb')}${title('Downed vans', 'Current fleet status')}${vanChips(downed, '#8a560d', '#fff0d2')}${title('Grounded vans', 'Current fleet status')}${vanChips(grounded, '#982020', '#ffe3e3')}${title(`${station} vans at SHOP`, 'Current workshop status')}${shop.length ? vanChips(shop, '#365773', '#e7eef5') : empty(`No ${station} vans are currently at SHOP.`)}
        ${title('Rescues', 'Completed rescue activity')}${rescueCards}${title('Closing notes', 'Management summary')}<div style="padding:18px;border-left:4px solid #1f9aaa;border-radius:8px;background:#f1f9fa;color:#334d59;font-size:15px;line-height:1.65;white-space:pre-wrap">${html(notes)}</div>
      </div><div style="padding:18px 30px;background:#173f5f;color:#cddbe2;font-size:12px;line-height:1.5">Generated automatically by AAXI Closing · ${html(station)}</div>
    </div></div></body></html>`;
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
    // Imported legacy notes may say "Sent" even though they were never delivered
    // through Resend. Only short-circuit when Resend returned a delivery ID.
    if (existing.exists && existing.get('Status') === 'Sent' && text(existing.get('DeliveryID'))) {
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
    const noteId = existing.get('NoteID') || crypto.randomUUID();
    let alreadySent = null;
    await db.runTransaction(async tx => {
      const latest = await tx.get(noteRef);
      if (latest.exists && latest.get('Status') === 'Sent' && text(latest.get('DeliveryID'))) {
        alreadySent = serialize(latest.data());
        return;
      }
      const leaseUntil = latest.get('EmailLeaseUntil')?.toMillis?.() || 0;
      if (latest.get('Status') === 'Sending' && leaseUntil > Date.now()) {
        throw apiError(409, 'EMAIL_ALREADY_SENDING', 'Closing notes email is already being sent.');
      }
      tx.set(noteRef, {
        Status: 'Sending',
        OperationID: operation.id,
        EmailLeaseUntil: Timestamp.fromMillis(Date.now() + 10 * 60 * 1000),
        UpdatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
    });
    if (alreadySent) {
      return { ok: true, alreadySent: true, record: alreadySent, message: 'Closing notes were already sent.' };
    }
    await noteRef.set({
      NoteKey: key,
      NoteID: noteId,
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
      WarningSummary: warnings.join(' | '),
      UpdatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    const attachments = await attachmentsFromPaths(bucket, photoPaths);
    const rescues = rescueSnap.exists && Array.isArray(rescueSnap.get('Rescues')) ? rescueSnap.get('Rescues') : [];
    const htmlBody = emailHtml({ station, date: displayDate, record, rescues, notes, warnings, senderName: actor.name || actor.email, vans: stationVans });
    let delivery;
    try {
      delivery = await mailer.send({
        to: recipients,
        subject,
        html: htmlBody,
        textBody: `${station} Closing Notes for ${displayDate}\n\n${notes}`,
        attachments,
        // One delivery per station and business day, even if the browser creates
        // a replacement operation after losing the first HTTP response.
        idempotencyKey: `closing-notes-${key}`
      });
    } catch (error) {
      await noteRef.set({
        Status: 'Failed',
        EmailLeaseUntil: FieldValue.delete(),
        LastEmailError: text(error?.message || error, 2000),
        UpdatedAt: FieldValue.serverTimestamp()
      }, { merge: true }).catch(() => {});
      throw error;
    }
    await noteRef.set({
      Status: 'Sent',
      SentAt: FieldValue.serverTimestamp(),
      DeliveryID: delivery.id || '',
      EmailLeaseUntil: FieldValue.delete(),
      LastEmailError: FieldValue.delete(),
      UpdatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    await auditWrite(db, actor, 'SEND_CLOSING_NOTES', 'CLOSING_NOTES', key, { recipients, warnings });
    const saved = await noteRef.get();
    return { ok: true, record: serialize(saved.data()), warnings, message: `Closing notes emailed to ${recipients.length} recipient${recipients.length === 1 ? '' : 's'}.` };
  };
}
