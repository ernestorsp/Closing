// Synchronize VAN_INFO column F (reason/note) with the CLOSING VANS CurrentNote field.
// This file is intentionally independent from the older status/bag sync so it can
// be installed without changing the existing DJX3/DJX4/SHOP eligibility rules.

const VAN_INFO_REASON_BRIDGE={
  externalSpreadsheetId:'1veZ6qMIoK58t2O2-SIiaD2bbOk0iwhcGI4hmo2uLF1Y',
  externalSheetName:'VAN_INFO',
  externalReasonColumn:6,
  externalVinColumn:11,
  closingSheetName:'VANS',
  closingVinHeader:'VanID',
  closingReasonHeader:'CurrentNote',
  closingHomeHeader:'HomeStation',
  closingCurrentHeader:'CurrentStation',
  closingActiveHeader:'Active',
  snapshotProperty:'VAN_INFO_REASON_BRIDGE_V1',
  timerHandler:'syncVanInfoReasonsBidirectional'
};

function setupVanInfoReasonBridge(){
  const external=SpreadsheetApp.openById(VAN_INFO_REASON_BRIDGE.externalSpreadsheetId);
  if(!external.getSheetByName(VAN_INFO_REASON_BRIDGE.externalSheetName))throw new Error('VAN_INFO was not found.');
  const vans=db_().getSheetByName(VAN_INFO_REASON_BRIDGE.closingSheetName);
  if(!vans)throw new Error('VANS was not found in CLOSING.');
  ensureClosingReasonColumn_(vans);
  ScriptApp.getProjectTriggers().forEach(trigger=>{
    if(trigger.getHandlerFunction()===VAN_INFO_REASON_BRIDGE.timerHandler)ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger(VAN_INFO_REASON_BRIDGE.timerHandler).timeBased().everyMinutes(1).create();
  const result=syncVanInfoReasonsBidirectional();
  return 'VAN_INFO reason synchronization installed. '+result.toClosing+' imported, '+result.toVanInfo+' exported.';
}

function syncVanInfoReasonsBidirectional(){
  const lock=LockService.getScriptLock();
  if(!lock.tryLock(5000))return{toClosing:0,toVanInfo:0,skipped:true};
  try{
    const vansSheet=db_().getSheetByName(VAN_INFO_REASON_BRIDGE.closingSheetName);
    ensureClosingReasonColumn_(vansSheet);
    const closing=readClosingReasonState_(vansSheet);
    const externalSheet=SpreadsheetApp.openById(VAN_INFO_REASON_BRIDGE.externalSpreadsheetId).getSheetByName(VAN_INFO_REASON_BRIDGE.externalSheetName);
    const vanInfo=readVanInfoReasonState_(externalSheet);
    const previous=loadReasonBridgeSnapshot_();
    let toClosing=0,toVanInfo=0;

    Object.keys(closing).forEach(vin=>{
      const c=closing[vin],v=vanInfo[vin];
      if(!v||!reasonBridgeEligible_(c))return;
      if(c.note===v.note)return;
      const pc=previous.closing[vin]||'',pv=previous.vanInfo[vin]||'';
      const closingChanged=c.note!==pc,vanInfoChanged=v.note!==pv;
      if(vanInfoChanged&&!closingChanged){
        vansSheet.getRange(c.row,c.noteColumn).setValue(v.note);
        toClosing++;
      }else{
        externalSheet.getRange(v.row,VAN_INFO_REASON_BRIDGE.externalReasonColumn).setValue(c.note);
        toVanInfo++;
      }
    });

    saveReasonBridgeSnapshot_();
    return{toClosing,toVanInfo};
  }finally{lock.releaseLock()}
}

function ensureClosingReasonColumn_(sheet){
  const lastColumn=Math.max(1,sheet.getLastColumn());
  const headers=sheet.getRange(1,1,1,lastColumn).getDisplayValues()[0].map(String);
  let index=headers.indexOf(VAN_INFO_REASON_BRIDGE.closingReasonHeader);
  if(index>=0)return index+1;
  const column=lastColumn+1;
  sheet.getRange(1,column).setValue(VAN_INFO_REASON_BRIDGE.closingReasonHeader);
  return column;
}

function readClosingReasonState_(sheet){
  const values=sheet.getDataRange().getDisplayValues();
  const headers=(values[0]||[]).map(String);
  const vinColumn=headers.indexOf(VAN_INFO_REASON_BRIDGE.closingVinHeader)+1;
  const noteColumn=headers.indexOf(VAN_INFO_REASON_BRIDGE.closingReasonHeader)+1;
  const homeColumn=headers.indexOf(VAN_INFO_REASON_BRIDGE.closingHomeHeader)+1;
  const currentColumn=headers.indexOf(VAN_INFO_REASON_BRIDGE.closingCurrentHeader)+1;
  const activeColumn=headers.indexOf(VAN_INFO_REASON_BRIDGE.closingActiveHeader)+1;
  if(!vinColumn||!noteColumn||!homeColumn||!currentColumn)throw new Error('VANS is missing required reason synchronization columns.');
  const state={};
  values.slice(1).forEach((row,index)=>{
    const vin=reasonBridgeVin_(row[vinColumn-1]);
    if(!vin)return;
    state[vin]={
      row:index+2,
      noteColumn,
      note:String(row[noteColumn-1]||'').trim(),
      home:String(row[homeColumn-1]||'').trim().toUpperCase(),
      current:String(row[currentColumn-1]||'').trim().toUpperCase(),
      active:!activeColumn||reasonBridgeActive_(row[activeColumn-1])
    };
  });
  return state;
}

function readVanInfoReasonState_(sheet){
  const state={},lastRow=sheet.getLastRow();
  if(lastRow<2)return state;
  sheet.getRange(2,1,lastRow-1,VAN_INFO_REASON_BRIDGE.externalVinColumn).getDisplayValues().forEach((row,index)=>{
    const vin=reasonBridgeVin_(row[VAN_INFO_REASON_BRIDGE.externalVinColumn-1]);
    if(!vin)return;
    state[vin]={row:index+2,note:String(row[VAN_INFO_REASON_BRIDGE.externalReasonColumn-1]||'').trim()};
  });
  return state;
}

function reasonBridgeEligible_(van){
  if(!van.active)return false;
  return van.current==='DJX3'||(van.home==='DJX3'&&van.current==='SHOP');
}

function loadReasonBridgeSnapshot_(){
  const raw=PropertiesService.getScriptProperties().getProperty(VAN_INFO_REASON_BRIDGE.snapshotProperty);
  if(!raw)return{closing:{},vanInfo:{}};
  try{return JSON.parse(raw)}catch(_error){return{closing:{},vanInfo:{}}}
}

function saveReasonBridgeSnapshot_(){
  const vansSheet=db_().getSheetByName(VAN_INFO_REASON_BRIDGE.closingSheetName);
  const closing=readClosingReasonState_(vansSheet),externalSheet=SpreadsheetApp.openById(VAN_INFO_REASON_BRIDGE.externalSpreadsheetId).getSheetByName(VAN_INFO_REASON_BRIDGE.externalSheetName),vanInfo=readVanInfoReasonState_(externalSheet),compact={closing:{},vanInfo:{}};
  Object.keys(closing).forEach(vin=>compact.closing[vin]=closing[vin].note);
  Object.keys(vanInfo).forEach(vin=>compact.vanInfo[vin]=vanInfo[vin].note);
  PropertiesService.getScriptProperties().setProperty(VAN_INFO_REASON_BRIDGE.snapshotProperty,JSON.stringify(compact));
  return compact;
}

function reasonBridgeVin_(value){return String(value||'').trim().toUpperCase()}
function reasonBridgeActive_(value){return value===true||['TRUE','YES','1','ACTIVE'].includes(String(value||'').trim().toUpperCase())}
