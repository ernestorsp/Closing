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

## Google Sheet

The app expects these tabs: CONFIG, USERS, VANS, SPOTS, INSPECTIONS, PHOTOS, DAMAGES, AUDIT_LOG, and LISTS.

Populate VANS and SPOTS before operational use. SHOP must not be added to SPOTS.

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
- VANS requires one row per active van with a unique VanID.
- SPOTS requires one active row per selectable DJX3 or DJX4 spot.
- A spot can be occupied by only one van.
- Abandoned reservations expire after 30 minutes.
