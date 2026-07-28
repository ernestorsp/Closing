# AAlX Closing

Mobile-first Google Apps Script web app for daily van closing inspections.

## Included

- User-selected working station remembered per account
- Pending and completed inspection lists
- Six required camera photos
- Previous photo comparison by van and photo position
- New vs. existing damage tracking
- Unique spot reservation for DJX3 and DJX4
- SHOP location without numbered spots
- Location-change confirmation
- Operational, Downed, and Grounded statuses
- Inspection history and audit log
- Daily rescues saved in one batch
- Daily closing data with automatic van-status counts
- Closing notes unlocked after every checklist item is ready
- HTML Closing Notes email with table formatting and up to six photo attachments
- Late RTS driver lists grouped with the current station first, followed by the other station
- Admin email approval workflow for skipping the remaining daily inspections

## Google Sheet

The app expects these tabs: CONFIG, USERS, VANS, SPOTS, INSPECTIONS, PHOTOS, DAMAGES, AUDIT_LOG, LISTS, RESCUE_DRIVERS, RESCUES, DAILY_RESCUE_DRIVERS, RESCUES DJX3, RESCUES DJX4, DAILY_CLOSING, CLOSING_NOTES, and INSPECTION_SKIP_REQUESTS. The last three are created automatically when the app loads.

Populate VANS and SPOTS before operational use. SHOP must not be added to SPOTS.

Add `CLOSING_EMAIL_RECIPIENTS` to CONFIG to send Closing Notes to management. Put multiple email addresses in Value separated by commas. If this setting is blank or missing, the email is sent to the signed-in user.

## Apps Script setup

1. Create an Apps Script project attached to the CLOSING spreadsheet.
2. Copy all files from `apps-script/`.
3. In **Project Settings → Script Properties**, add:
   - `CLOSING_SPREADSHEET_ID`: the private ID of the CLOSING spreadsheet.
   - `INITIAL_ADMIN_PASSWORD`: a temporary password with at least six characters.
4. Run `setupClosingApp` once and authorize it.
5. Deploy as a web app using the access level approved for your operation.
6. Paste the resulting `/exec` URL into `WEB_APP_URL` in the root `index.html`.
7. Enable GitHub Pages from the main branch.

Do not commit the spreadsheet ID, passwords, session tokens, or deployment secrets to this public repository.

## Initial data

- USERS already contains the initial admin row in the Sheet.
- Inspection skip requests are emailed to every active USERS row whose Role is `Admin`. An Admin must open the review link and sign in with their Closing app email and password before approving or denying.
- VANS requires one row per active van with a unique VanID.
- SPOTS requires one active row per selectable DJX3 or DJX4 spot.
- A spot can be occupied by only one van.
- Abandoned reservations expire after 30 minutes.
