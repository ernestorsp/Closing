const VAN_DAMAGE_REASON_SYNC={
  externalSpreadsheetId:'1veZ6qMIoK58t2O2-SIiaD2bbOk0iwhcGI4hmo2uLF1Y',
  externalSheetName:'VAN_INFO',
  externalReasonColumn:6,
  externalVinColumn:11,
  closingVansSheet:'VANS',
  closingInspectionsSheet:'INSPECTIONS',
  closingDamagesSheet:'DAMAGES',
  timerHandler:'syncDamageReasonsToVanInfo'
};

function setupVanDamageReasonSync(){
  const external=SpreadsheetApp.openById(VAN_DAMAGE_REASON_SYNC.externalSpreadsheetId);
  if(!external.getSheetByName(VAN_DAMAGE_REASON_SYNC.externalSheetName))throw new Error('VAN_INFO was not found in DJX3 Spreadsheet ERSP.');
  const ss=db_();
  ['VANS','INSPECTIONS','DAMAGES'].forEach(name=>{if(!ss.getSheetByName(name))throw new Error(name+' was not found in CLOSING.')});
  ScriptApp.getProjectTriggers().forEach(trigger=>{
    if(trigger.getHandlerFunction()===VAN_DAMAGE_REASON_SYNC.timerHandler)ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger(VAN_DAMAGE_REASON_SYNC.timerHandler).timeBased().everyMinutes(1).create();
  const result=syncDamageReasonsToVanInfo();
  return 'Damage reason synchronization installed. '+result.updated+' VAN_INFO reasons updated.';
}

function syncDamageReasonsToVanInfo(){
  const lock=LockService.getScriptLock();
  if(!lock.tryLock(5000))return{updated:0,skipped:true};
  try{
    const ss=db_(),vans=readSheetObjectsForReason_(ss.getSheetByName(VAN_DAMAGE_REASON_SYNC.closingVansSheet)),inspections=readSheetObjectsForReason_(ss.getSheetByName(VAN_DAMAGE_REASON_SYNC.closingInspectionsSheet)),damages=readSheetObjectsForReason_(ss.getSheetByName(VAN_DAMAGE_REASON_SYNC.closingDamagesSheet));
    const activeEligible=new Set(vans.filter(v=>isReasonSyncActive_(v.Active)&&reasonSyncEligible_(v)).map(v=>reasonSyncVin_(v.VanID)));
    const inspectionToVan=new Map(inspections.map(i=>[String(i.InspectionID||''),reasonSyncVin_(i.VanID)]));
    const latestByVan=new Map();
    damages.forEach((damage,index)=>{
      const vanId=reasonSyncVin_(damage.VanID)||inspectionToVan.get(String(damage.InspectionID||''))||'';
      if(!vanId||!activeEligible.has(vanId))return;
      const comment=damageCommentForReason_(damage);
      if(!comment)return;
      const stamp=damageTimestampForReason_(damage,index),prior=latestByVan.get(vanId);
      if(!prior||stamp>=prior.stamp)latestByVan.set(vanId,{comment,stamp});
    });
    const sheet=SpreadsheetApp.openById(VAN_DAMAGE_REASON_SYNC.externalSpreadsheetId).getSheetByName(VAN_DAMAGE_REASON_SYNC.externalSheetName),lastRow=sheet.getLastRow();
    if(lastRow<2)return{updated:0};
    const rows=sheet.getRange(2,1,lastRow-1,VAN_DAMAGE_REASON_SYNC.externalVinColumn).getDisplayValues();
    let updated=0;
    rows.forEach((row,index)=>{
      const vin=reasonSyncVin_(row[VAN_DAMAGE_REASON_SYNC.externalVinColumn-1]);
      if(!vin||!latestByVan.has(vin))return;
      const reason=latestByVan.get(vin).comment,current=String(row[VAN_DAMAGE_REASON_SYNC.externalReasonColumn-1]||'').trim();
      if(current===reason)return;
      sheet.getRange(index+2,VAN_DAMAGE_REASON_SYNC.externalReasonColumn).setValue(reason);
      updated++;
    });
    return{updated};
  }finally{lock.releaseLock()}
}

function readSheetObjectsForReason_(sheet){
  if(!sheet||sheet.getLastRow()<2)return[];
  const values=sheet.getDataRange().getValues(),headers=values.shift().map(String);
  return values.filter(row=>row.some(value=>value!==''&&value!==null)).map(row=>headers.reduce((obj,key,index)=>(obj[key]=row[index],obj),{}));
}

function damageCommentForReason_(damage){
  const candidates=['DamageNotes','Notes','Comment','Comments','Description','Reason'];
  for(const key of candidates){
    const value=String(damage[key]||'').trim();
    if(value)return value;
  }
  return'';
}

function damageTimestampForReason_(damage,index){
  const candidates=['ReportedAt','CreatedAt','UpdatedAt','CapturedAt'];
  for(const key of candidates){
    const time=new Date(damage[key]||0).getTime();
    if(time)return time;
  }
  return index;
}

function reasonSyncEligible_(van){
  const home=String(van.HomeStation||'').trim().toUpperCase(),current=String(van.CurrentStation||'').trim().toUpperCase();
  return current==='DJX3'||(home==='DJX3'&&current==='SHOP');
}
function isReasonSyncActive_(value){return value===true||['TRUE','YES','1','ACTIVE'].includes(String(value||'').trim().toUpperCase())}
function reasonSyncVin_(value){return String(value||'').trim().toUpperCase()}
