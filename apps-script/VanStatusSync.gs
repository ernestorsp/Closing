const VAN_STATUS_SYNC={
  externalSpreadsheetId:'1veZ6qMIoK58t2O2-SIiaD2bbOk0iwhcGI4hmo2uLF1Y',
  externalSheetName:'VAN_INFO',
  externalStatusColumn:5,
  externalVinColumn:11,
  closingSheetName:'VANS',
  closingVinHeader:'VanID',
  closingStatusHeader:'CurrentStatus',
  closingUpdatedHeader:'UpdatedAt',
  snapshotProperty:'VAN_STATUS_SYNC_SNAPSHOT_V1',
  editHandler:'handleVanInfoStatusEdit',
  timerHandler:'syncVanStatuses'
};

function setupVanStatusSync(){
  const external=SpreadsheetApp.openById(VAN_STATUS_SYNC.externalSpreadsheetId);
  const sheet=external.getSheetByName(VAN_STATUS_SYNC.externalSheetName);
  if(!sheet)throw new Error('VAN_INFO was not found in DJX3 Spreadsheet ERSP.');
  const closing=db_(),vans=closing.getSheetByName(VAN_STATUS_SYNC.closingSheetName);
  if(!vans)throw new Error('VANS was not found in CLOSING.');
  removeVanStatusSyncTriggers_();
  ScriptApp.newTrigger(VAN_STATUS_SYNC.editHandler).forSpreadsheet(external).onEdit().create();
  ScriptApp.newTrigger(VAN_STATUS_SYNC.timerHandler).timeBased().everyMinutes(1).create();
  const initial=syncVanInfoToClosing_();
  saveVanStatusSnapshot_();
  return 'Van status synchronization installed. '+initial.updated+' CLOSING status values were initialized from VAN_INFO.';
}

function removeVanStatusSyncTriggers_(){
  const handlers=[VAN_STATUS_SYNC.editHandler,VAN_STATUS_SYNC.timerHandler];
  ScriptApp.getProjectTriggers().forEach(trigger=>{
    if(handlers.includes(trigger.getHandlerFunction()))ScriptApp.deleteTrigger(trigger);
  });
}

function handleVanInfoStatusEdit(e){
  if(!e||!e.range||!e.source)return;
  if(String(e.source.getId())!==VAN_STATUS_SYNC.externalSpreadsheetId)return;
  const range=e.range,sheet=range.getSheet();
  if(sheet.getName()!==VAN_STATUS_SYNC.externalSheetName)return;
  const firstColumn=range.getColumn(),lastColumn=range.getLastColumn();
  if(VAN_STATUS_SYNC.externalStatusColumn<firstColumn||VAN_STATUS_SYNC.externalStatusColumn>lastColumn)return;
  const firstRow=Math.max(2,range.getRow()),lastRow=range.getLastRow();
  if(lastRow<2)return;
  const count=lastRow-firstRow+1;
  const values=sheet.getRange(firstRow,1,count,Math.max(VAN_STATUS_SYNC.externalVinColumn,VAN_STATUS_SYNC.externalStatusColumn)).getDisplayValues();
  const changes=[];
  values.forEach((row,index)=>{
    const vin=normalizeVanStatusVin_(row[VAN_STATUS_SYNC.externalVinColumn-1]);
    const status=normalizeVanStatus_(row[VAN_STATUS_SYNC.externalStatusColumn-1]);
    if(vin&&status)changes.push({vin,status,row:firstRow+index});
  });
  if(!changes.length)return;
  const result=writeStatusesToClosing_(changes);
  saveVanStatusSnapshot_();
  console.log('VAN_INFO status edit synchronized: '+result.updated+' updated, '+result.missing+' VINs not found.');
}

function syncVanStatuses(){
  const lock=LockService.getScriptLock();
  if(!lock.tryLock(5000))return;
  try{
    const current=readVanStatusState_(),previous=loadVanStatusSnapshot_(),toClosing=[],toVanInfo=[];
    Object.keys(current.closing).forEach(vin=>{
      if(!current.vanInfo[vin])return;
      const closingStatus=current.closing[vin].status,vanInfoStatus=current.vanInfo[vin].status;
      if(closingStatus===vanInfoStatus)return;
      const oldClosing=previous.closing[vin],oldVanInfo=previous.vanInfo[vin];
      const closingChanged=!oldClosing||closingStatus!==oldClosing;
      const vanInfoChanged=!oldVanInfo||vanInfoStatus!==oldVanInfo;
      if(vanInfoChanged&&!closingChanged)toClosing.push({vin,status:vanInfoStatus});
      else toVanInfo.push({vin,status:closingStatus});
    });
    if(toClosing.length)writeStatusesToClosing_(toClosing);
    if(toVanInfo.length)writeStatusesToVanInfo_(toVanInfo);
    saveVanStatusSnapshot_();
  }finally{lock.releaseLock()}
}

function syncVanInfoToClosing_(){
  const state=readVanStatusState_(),changes=[];
  Object.keys(state.vanInfo).forEach(vin=>{
    if(state.closing[vin]&&state.closing[vin].status!==state.vanInfo[vin].status)changes.push({vin,status:state.vanInfo[vin].status});
  });
  return writeStatusesToClosing_(changes);
}

function readVanStatusState_(){
  const closingSheet=db_().getSheetByName(VAN_STATUS_SYNC.closingSheetName);
  if(!closingSheet)throw new Error('VANS was not found in CLOSING.');
  const closingValues=closingSheet.getDataRange().getDisplayValues(),closingHeaders=(closingValues[0]||[]).map(String);
  const vinIndex=closingHeaders.indexOf(VAN_STATUS_SYNC.closingVinHeader),statusIndex=closingHeaders.indexOf(VAN_STATUS_SYNC.closingStatusHeader);
  if(vinIndex<0||statusIndex<0)throw new Error('VANS must contain VanID and CurrentStatus.');
  const closing={};
  closingValues.slice(1).forEach((row,index)=>{
    const vin=normalizeVanStatusVin_(row[vinIndex]),status=normalizeVanStatus_(row[statusIndex]);
    if(vin&&status)closing[vin]={status,row:index+2};
  });
  const externalSheet=SpreadsheetApp.openById(VAN_STATUS_SYNC.externalSpreadsheetId).getSheetByName(VAN_STATUS_SYNC.externalSheetName);
  if(!externalSheet)throw new Error('VAN_INFO was not found in DJX3 Spreadsheet ERSP.');
  const lastRow=externalSheet.getLastRow(),vanInfo={};
  if(lastRow>1){
    const values=externalSheet.getRange(2,1,lastRow-1,Math.max(VAN_STATUS_SYNC.externalVinColumn,VAN_STATUS_SYNC.externalStatusColumn)).getDisplayValues();
    values.forEach((row,index)=>{
      const vin=normalizeVanStatusVin_(row[VAN_STATUS_SYNC.externalVinColumn-1]),status=normalizeVanStatus_(row[VAN_STATUS_SYNC.externalStatusColumn-1]);
      if(vin&&status)vanInfo[vin]={status,row:index+2};
    });
  }
  return{closing,vanInfo};
}

function writeStatusesToClosing_(changes){
  if(!changes.length)return{updated:0,missing:0};
  const sheet=db_().getSheetByName(VAN_STATUS_SYNC.closingSheetName),values=sheet.getDataRange().getValues(),headers=values[0].map(String);
  const vinIndex=headers.indexOf(VAN_STATUS_SYNC.closingVinHeader),statusIndex=headers.indexOf(VAN_STATUS_SYNC.closingStatusHeader),updatedIndex=headers.indexOf(VAN_STATUS_SYNC.closingUpdatedHeader);
  if(vinIndex<0||statusIndex<0)throw new Error('VANS must contain VanID and CurrentStatus.');
  const rowByVin=new Map();
  values.slice(1).forEach((row,index)=>rowByVin.set(normalizeVanStatusVin_(row[vinIndex]),index+2));
  let updated=0,missing=0;
  changes.forEach(change=>{
    const row=rowByVin.get(normalizeVanStatusVin_(change.vin)),status=normalizeVanStatus_(change.status);
    if(!row){missing++;return}
    if(!status)return;
    sheet.getRange(row,statusIndex+1).setValue(status);
    if(updatedIndex>=0)sheet.getRange(row,updatedIndex+1).setValue(new Date());
    updated++;
  });
  CacheService.getScriptCache().removeAll([]);
  return{updated,missing};
}

function writeStatusesToVanInfo_(changes){
  if(!changes.length)return{updated:0,missing:0};
  const sheet=SpreadsheetApp.openById(VAN_STATUS_SYNC.externalSpreadsheetId).getSheetByName(VAN_STATUS_SYNC.externalSheetName),lastRow=sheet.getLastRow();
  if(lastRow<2)return{updated:0,missing:changes.length};
  const vins=sheet.getRange(2,VAN_STATUS_SYNC.externalVinColumn,lastRow-1,1).getDisplayValues(),rowByVin=new Map();
  vins.forEach((row,index)=>rowByVin.set(normalizeVanStatusVin_(row[0]),index+2));
  let updated=0,missing=0;
  changes.forEach(change=>{
    const row=rowByVin.get(normalizeVanStatusVin_(change.vin)),status=normalizeVanStatus_(change.status);
    if(!row){missing++;return}
    if(!status)return;
    sheet.getRange(row,VAN_STATUS_SYNC.externalStatusColumn).setValue(status);
    updated++;
  });
  return{updated,missing};
}

function loadVanStatusSnapshot_(){
  const raw=PropertiesService.getScriptProperties().getProperty(VAN_STATUS_SYNC.snapshotProperty);
  if(!raw)return{closing:{},vanInfo:{}};
  try{return JSON.parse(raw)}catch(e){return{closing:{},vanInfo:{}}}
}

function saveVanStatusSnapshot_(){
  const state=readVanStatusState_(),compact={closing:{},vanInfo:{}};
  Object.keys(state.closing).forEach(vin=>compact.closing[vin]=state.closing[vin].status);
  Object.keys(state.vanInfo).forEach(vin=>compact.vanInfo[vin]=state.vanInfo[vin].status);
  PropertiesService.getScriptProperties().setProperty(VAN_STATUS_SYNC.snapshotProperty,JSON.stringify(compact));
  return compact;
}

function normalizeVanStatus_(value){
  const normalized=String(value||'').trim().toLowerCase();
  if(normalized==='operational')return'Operational';
  if(normalized==='grounded')return'Grounded';
  if(normalized==='downed')return'Downed';
  return'';
}

function normalizeVanStatusVin_(value){return String(value||'').trim().toUpperCase()}
