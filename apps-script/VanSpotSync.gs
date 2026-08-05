const VAN_SPOT_SYNC={
  externalSpreadsheetId:'1veZ6qMIoK58t2O2-SIiaD2bbOk0iwhcGI4hmo2uLF1Y',
  externalSheetName:'VAN_INFO',
  externalParkSpotColumn:1,
  externalVinColumn:11,
  closingSheetName:'VANS',
  closingVinHeader:'VanID',
  closingHomeStationHeader:'HomeStation',
  closingCurrentStationHeader:'CurrentStation',
  closingSpotHeader:'CurrentSpot',
  closingActiveHeader:'Active',
  timerHandler:'syncClosingSpotsToVanInfo'
};

function setupVanSpotSync(){
  const external=SpreadsheetApp.openById(VAN_SPOT_SYNC.externalSpreadsheetId);
  if(!external.getSheetByName(VAN_SPOT_SYNC.externalSheetName))throw new Error('VAN_INFO was not found in DJX3 Spreadsheet ERSP.');
  const closing=db_();
  if(!closing.getSheetByName(VAN_SPOT_SYNC.closingSheetName))throw new Error('VANS was not found in CLOSING.');
  ScriptApp.getProjectTriggers().forEach(trigger=>{
    if(trigger.getHandlerFunction()===VAN_SPOT_SYNC.timerHandler)ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger(VAN_SPOT_SYNC.timerHandler).timeBased().everyMinutes(1).create();
  const result=syncClosingSpotsToVanInfo();
  return 'Spot synchronization installed. '+result.updated+' VAN_INFO spots updated from CLOSING.';
}

function syncClosingSpotsToVanInfo(){
  const lock=LockService.getScriptLock();
  if(!lock.tryLock(5000))return{updated:0,missing:0,skipped:true};
  try{
    const closingSheet=db_().getSheetByName(VAN_SPOT_SYNC.closingSheetName);
    if(!closingSheet)throw new Error('VANS was not found in CLOSING.');
    const values=closingSheet.getDataRange().getDisplayValues();
    const headers=(values[0]||[]).map(String);
    const vinIndex=headers.indexOf(VAN_SPOT_SYNC.closingVinHeader);
    const homeIndex=headers.indexOf(VAN_SPOT_SYNC.closingHomeStationHeader);
    const currentIndex=headers.indexOf(VAN_SPOT_SYNC.closingCurrentStationHeader);
    const spotIndex=headers.indexOf(VAN_SPOT_SYNC.closingSpotHeader);
    const activeIndex=headers.indexOf(VAN_SPOT_SYNC.closingActiveHeader);
    if([vinIndex,homeIndex,currentIndex,spotIndex].some(index=>index<0))throw new Error('VANS is missing VanID, HomeStation, CurrentStation or CurrentSpot.');

    const spotsByVin=new Map();
    values.slice(1).forEach(row=>{
      const vin=normalizeVanSpotVin_(row[vinIndex]);
      const home=String(row[homeIndex]||'').trim().toUpperCase();
      const current=String(row[currentIndex]||'').trim().toUpperCase();
      const active=activeIndex<0||isVanSpotActive_(row[activeIndex]);
      const included=current==='DJX3'||(home==='DJX3'&&current==='SHOP');
      if(!vin||!active||!included)return;
      const currentSpot=String(row[spotIndex]||'').trim();
      spotsByVin.set(vin,current==='SHOP'?(currentSpot||'SHOP'):currentSpot);
    });

    const externalSheet=SpreadsheetApp.openById(VAN_SPOT_SYNC.externalSpreadsheetId).getSheetByName(VAN_SPOT_SYNC.externalSheetName);
    if(!externalSheet)throw new Error('VAN_INFO was not found in DJX3 Spreadsheet ERSP.');
    const lastRow=externalSheet.getLastRow();
    if(lastRow<2)return{updated:0,missing:spotsByVin.size};
    const rows=externalSheet.getRange(2,1,lastRow-1,VAN_SPOT_SYNC.externalVinColumn).getDisplayValues();
    let updated=0;
    const found=new Set();
    rows.forEach((row,index)=>{
      const vin=normalizeVanSpotVin_(row[VAN_SPOT_SYNC.externalVinColumn-1]);
      if(!vin||!spotsByVin.has(vin))return;
      found.add(vin);
      const desired=spotsByVin.get(vin);
      const current=String(row[VAN_SPOT_SYNC.externalParkSpotColumn-1]||'').trim();
      if(current===desired)return;
      externalSheet.getRange(index+2,VAN_SPOT_SYNC.externalParkSpotColumn).setValue(desired);
      updated++;
    });
    let missing=0;
    spotsByVin.forEach((_spot,vin)=>{if(!found.has(vin))missing++});
    return{updated,missing};
  }finally{lock.releaseLock()}
}

function normalizeVanSpotVin_(value){return String(value||'').trim().toUpperCase()}
function isVanSpotActive_(value){return value===true||['TRUE','YES','1','ACTIVE'].includes(String(value||'').trim().toUpperCase())}
