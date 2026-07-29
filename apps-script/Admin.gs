const ADMIN_ROLES=['Admin','User'];
const STATION_SCOPES=['DJX3','DJX4','Both'];

function ensureAdminSheets_(ss){
  ensureSheet_(ss,APP.SHEETS.users,['Email','Name','Role','DefaultStation','StationAccess','Active','PasswordHash','Salt','MustChange','InvitedAt','InvitedBy','LastLoginAt','UpdatedAt']);
  ensureSheet_(ss,APP.SHEETS.vans,['VanID','VanNumber','VanType','HomeStation','CurrentStation','CurrentSpot','CurrentStatus','Active','LastInspectionAt','LastInspectionID','UpdatedAt']);
  ensureSheet_(ss,APP.SHEETS.rescueDrivers,['DriverID','Driver','Station','Email','Active','UpdatedAt']);
  ensureSheet_(ss,'USER_INVITATIONS',['InvitationID','Email','Name','Role','DefaultStation','StationAccess','TokenHash','Status','CreatedAt','CreatedBy','ExpiresAt','AcceptedAt']);
  ensureSheet_(ss,'PASSWORD_RESET_REQUESTS',['RequestID','Email','CodeHash','Status','CreatedAt','ExpiresAt','UsedAt']);
}
function isAdmin_(u){return norm_(u&&u.Role)==='admin'}
function requireAdmin_(token){
  const s=auth_(token),u=user_(s.email);
  if(!u||!yes_(u.Active)||!isAdmin_(u))throw new Error('ADMIN_REQUIRED');
  return{s,u};
}
function allowedStations_(u){
  if(isAdmin_(u)||String(u&&u.StationAccess||'').toLowerCase()==='both')return APP.WORK_STATIONS.slice();
  const value=String(u&&u.StationAccess||u&&u.DefaultStation||'').toUpperCase();
  return APP.WORK_STATIONS.includes(value)?[value]:APP.WORK_STATIONS.slice();
}
function publicUser_(u){
  return{email:norm_(u.Email),name:String(u.Name||''),role:String(u.Role||'User'),station:workingStation_(u),stationAccess:String(u.StationAccess||'Both'),allowedStations:allowedStations_(u),isAdmin:isAdmin_(u)};
}
function revokeUserSessions_(email){
  const p=PropertiesService.getScriptProperties(),all=p.getProperties(),target=norm_(email);
  Object.keys(all).filter(k=>k.indexOf('CLOSE_SESSION_')===0).forEach(k=>{
    try{if(norm_(JSON.parse(all[k]).email)===target)p.deleteProperty(k)}catch(e){}
  });
}
function getAdminData(token){
  const a=requireAdmin_(token),ss=db_();ensureAdminSheets_(ss);
  return{
    users:rows_(ss.getSheetByName(APP.SHEETS.users)).map(u=>({
      email:norm_(u.Email),name:String(u.Name||''),role:String(u.Role||'User'),
      defaultStation:String(u.DefaultStation||'DJX3'),stationAccess:String(u.StationAccess||'Both'),
      active:yes_(u.Active),updatedAt:u.UpdatedAt||'',isSelf:norm_(u.Email)===a.s.email
    })).sort((x,y)=>Number(y.active)-Number(x.active)||x.name.localeCompare(y.name)),
    permissions:[
      {role:'Admin',access:'All Closing pages, History, Update, invitations and user management'},
      {role:'User',access:'Daily Closing pages for the assigned station(s); no History or administration'}
    ]
  };
}
function validateManagedUser_(input){
  input=input||{};
  const email=norm_(input.email),name=String(input.name||'').trim(),role=String(input.role||'User'),stationAccess=String(input.stationAccess||'Both'),defaultStation=String(input.defaultStation||'DJX3').toUpperCase();
  if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))throw new Error('Enter a valid email.');
  if(!name)throw new Error('Enter the user name.');
  if(!ADMIN_ROLES.includes(role))throw new Error('Invalid role.');
  if(!STATION_SCOPES.includes(stationAccess))throw new Error('Invalid station access.');
  if(!APP.WORK_STATIONS.includes(defaultStation))throw new Error('Invalid default station.');
  if(stationAccess!=='Both'&&defaultStation!==stationAccess)throw new Error('Default station must match station access.');
  return{email,name,role,stationAccess,defaultStation};
}
function createUserInvitation(token,input){
  const a=requireAdmin_(token),ss=db_();ensureAdminSheets_(ss);
  const v=validateManagedUser_(input),users=ss.getSheetByName(APP.SHEETS.users),existing=user_(v.email);
  if(existing&&yes_(existing.Active))throw new Error('That email already has an active account.');
  const raw=Utilities.getUuid()+Utilities.getUuid(),now=new Date(),expires=new Date(Date.now()+72*60*60*1000),invitationId=Utilities.getUuid();
  append_(ss.getSheetByName('USER_INVITATIONS'),{InvitationID:invitationId,Email:v.email,Name:v.name,Role:v.role,DefaultStation:v.defaultStation,StationAccess:v.stationAccess,TokenHash:hash_(raw),Status:'Pending',CreatedAt:now,CreatedBy:a.s.email,ExpiresAt:expires});
  const record={Email:v.email,Name:v.name,Role:v.role,DefaultStation:v.defaultStation,StationAccess:v.stationAccess,Active:false,PasswordHash:'',Salt:'',MustChange:false,InvitedAt:now,InvitedBy:a.s.email,UpdatedAt:now};
  if(existing)update_(users,'Email',existing.Email,record);else append_(users,record);
  const url=ScriptApp.getService().getUrl();
  if(!url)throw new Error('Deploy the project as a Web App before sending invitations.');
  const link=url+'?invite='+encodeURIComponent(raw),subject='Invitation to AAXI Closing';
  const html='<div style="font-family:Arial,sans-serif;color:#18303f;max-width:620px"><h2 style="color:#173f5f">AAXI Closing invitation</h2><p>Hello <b>'+html_(v.name)+'</b>,</p><p>You were invited as <b>'+html_(v.role)+'</b> with access to <b>'+html_(v.stationAccess)+'</b>.</p><p><a href="'+html_(link)+'" style="display:inline-block;background:#1f9aaa;color:#fff;text-decoration:none;padding:14px 20px;border-radius:9px;font-weight:bold">ACCEPT INVITATION</a></p><p style="font-size:12px;color:#687b86">This private link expires in 72 hours and can be used once.</p></div>';
  MailApp.sendEmail({to:v.email,subject,body:'Accept your AAXI Closing invitation: '+link,htmlBody:html,name:'AAXI Closing'});
  audit_(a.s.email,'INVITE_USER','USER',v.email,v.role+' · '+v.stationAccess);
  return{ok:true,message:'Invitation sent to '+v.email+'.'};
}
function acceptUserInvitation(rawToken,newPassword){
  if(String(newPassword||'').length<6)throw new Error('Password must have at least 6 characters.');
  return lock_(()=>{
    const ss=db_();ensureAdminSheets_(ss);
    const invitation=rows_(ss.getSheetByName('USER_INVITATIONS')).find(x=>x.Status==='Pending'&&equal_(x.TokenHash,hash_(String(rawToken||''))));
    if(!invitation||new Date(invitation.ExpiresAt).getTime()<Date.now())throw new Error('This invitation is invalid or expired.');
    const salt=Utilities.getUuid(),now=new Date(),sh=ss.getSheetByName(APP.SHEETS.users);
    update_(sh,'Email',invitation.Email,{Name:invitation.Name,Role:invitation.Role,DefaultStation:invitation.DefaultStation,StationAccess:invitation.StationAccess,Active:true,PasswordHash:hash_(salt+newPassword),Salt:salt,MustChange:false,UpdatedAt:now});
    update_(ss.getSheetByName('USER_INVITATIONS'),'InvitationID',invitation.InvitationID,{Status:'Accepted',AcceptedAt:now});
    audit_(invitation.Email,'ACCEPT_INVITATION','USER',invitation.Email,'');
    return{ok:true,message:'Account activated. You can sign in now.'};
  });
}
function updateManagedUser(token,input){
  const a=requireAdmin_(token),ss=db_();ensureAdminSheets_(ss);
  const v=validateManagedUser_(input),existing=user_(v.email);
  if(!existing)throw new Error('User not found.');
  const active=input.active===true||String(input.active).toLowerCase()==='true';
  if(norm_(existing.Email)===a.s.email&&(!active||v.role!=='Admin'))throw new Error('You cannot remove your own Admin access.');
  update_(ss.getSheetByName(APP.SHEETS.users),'Email',existing.Email,{Name:v.name,Role:v.role,DefaultStation:v.defaultStation,StationAccess:v.stationAccess,Active:active,UpdatedAt:new Date()});
  if(!active)revokeUserSessions_(v.email);
  audit_(a.s.email,'UPDATE_USER','USER',v.email,v.role+' · '+v.stationAccess+' · '+(active?'Active':'Inactive'));
  return{ok:true,message:'User permissions updated.'};
}
function removeManagedUser(token,email){
  const a=requireAdmin_(token),ss=db_(),target=norm_(email);
  if(target===a.s.email)throw new Error('You cannot remove your own account.');
  const sh=ss.getSheetByName(APP.SHEETS.users),data=sh.getDataRange().getValues(),headers=data[0].map(String),emailCol=headers.indexOf('Email'),row=data.findIndex((x,i)=>i>0&&norm_(x[emailCol])===target);
  if(row<1)throw new Error('User not found.');
  revokeUserSessions_(target);audit_(a.s.email,'REMOVE_USER','USER',target,'Deleted from USERS');
  sh.deleteRow(row+1);
  return{ok:true,message:'User permanently removed.'};
}
function requestPasswordReset(email){
  email=norm_(email);rate_('reset_'+email);
  const ss=db_();ensureAdminSheets_(ss);const u=user_(email);
  if(!u||!yes_(u.Active))return{ok:true,message:'If that email has an active account, a code was sent.'};
  const code=String(Math.floor(100000+Math.random()*900000)),now=new Date();
  append_(ss.getSheetByName('PASSWORD_RESET_REQUESTS'),{RequestID:Utilities.getUuid(),Email:email,CodeHash:hash_(email+'|'+code),Status:'Pending',CreatedAt:now,ExpiresAt:new Date(Date.now()+15*60*1000)});
  MailApp.sendEmail({to:email,subject:'AAXI Closing password code',body:'Your AAXI Closing password reset code is '+code+'. It expires in 15 minutes.',htmlBody:'<div style="font-family:Arial,sans-serif;color:#18303f"><h2>Password reset</h2><p>Your verification code is:</p><div style="font-size:32px;font-weight:bold;letter-spacing:7px;color:#173f5f">'+code+'</div><p>This code expires in 15 minutes and can be used once.</p></div>',name:'AAXI Closing'});
  return{ok:true,message:'If that email has an active account, a code was sent.'};
}
function resetPasswordWithCode(email,code,newPassword){
  email=norm_(email);if(String(newPassword||'').length<6)throw new Error('Password must have at least 6 characters.');
  return lock_(()=>{
    const ss=db_();ensureAdminSheets_(ss);
    const requests=rows_(ss.getSheetByName('PASSWORD_RESET_REQUESTS')).filter(x=>norm_(x.Email)===email&&x.Status==='Pending').sort((a,b)=>String(b.CreatedAt).localeCompare(String(a.CreatedAt))),request=requests[0];
    if(!request||new Date(request.ExpiresAt).getTime()<Date.now()||!equal_(request.CodeHash,hash_(email+'|'+String(code||'').trim())))throw new Error('The code is incorrect or expired.');
    const u=user_(email);if(!u||!yes_(u.Active))throw new Error('Account is not active.');
    const salt=Utilities.getUuid(),now=new Date();
    update_(ss.getSheetByName(APP.SHEETS.users),'Email',u.Email,{PasswordHash:hash_(salt+newPassword),Salt:salt,MustChange:false,UpdatedAt:now});
    update_(ss.getSheetByName('PASSWORD_RESET_REQUESTS'),'RequestID',request.RequestID,{Status:'Used',UsedAt:now});
    revokeUserSessions_(email);audit_(email,'RESET_PASSWORD','USER',email,'');
    return{ok:true,message:'Password changed. Sign in with your new password.'};
  });
}
function importDriversFile(token,station,file){
  const a=requireAdmin_(token);station=String(station||'').toUpperCase();
  if(!APP.WORK_STATIONS.includes(station))throw new Error('Select DJX3 or DJX4.');
  const table=parseUploadTable_(file),required=['Name and ID','TransporterID','Status'];assertColumns_(table.headers,required,'driver');
  const col=indexColumns_(table.headers),seen=new Set(),items=[];
  table.rows.forEach((row,index)=>{
    const id=cell_(row,col,'TransporterID'),name=cell_(row,col,'Name and ID'),status=cell_(row,col,'Status').toUpperCase(),email=cell_(row,col,'Email');
    if(!id&&!name)return;if(!id||!name)throw new Error('Driver file row '+(index+2)+' is missing Name and ID or TransporterID.');
    if(seen.has(id))throw new Error('Driver file contains duplicate TransporterID: '+id);
    seen.add(id);items.push({DriverID:id,Driver:name,Station:station,Email:email,Active:status==='ACTIVE',UpdatedAt:new Date()});
  });
  if(!items.length)throw new Error('No drivers were found in the uploaded file.');
  return lock_(()=>{
    const ss=db_();ensureAdminSheets_(ss);const sh=ss.getSheetByName(APP.SHEETS.rescueDrivers),existing=rows_(sh),byId=new Map(existing.map(x=>[String(x.DriverID),x]));
    existing.filter(x=>String(x.Station).toUpperCase()===station&&!seen.has(String(x.DriverID))).forEach(x=>update_(sh,'DriverID',x.DriverID,{Active:false,UpdatedAt:new Date()}));
    items.forEach(x=>{const old=byId.get(x.DriverID);if(old)update_(sh,'DriverID',old.DriverID,x);else append_(sh,x)});
    const active=items.filter(x=>x.Active).length;audit_(a.s.email,'IMPORT_DRIVERS','DRIVER',station,items.length+' rows · '+active+' active');
    return{ok:true,total:items.length,active,inactive:items.length-active,message:station+' drivers updated: '+active+' active, '+(items.length-active)+' inactive.'};
  });
}
function importVansFile(token,file){
  const a=requireAdmin_(token),table=parseUploadTable_(file),required=['vin','vehicleName','status','operationalStatus','stationCode'];assertColumns_(table.headers,required,'vehicle');
  const col=indexColumns_(table.headers),seen=new Set(),items=[];
  table.rows.forEach((row,index)=>{
    const vin=cell_(row,col,'vin').toUpperCase(),rawName=cell_(row,col,'vehicleName'),station=cell_(row,col,'stationCode').toUpperCase(),sourceStatus=cell_(row,col,'status').toUpperCase();
    if(!vin&&!rawName)return;if(!vin||!rawName||!APP.WORK_STATIONS.includes(station))throw new Error('Vehicle file row '+(index+2)+' is missing vin, vehicleName, or a valid stationCode.');
    if(seen.has(vin))throw new Error('Vehicle file contains duplicate VIN: '+vin);seen.add(vin);
    const operational=titleStatus_(cell_(row,col,'operationalStatus')),service=cell_(row,col,'serviceTier')||cell_(row,col,'serviceType'),vanNumber=rawName.replace(/^EDV\s*/i,'').trim();
    items.push({VanID:vin,VanNumber:vanNumber,VanType:vanTypeFromSource_(service,rawName),HomeStation:station,SourceOperationalStatus:operational,Active:sourceStatus==='ACTIVE',UpdatedAt:new Date()});
  });
  if(!items.length)throw new Error('No vans were found in the uploaded file.');
  return lock_(()=>{
    const ss=db_();ensureAdminSheets_(ss);const sh=ss.getSheetByName(APP.SHEETS.vans),existing=rows_(sh),byId=new Map(existing.map(x=>[String(x.VanID).toUpperCase(),x]));
    items.forEach(x=>{
      const old=byId.get(x.VanID),record={VanID:x.VanID,VanNumber:x.VanNumber,VanType:x.VanType,HomeStation:x.HomeStation,CurrentStation:old&&old.CurrentStation?old.CurrentStation:x.HomeStation,CurrentSpot:old?old.CurrentSpot:'',CurrentStatus:old&&old.CurrentStatus?old.CurrentStatus:x.SourceOperationalStatus,Active:x.Active,LastInspectionAt:old?old.LastInspectionAt:'',LastInspectionID:old?old.LastInspectionID:'',UpdatedAt:new Date()};
      if(old)update_(sh,'VanID',old.VanID,record);else append_(sh,record);
    });
    const active=items.filter(x=>x.Active).length,stations={DJX3:items.filter(x=>x.Active&&x.HomeStation==='DJX3').length,DJX4:items.filter(x=>x.Active&&x.HomeStation==='DJX4').length};
    audit_(a.s.email,'IMPORT_VANS','VAN','ALL',items.length+' rows · DJX3 '+stations.DJX3+' · DJX4 '+stations.DJX4);
    return{ok:true,total:items.length,active,stations,message:'Vans updated: '+stations.DJX3+' DJX3 and '+stations.DJX4+' DJX4 active.'};
  });
}
function parseUploadTable_(file){
  file=file||{};const name=String(file.name||'').toLowerCase(),data=String(file.base64||'');
  if(!data)throw new Error('Choose a file to upload.');
  if(data.length>12000000)throw new Error('The file is too large.');
  const bytes=Utilities.base64Decode(data);
  if(name.endsWith('.csv'))return parseCsv_(Utilities.newBlob(bytes).getDataAsString('UTF-8'));
  if(name.endsWith('.xlsx'))return parseXlsx_(Utilities.newBlob(bytes,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',file.name));
  throw new Error('Unsupported file. Use CSV for drivers or XLSX/CSV for vans.');
}
function parseCsv_(text){
  const rows=[],row=[];let value='',quoted=false;
  text=String(text||'').replace(/^\uFEFF/,'');
  for(let i=0;i<text.length;i++){const c=text[i],next=text[i+1];if(c==='"'&&quoted&&next==='"'){value+='"';i++}else if(c==='"'){quoted=!quoted}else if(c===','&&!quoted){row.push(value);value=''}else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&next==='\n')i++;row.push(value);value='';if(row.some(x=>String(x).trim()!==''))rows.push(row.splice(0))}else value+=c}
  row.push(value);if(row.some(x=>String(x).trim()!==''))rows.push(row);
  if(rows.length<2)throw new Error('The CSV file has no data rows.');
  return{headers:rows[0].map(x=>String(x).trim()),rows:rows.slice(1)};
}
function parseXlsx_(blob){
  let files;try{blob.setContentType('application/zip');files=Utilities.unzip(blob)}catch(e){throw new Error('The XLSX file is damaged or cannot be opened.')}
  const byName={};files.forEach(f=>byName[f.getName()]=f);
  const sheetName=Object.keys(byName).filter(n=>/^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort()[0];
  if(!sheetName)throw new Error('The XLSX file does not contain a readable worksheet.');
  const shared=[];if(byName['xl/sharedStrings.xml']){const root=XmlService.parse(byName['xl/sharedStrings.xml'].getDataAsString()).getRootElement(),ns=root.getNamespace();root.getChildren('si',ns).forEach(si=>{const collect=e=>e.getChildren().reduce((s,c)=>s+(c.getName()==='t'?c.getText():collect(c)),e.getName()==='t'?e.getText():'');shared.push(collect(si))})}
  const root=XmlService.parse(byName[sheetName].getDataAsString()).getRootElement(),ns=root.getNamespace(),sheetData=root.getChild('sheetData',ns),matrix=[];
  if(!sheetData)throw new Error('The XLSX worksheet is empty.');
  sheetData.getChildren('row',ns).forEach(rowEl=>{const row=[];rowEl.getChildren('c',ns).forEach(c=>{const ref=String(c.getAttribute('r')&&c.getAttribute('r').getValue()||''),letters=(ref.match(/[A-Z]+/)||['A'])[0];let index=0;for(let i=0;i<letters.length;i++)index=index*26+letters.charCodeAt(i)-64;index--;const type=String(c.getAttribute('t')&&c.getAttribute('t').getValue()||''),v=c.getChild('v',ns),inline=c.getChild('is',ns);let value=v?v.getText():'';if(type==='s')value=shared[Number(value)]||'';else if(type==='inlineStr'&&inline)value=inline.getChildren().map(x=>x.getText()).join('');row[index]=value});matrix.push(row)});
  if(matrix.length<2)throw new Error('The XLSX file has no data rows.');
  return{headers:matrix[0].map(x=>String(x||'').trim()),rows:matrix.slice(1)};
}
function assertColumns_(headers,required,label){
  const normalized=headers.map(x=>norm_(x)),missing=required.filter(x=>!normalized.includes(norm_(x)));
  if(missing.length)throw new Error('Invalid '+label+' file. Missing columns: '+missing.join(', ')+'.');
}
function indexColumns_(headers){const map={};headers.forEach((x,i)=>map[norm_(x)]=i);return map}
function cell_(row,col,name){const index=col[norm_(name)];return index===undefined?'':String(row[index]===undefined?'':row[index]).trim()}
function titleStatus_(value){value=String(value||'').toUpperCase();return value==='GROUNDED'?'Grounded':value==='DOWNED'?'Downed':'Operational'}
function vanTypeFromSource_(service,name){
  const value=(String(service||'')+' '+String(name||'')).toUpperCase();
  if(value.includes('ELECTRIC')||value.includes('EDV')||value.includes('RPV'))return'EDV';
  if(value.includes('EXTRA_LARGE')||value.includes('EXTRA LARGE'))return'XL';
  if(value.includes('STEP'))return'SV';
  if(value.includes('BOX'))return'BV';
  if(value.includes('CARGO'))return'CDV';
  return'Van';
}
