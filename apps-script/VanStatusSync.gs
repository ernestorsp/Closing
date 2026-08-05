const VAN_INFO_SYNC={
  externalSpreadsheetId:'1veZ6qMIoK58t2O2-SIiaD2bbOk0iwhcGI4hmo2uLF1Y',
  externalSheetName:'VAN_INFO',
  externalParkSpotColumn:1,
  externalVanNumberColumn:2,
  externalBagColumn:3,
  externalSizeColumn:4,
  externalStatusColumn:5,
  externalReasonColumn:6,
  externalTypeColumn:10,
  externalVinColumn:11,
  closingSheetName:'VANS',
  closingVinHeader:'VanID',
  closingVanNumberHeader:'VanNumber',
  closingTypeHeader:'VanType',
  closingBagHeader:'BagNumber',
  closingStatusHeader:'CurrentStatus',
  closingHomeStationHeader:'HomeStation',
  closingCurrentStationHeader:'CurrentStation',
  closingActiveHeader:'Active',
  closingUpdatedHeader:'UpdatedAt',
  snapshotProperty:'VAN_INFO_SYNC_SNAPSHOT_V3',
  editHandler:'handleVanInfoEdit',
  timerHandler:'syncVanInfoAndClosing'
};

function setupVanStatusSync(){return setupVanInfoSync()}

function setupVanInfoSync(){
  const external=SpreadsheetApp.openById(VAN_INFO_SYNC.externalSpreadsheetId);
  if(!external.getSheetByName(VAN_INFO_SYNC.externalSheetName))throw new Error('VAN_INFO was not found in DJX3 Spreadsheet ERSP.');
  if(!db_().getSheetByName(VAN_INFO_SYNC.closingSheetName))throw new Error('VANS was not found in CLOSING.');
  removeVanInfoSyncTriggers_();
  ScriptApp.newTrigger(VAN_INFO_SYNC.editHandler).forSpreadsheet(external).onEdit().create();
  ScriptApp.newTrigger(VAN_INFO_SYNC.timerHandler).timeBased().everyMinutes(1).create();
  const added=ensureDjx3VansInVanInfo_();
  const initial=syncVanInfoToClosing_();
  saveVanInfoSnapshot_();
  return 'VAN_INFO synchronization installed. '+added.added+' DJX3 vans added and '+initial.updated+' CLOSING rows initialized from VAN_INFO.';
}

function removeVanInfoSyncTriggers_(){
  const handlers=[VAN_INFO_SYNC.editHandler,VAN_INFO_SYNC.timerHandler,'handleVanInfoStatusEdit','syncVanStatuses'];
  ScriptApp.getProjectTriggers().forEach(trigger=>{
    if(handlers.includes(trigger.getHandlerFunction()))ScriptApp.deleteTrigger(trigger);
  });
}

function handleVanInfoEdit(e){
  if(!e||!e.range||!e.source)return;
  if(String(e.source.getId())!==VAN_INFO_SYNC.externalSpreadsheetId)return;
  const range=e.range,sheet=range.getSheet();
  if(sheet.getName()!==VAN_INFO_SYNC.externalSheetName)return;
  const firstColumn=range.getColumn(),lastColumn=range.getLastColumn();
  const touchesBag=VAN_INFO_SYNC.externalBagColumn>=firstColumn&&VAN_INFO_SYNC.externalBagColumn<=lastColumn;
  const touchesStatus=VAN_INFO_SYNC.externalStatusColumn>=firstColumn&&VAN_INFO_SYNC.externalStatusColumn<=lastColumn;
  if(!touchesBag&&!touchesStatus)return;
  const firstRow=Math.max(2,range.getRow()),lastRow=range.getLastRow();
  if(lastRow<2)return;
  const count=lastRow-firstRow+1,width=VAN_INFO_SYNC.externalVinColumn;
  const values=sheet.getRange(firstRow,1,count,width).getDisplayValues(),changes=[];
  values.forEach(row=>{
    const vin=normalizeVanInfoVin_(row[VAN_INFO_SYNC.externalVinColumn-1]);
    if(!vin)return;
    const change={vin};
    if(touchesBag)change.bag=normalizeVanInfoBag_(row[VAN_INFO_SYNC.externalBagColumn-1]);
    if(touchesStatus)change.status=normalizeVanInfoStatus_(row[VAN_INFO_SYNC.externalStatusColumn-1]);
    changes.push(change);
  });
  if(changes.length)writeVanInfoFieldsToClosing_(changes);
  saveVanInfoSnapshot_();
}

function handleVanInfoStatusEdit(e){return handleVanInfoEdit(e)}
function syncVanStatuses(){return syncVanInfoAndClosing()}

function syncVanInfoAndClosing(){
  const lock=LockService.getScriptLock();
  if(!lock.tryLock(5000))return;
  try{
    ensureDjx3VansInVanInfo_();
    const current=readVanInfoSyncState_(),previous=loadVanInfoSnapshot_(),toClosing=[],toVanInfo=[];
    Object.keys(current.closing).forEach(vin=>{
      if(!current.vanInfo[vin])return;
      const c=current.closing[vin],v=current.vanInfo[vin],pc=previous.closing[vin]||{},pv=previous.vanInfo[vin]||{};
      const closingChange={},vanInfoChange={};
      if(c.status!==v.status){
        const closingChanged=c.status!==pc.status,vanInfoChanged=v.status!==pv.status;
        if(vanInfoChanged&&!closingChanged)closingChange.status=v.status;else vanInfoChange.status=c.status;
      }
      if(c.bag!==v.bag){
        const closingChanged=c.bag!==pc.bag,vanInfoChanged=v.bag!==pv.bag;
        if(vanInfoChanged&&!closingChanged)closingChange.bag=v.bag;else vanInfoChange.bag=c.bag;
      }
      if(Object.keys(closingChange).length)toClosing.push({vin,...closingChange});
      if(Object.keys(vanInfoChange).length)toVanInfo.push({vin,...vanInfoChange});
    });
    if(toClosing.length)writeVanInfoFieldsToClosing_(toClosing);
    if(toVanInfo.length)writeClosingFieldsToVanInfo_(toVanInfo);
    saveVanInfoSnapshot_();
  }finally{lock.releaseLock()}
}

function ensureDjx3VansInVanInfo_(){
  const closingSheet=db_().getSheetByName(VAN_INFO_SYNC.closingSheetName);
  const values=closingSheet.getDataRange().getDisplayValues(),headers=(values[0]||[]).map(String);
  const indexes=closingHeaderIndexes_(headers);
  const externalSheet=SpreadsheetApp.openById(VAN_INFO_SYNC.externalSpreadsheetId).getSheetByName(VAN_INFO_SYNC.externalSheetName);
  const existing=new Set();
  if(externalSheet.getLastRow()>1){
    externalSheet.getRange(2,VAN_INFO_SYNC.externalVinColumn,externalSheet.getLastRow()-1,1).getDisplayValues().forEach(row=>{
      const vin=normalizeVanInfoVin_(row[0]);if(vin)existing.add(vin);
    });
  }
  const rows=[];
  values.slice(1).forEach(row=>{
    const vin=normalizeVanInfoVin_(row[indexes.vin]);
    const home=String(row[indexes.home]||'').trim().toUpperCase();
    const current=String(row[indexes.current]||'').trim().toUpperCase();
    const active=indexes.active<0||isVanInfoActive_(row[indexes.active]);
    const shouldBeInVanInfo=current==='DJX3'||(home==='DJX3'&&current==='SHOP');
    if(!vin||!active||!shouldBeInVanInfo||existing.has(vin))return;
    const output=new Array(VAN_INFO_SYNC.externalVinColumn).fill('');
    output[VAN_INFO_SYNC.externalVanNumberColumn-1]=String(row[indexes.number]||'').trim();
    output[VAN_INFO_SYNC.externalBagColumn-1]=normalizeVanInfoBag_(row[indexes.bag]);
    output[VAN_INFO_SYNC.externalSizeColumn-1]=String(row[indexes.type]||'').trim();
    output[VAN_INFO_SYNC.externalStatusColumn-1]=normalizeVanInfoStatus_(row[indexes.status])||'Operational';
    output[VAN_INFO_SYNC.externalTypeColumn-1]=String(row[indexes.type]||'').trim();
    output[VAN_INFO_SYNC.externalVinColumn-1]=vin;
    rows.push(output);existing.add(vin);
  });
  if(rows.length){
    const start=externalSheet.getLastRow()+1;
    externalSheet.getRange(start,1,rows.length,VAN_INFO_SYNC.externalVinColumn).setValues(rows);
  }
  return{added:rows.length};
}

function syncVanInfoToClosing_(){
  const state=readVanInfoSyncState_(),changes=[];
  Object.keys(state.vanInfo).forEach(vin=>{
    if(!state.closing[vin])return;
    const source=state.vanInfo[vin],target=state.closing[vin],change={vin};
    if(source.status!==target.status)change.status=source.status;
    if(source.bag!==target.bag)change.bag=source.bag;
    if(Object.keys(change).length>1)changes.push(change);
  });
  return writeVanInfoFieldsToClosing_(changes);
}

function readVanInfoSyncState_(){
  const closingSheet=db_().getSheetByName(VAN_INFO_SYNC.closingSheetName);
  const closingValues=closingSheet.getDataRange().getDisplayValues(),headers=(closingValues[0]||[]).map(String),indexes=closingHeaderIndexes_(headers),closing={};
  closingValues.slice(1).forEach((row,index)=>{
    const vin=normalizeVanInfoVin_(row[indexes.vin]);
    if(vin)closing[vin]={bag:normalizeVanInfoBag_(row[indexes.bag]),status:normalizeVanInfoStatus_(row[indexes.status]),row:index+2};
  });
  const externalSheet=SpreadsheetApp.openById(VAN_INFO_SYNC.externalSpreadsheetId).getSheetByName(VAN_INFO_SYNC.externalSheetName),vanInfo={};
  if(externalSheet.getLastRow()>1){
    externalSheet.getRange(2,1,externalSheet.getLastRow()-1,VAN_INFO_SYNC.externalVinColumn).getDisplayValues().forEach((row,index)=>{
      const vin=normalizeVanInfoVin_(row[VAN_INFO_SYNC.externalVinColumn-1]);
      if(vin)vanInfo[vin]={bag:normalizeVanInfoBag_(row[VAN_INFO_SYNC.externalBagColumn-1]),status:normalizeVanInfoStatus_(row[VAN_INFO_SYNC.externalStatusColumn-1]),row:index+2};
    });
  }
  return{closing,vanInfo};
}

function closingHeaderIndexes_(headers){
  const result={
    vin:headers.indexOf(VAN_INFO_SYNC.closingVinHeader),
    number:headers.indexOf(VAN_INFO_SYNC.closingVanNumberHeader),
    type:headers.indexOf(VAN_INFO_SYNC.closingTypeHeader),
    bag:headers.indexOf(VAN_INFO_SYNC.closingBagHeader),
    status:headers.indexOf(VAN_INFO_SYNC.closingStatusHeader),
    home:headers.indexOf(VAN_INFO_SYNC.closingHomeStationHeader),
    current:headers.indexOf(VAN_INFO_SYNC.closingCurrentStationHeader),
    active:headers.indexOf(VAN_INFO_SYNC.closingActiveHeader),
    updated:headers.indexOf(VAN_INFO_SYNC.closingUpdatedHeader)
  };
  if(['vin','number','type','bag','status','home','current'].some(key=>result[key]<0))throw new Error('VANS is missing a required synchronization column.');
  return result;
}

function writeVanInfoFieldsToClosing_(changes){
  if(!changes.length)return{updated:0,missing:0};
  const sheet=db_().getSheetByName(VAN_INFO_SYNC.closingSheetName),values=sheet.getDataRange().getValues(),headers=values[0].map(String),indexes=closingHeaderIndexes_(headers),rowByVin=new Map();
  values.slice(1).forEach((row,index)=>rowByVin.set(normalizeVanInfoVin_(row[indexes.vin]),index+2));
  let updated=0,missing=0;
  changes.forEach(change=>{
    const row=rowByVin.get(normalizeVanInfoVin_(change.vin));
    if(!row){missing++;return}
    let changed=false;
    if(Object.prototype.hasOwnProperty.call(change,'bag')){sheet.getRange(row,indexes.bag+1).setValue(normalizeVanInfoBag_(change.bag));changed=true}
    if(Object.prototype.hasOwnProperty.call(change,'status')){const status=normalizeVanInfoStatus_(change.status);if(status){sheet.getRange(row,indexes.status+1).setValue(status);changed=true}}
    if(changed&&indexes.updated>=0)sheet.getRange(row,indexes.updated+1).setValue(new Date());
    if(changed)updated++;
  });
  return{updated,missing};
}

function writeClosingFieldsToVanInfo_(changes){
  if(!changes.length)return{updated:0,missing:0};
  const sheet=SpreadsheetApp.openById(VAN_INFO_SYNC.externalSpreadsheetId).getSheetByName(VAN_INFO_SYNC.externalSheetName),lastRow=sheet.getLastRow();
  if(lastRow<2)return{updated:0,missing:changes.length};
  const rowByVin=new Map();
  sheet.getRange(2,VAN_INFO_SYNC.externalVinColumn,lastRow-1,1).getDisplayValues().forEach((row,index)=>rowByVin.set(normalizeVanInfoVin_(row[0]),index+2));
  let updated=0,missing=0;
  changes.forEach(change=>{
    const row=rowByVin.get(normalizeVanInfoVin_(change.vin));
    if(!row){missing++;return}
    let changed=false;
    if(Object.prototype.hasOwnProperty.call(change,'bag')){sheet.getRange(row,VAN_INFO_SYNC.externalBagColumn).setValue(normalizeVanInfoBag_(change.bag));changed=true}
    if(Object.prototype.hasOwnProperty.call(change,'status')){const status=normalizeVanInfoStatus_(change.status);if(status){sheet.getRange(row,VAN_INFO_SYNC.externalStatusColumn).setValue(status);changed=true}}
    if(changed)updated++;
  });
  return{updated,missing};
}

function loadVanInfoSnapshot_(){
  const raw=PropertiesService.getScriptProperties().getProperty(VAN_INFO_SYNC.snapshotProperty);
  if(!raw)return{closing:{},vanInfo:{}};
  try{return JSON.parse(raw)}catch(e){return{closing:{},vanInfo:{}}}
}

function saveVanInfoSnapshot_(){
  const state=readVanInfoSyncState_(),compact={closing:{},vanInfo:{}};
  Object.keys(state.closing).forEach(vin=>compact.closing[vin]={bag:state.closing[vin].bag,status:state.closing[vin].status});
  Object.keys(state.vanInfo).forEach(vin=>compact.vanInfo[vin]={bag:state.vanInfo[vin].bag,status:state.vanInfo[vin].status});
  PropertiesService.getScriptProperties().setProperty(VAN_INFO_SYNC.snapshotProperty,JSON.stringify(compact));
  return compact;
}

function normalizeVanInfoStatus_(value){
  const normalized=String(value||'').trim().toLowerCase();
  if(normalized==='operational')return'Operational';
  if(normalized==='grounded')return'Grounded';
  if(normalized==='downed')return'Downed';
  return'';
}

function normalizeVanInfoBag_(value){return String(value==null?'':value).trim()}
function normalizeVanInfoVin_(value){return String(value||'').trim().toUpperCase()}
function isVanInfoActive_(value){return value===true||['TRUE','YES','1','ACTIVE'].includes(String(value||'').trim().toUpperCase())}
