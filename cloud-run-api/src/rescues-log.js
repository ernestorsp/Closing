import { google } from 'googleapis';

const DEFAULT_SPREADSHEET_ID = '1Hh-SaxsOQaBRadK7M1k-FWehlbi_s5CvZDAsluSF4ZU';
const DEFAULT_SHEET_NAME = 'RESCUES_LOG';

export async function syncRescuesLog(rescues = []) {
  if (!Array.isArray(rescues) || !rescues.length) return { ok: true, count: 0 };

  const spreadsheetId = process.env.RESCUES_LOG_SPREADSHEET_ID || DEFAULT_SPREADSHEET_ID;
  const sheetName = process.env.RESCUES_LOG_SHEET_NAME || DEFAULT_SHEET_NAME;
  const auth = new google.auth.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  const sheets = google.sheets({ version: 'v4', auth });

  const values = rescues.map(rescue => [
    rescue.RescueDate || '',
    rescue.RescuerDriver || '',
    rescue.Stops ?? '',
    rescue.Packages ?? '',
    rescue.Affects || '',
    rescue.Notes || '',
    rescue.UserName || ''
  ]);

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `'${sheetName}'!A:G`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values }
  });

  return { ok: true, count: values.length };
}
