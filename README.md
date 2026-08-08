# AAXI Closing

Mobile-first Google Apps Script web app for daily van closing inspections.

## Included

- User-selected working station remembered per account
- Pending and completed inspection lists
- Optional inspection photos captured locally and uploaded in the background
- Previous photo comparison by van and photo position
- New vs. existing damage tracking
- Unique spot reservation for DJX3 and DJX4
- SHOP location without numbered spots
- Location-change confirmation
- Operational, Downed, and Grounded statuses
- Inspection history and audit log
- Daily rescues saved in one batch
- Daily closing data with automatic van-status counts
- Closing notes can be sent with available data after confirming a pending-items warning
- Persistent local-first outbox with automatic retries, idempotency, and foreground/connectivity sync
- Controlled Edit module for completed Inspections, Closing, and Rescue records
- Conflict detection and audit details for concurrent edits
- HTML Closing Notes email with table formatting and up to six photo attachments
- Closing Notes fleet sections listing Operational vans, Downed/Grounded vans with their status notes, and station-owned vans currently at SHOP
- Late RTS driver lists grouped with the current station first, followed by the other station
- Admin email approval workflow for skipping the remaining daily inspections
- Admin-only History and Update pages with server-side permission checks
- Driver roster imports for DJX3/DJX4 from AssociateData CSV files
- Combined DJX3/DJX4 vehicle imports from VehiclesData XLSX or CSV files
- Email invitation links with role and station-access selection
- Admin user list with permission changes and access removal
- Email verification codes for forgotten-password recovery
- In-app loading screen while an existing session is validated

## Google Sheet

The app expects these tabs: CONFIG, USERS, VANS, SPOTS, INSPECTIONS, PHOTOS, DAMAGES, AUDIT_LOG, LISTS, RESCUE_DRIVERS, RESCUES, DAILY_RESCUE_DRIVERS, RESCUES DJX3, RESCUES DJX4, DAILY_CLOSING, CLOSING_NOTES, and INSPECTION_SKIP_REQUESTS. `USER_INVITATIONS`, `PASSWORD_RESET_REQUESTS`, `SYNC_OPERATIONS`, and `SYNC_METADATA` are created automatically.

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

## Local-first behavior

Critical changes are accepted by the interface after they are persisted in IndexedDB. The outbox resumes automatically when connectivity returns, when the app returns to the foreground, and every 30 seconds while it is visible. Google Sheets operations use stable operation IDs; successful operations are recorded in `SYNC_OPERATIONS` so a retry does not duplicate them. Synced photo payloads are removed from the local outbox only after server confirmation.

Automatic synchronization is intentionally silent in the customer interface. It does not display synced, syncing, pending, or review-required indicators. The optional **Sync now** button only shows feedback when the user explicitly presses it.

The web platform cannot continue Apps Script calls after the browser has fully terminated. Pending work survives that closure and resumes the next time the app opens.

Run the local contract tests with `npm test` before deploying.

## Initial data

- USERS already contains the initial admin row in the Sheet.
- `Admin` users can access every page, History, Update, invitations, and user management.
- `Lead` users can access daily Closing functions but cannot access History or administration.
- Station access for a user can be `DJX3`, `DJX4`, or `Both`.
- Inspection skip requests are emailed to every active USERS row whose Role is `Admin`. The email contains private one-tap `YES — APPROVE` and `NO — DENY` links; the first response closes the request.
- VANS requires one row per active van with a unique VanID.
- SPOTS requires one active row per selectable DJX3 or DJX4 spot.
- A spot can be occupied by only one van.
- Abandoned reservations expire after 30 minutes.
