// Duplicate-safe VAN_INFO synchronization override.
// Apps Script allows later function declarations to replace earlier ones.
// This version matches by VIN first and then by normalized van number.

function ensureDjx3VansInVanInfo_(){
  const closingSheet=db_().getSheetByName(VAN_INFO_SYNC.closingSheetName);
  const values=closingSheet.getDataRange().getDisplayValues();
  const headers=(values[0]||[]).map(String);
  const indexes=closingHeaderIndexes_(headers);
  const externalSheet=SpreadsheetApp.openById(VAN_INFO_SYNC.externalSpreadsheetId)
    .getSheetByName(VAN_INFO_SYNC.externalSheetName);

  const existingByVin=new Map();
  const existingByNumber=new Map();
  const lastRow=externalSheet.getLastRow();

  if(lastRow>1){
    const externalValues=externalSheet
      .getRange(2,1,lastRow-1,VAN_INFO_SYNC.externalVinColumn)
      .getDisplayValues();

    externalValues.forEach((row,index)=>{
      const sheetRow=index+2;
      const vin=normalizeVanInfoVin_(row[VAN_INFO_SYNC.externalVinColumn-1]);
      const number=normalizeVanInfoNumber_(row[VAN_INFO_SYNC.externalVanNumberColumn-1]);
      if(vin&&!existingByVin.has(vin))existingByVin.set(vin,sheetRow);
      if(number&&!existingByNumber.has(number))existingByNumber.set(number,sheetRow);
    });
  }

  const rowsToAppend=[];
  let vinFilled=0;

  values.slice(1).forEach(row=>{
    const vin=normalizeVanInfoVin_(row[indexes.vin]);
    const numberRaw=String(row[indexes.number]||'').trim();
    const number=normalizeVanInfoNumber_(numberRaw);
    const home=String(row[indexes.home]||'').trim().toUpperCase();
    const current=String(row[indexes.current]||'').trim().toUpperCase();
    const active=indexes.active<0||isVanInfoActive_(row[indexes.active]);
    const shouldBeInVanInfo=current==='DJX3'||(home==='DJX3'&&current==='SHOP');

    if(!vin||!number||!active||!shouldBeInVanInfo)return;
    if(existingByVin.has(vin))return;

    // A VAN_INFO row may already exist with this van number but without a VIN.
    // Complete that row instead of appending a duplicate at the bottom.
    const rowByNumber=existingByNumber.get(number);
    if(rowByNumber){
      const currentVin=normalizeVanInfoVin_(
        externalSheet.getRange(rowByNumber,VAN_INFO_SYNC.externalVinColumn).getDisplayValue()
      );
      if(!currentVin){
        externalSheet.getRange(rowByNumber,VAN_INFO_SYNC.externalVinColumn).setValue(vin);
        existingByVin.set(vin,rowByNumber);
        vinFilled++;
      }
      return;
    }

    const output=new Array(VAN_INFO_SYNC.externalVinColumn).fill('');
    output[VAN_INFO_SYNC.externalVanNumberColumn-1]=numberRaw;
    output[VAN_INFO_SYNC.externalBagColumn-1]=normalizeVanInfoBag_(row[indexes.bag]);
    output[VAN_INFO_SYNC.externalSizeColumn-1]=String(row[indexes.type]||'').trim();
    output[VAN_INFO_SYNC.externalStatusColumn-1]=normalizeVanInfoStatus_(row[indexes.status])||'Operational';
    output[VAN_INFO_SYNC.externalTypeColumn-1]=String(row[indexes.type]||'').trim();
    output[VAN_INFO_SYNC.externalVinColumn-1]=vin;
    rowsToAppend.push(output);
    existingByVin.set(vin,-1);
    existingByNumber.set(number,-1);
  });

  if(rowsToAppend.length){
    const start=externalSheet.getLastRow()+1;
    externalSheet.getRange(start,1,rowsToAppend.length,VAN_INFO_SYNC.externalVinColumn)
      .setValues(rowsToAppend);
  }

  return{added:rowsToAppend.length,vinFilled:vinFilled};
}

function normalizeVanInfoNumber_(value){
  return String(value==null?'':value).trim().toUpperCase().replace(/^EDV\s*/,'');
}
