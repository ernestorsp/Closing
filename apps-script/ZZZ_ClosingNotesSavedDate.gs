// Closing Notes date override.
// Uses the date stored in DAILY_CLOSING instead of the clock date when the email is sent.
function sendClosingNotes(token,input){
  const s=auth_(token);
  return lock_(()=>{
    const ss=db_(),u=user_(s.email),station=workingStation_(u);
    ensureClosingSheets_(ss);
    const ready=closingReadiness_(ss,station);
    if(!ready.allReady)throw new Error('All closing checklist items must be Ready before sending notes.');
    const notes=String(input&&input.notes||'').trim();
    if(!notes)throw new Error('Write the closing notes before sending.');

    // The email/report date must come from the Closing record that was saved,
    // not from new Date()/day_() at the moment the email is sent.
    const savedClosings=rowsTail_(ss.getSheetByName(APP.SHEETS.closingData),500)
      .filter(x=>String(x.Station)===station)
      .sort((a,b)=>String(b.SavedAt||'').localeCompare(String(a.SavedAt||'')));
    const requestedDate=String(input&&input.date||'').trim();
    let data=requestedDate?closingRecord_(ss,requestedDate,station):null;
    if(!data)data=savedClosings[0]||null;
    if(!data)throw new Error('Save Closing data first.');
    const date=storedDay_(data.RecordDate)||String(data.RecordKey||'').split('_')[0]||day_();
    const key=date+'_'+station;

    const recipients=closingEmailRecipients_(ss,s.email),
      photos=saveClosingNotePhotos_(input&&input.photos,station,date),
      rescues=rescueData_(ss,station).rescues.filter(x=>x.Status==='Saved'),
      fleet=fleetEmailData_(ss,station),
      photoBaseUrl=ScriptApp.getService().getUrl();
    if(!photoBaseUrl)throw new Error('Deploy the project as a Web App before sending Closing Notes.');
    fleet.defects.forEach(v=>v.defects.forEach(d=>{d.photoViewUrl=d.photoFileId?photoBaseUrl+'?closingPhoto='+encodeURIComponent(closingPhotoToken_(d.photoFileId)):''}));

    const reportDate=new Date(date+'T12:00:00'),
      displayDate=Utilities.formatDate(reportDate,'America/New_York','EEEE, MM-dd-yyyy'),
      subject=station+' - Closing Notes - '+displayDate,
      htmlBody=closingEmailHtml_(station,displayDate,data,rescues,notes,photos.length,fleet,u.Name||s.email);
    if(MailApp.getRemainingDailyQuota()<recipients.length)throw new Error('Not enough email quota remains to send Closing Notes today.');
    MailApp.sendEmail({to:recipients.join(','),subject,body:station+' Closing Notes for '+displayDate+'\n\n'+notes,htmlBody,attachments:photos.map(x=>x.blob),name:(u.Name||'AAXI Closing')+' · '+s.email,replyTo:s.email});

    const existing=closingNote_(ss,date,station),record={NoteKey:key,NoteID:(existing||{}).NoteID||Utilities.getUuid(),NoteDate:date,Station:station,Notes:notes,PhotoFileIDs:photos.map(x=>x.file.getId()).join(' | '),PhotoFileURLs:photos.map(x=>x.file.getUrl()).join(' | '),PhotoCount:photos.length,EmailRecipients:recipients.join(', '),EmailSubject:subject,SentAt:new Date(),SentByEmail:s.email,SentByName:u.Name};
    upsertObject_(ss.getSheetByName(APP.SHEETS.closingNotes),'NoteKey',key,record);
    audit_(s.email,'SEND_CLOSING_NOTES','CLOSING_NOTES',key,station+' -> '+recipients.join(', '));
    return{ok:true,record,message:'Closing notes emailed to '+recipients.length+' recipient'+(recipients.length===1?'':'s')+'.'};
  });
}
