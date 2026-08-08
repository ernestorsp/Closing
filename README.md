# AAXI Closing

Production-oriented, mobile-first van inspection and Closing application.

## Production architecture

- Firebase Hosting serves the current CLOSING interface.
- Firebase Authentication manages sign-in, password reset and invitations.
- Firestore is the source of truth for vans, spots, inspections, Rescue, Closing, notes, users, audit and synchronization operations.
- Cloud Storage holds inspection, damage and Closing Notes photos.
- Cloud Run validates requests, performs Firestore transactions, prevents duplicate operations and sends email.
- IndexedDB keeps the device-first outbox so temporary network failures do not block or erase work.

The Firebase build has no Apps Script fallback, dual write, customer-visible pending/retry status or Firebase test switch. The Sync now button remains optional and only shows progress after the user presses it.

## Current application behavior

- Immediate local acceptance for Inspect, Finish, Closing, Rescue, notes and completed-inspection edits.
- Persistent automatic retries with stable operation IDs.
- Optional inspection photos and damage photos uploaded in the background.
- Searchable Inspected Vans page with the full inspection fields, damage workflow and optional photos.
- Closing and Rescue edit in their own sections.
- Warning-only Closing Notes readiness checks.
- Firestore transactions for van, spot, Closing, Rescue and completed-inspection conflicts.
- Audit events for controlled edits.
- DJX4 Closing omits Drivers with Receipts.
- Empty DVIC is N/A in Closing Notes email.
- DJX3 spot data, including F-1 through F-6, is imported from the current Sheet.

## Development

Build the static Firebase Hosting application:

    npm run build:web

Run all contract and Cloud API unit tests:

    npm test

Run syntax checks and rebuild Hosting output:

    npm run check

The Cloud Run service is in cloud-run-api. Firebase rules and Hosting configuration are in firebase.

## Migration and deployment

Follow migration/README.md. The cutover requires a fresh version 2 export from the current spreadsheet plus all generated photo archives.

Existing Sheet password hashes are intentionally not copied. Firebase users receive password-creation links. The old Apps Script deployment must remain the sole writer until the Firebase rehearsal, count comparison, media import and concurrency tests pass; at cutover it must be retired so both systems never accept production writes simultaneously.

Do not commit spreadsheet IDs, passwords, service-account keys, reset links, email API keys or deployment secrets.
