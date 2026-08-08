# Full Firebase cutover for CLOSING

This migration replaces the production Apps Script/Sheets/Drive backend. The final runtime is:

- Firebase Hosting: the current CLOSING interface.
- Firebase Authentication: accounts and password recovery.
- Firestore: users, vans, spots, inspections, Closing, Rescue, notes, audit and the idempotent synchronization ledger.
- Cloud Storage: inspection, damage and Closing Notes photos.
- Cloud Run: validation, transactions, concurrency control, administration and email delivery.

There is no Apps Script fallback, dual-write flag or Firebase test mode in the Firebase Hosting build.

## What remains compatible

The UI and the IndexedDB local-first outbox are retained. Existing Sheet field names are retained in Firestore so the current app screens, Closing/Rescue editing, Inspected Vans editor, DJX3/DJX4 behavior and audit data keep the same meaning.

Legacy passwords cannot be migrated safely. Firebase accounts are created with unknown random passwords and each active user receives a one-time Firebase password-creation link before cutover.

## Prerequisites owned by the project administrator

- Firebase/GCP project aaxi-closing with billing enabled if required.
- Firebase Authentication (Email/Password), Firestore, Cloud Storage, Hosting, Cloud Run, Cloud Build, Artifact Registry and Secret Manager enabled.
- Local gcloud and firebase CLI authentication with deployment access.
- A verified email sender and a Resend API key stored in Secret Manager as aaxi-closing-resend-api-key.
- The final Closing recipient list and allowed frontend origins.

Never put credentials, spreadsheet IDs, reset links or API secrets in Git.

## 1. Export the current application

Copy apps-script/FirebaseExport.gs into the spreadsheet-bound Apps Script project.

Run exportClosingDataForFirebase() once. It creates a version 2 JSON export in the Drive folder Closing Firebase Migration.

Run exportNextClosingPhotoArchiveForFirebase() repeatedly until it returns complete: true. Download every generated ZIP. Each archive includes its own manifest and at most 20 files to avoid Apps Script memory/time limits.

Do not alter the Sheet while performing the final production export. A rehearsal export can be performed earlier.

## 2. Import into a non-production Firebase project first

From migration/scripts, install dependencies and run these commands, substituting real paths:

    npm install
    GOOGLE_CLOUD_PROJECT=your-test-project node import-firestore-export.mjs /path/to/export.json --dry-run
    GOOGLE_CLOUD_PROJECT=your-test-project node import-firestore-export.mjs /path/to/export.json
    FIREBASE_STORAGE_BUCKET=your-test-bucket node import-photo-archives.mjs /path/to/media-1.zip /path/to/media-2.zip --dry-run
    FIREBASE_STORAGE_BUCKET=your-test-bucket node import-photo-archives.mjs /path/to/media-1.zip /path/to/media-2.zip --complete-media

Review counts and warnings after every command.

## 3. Deploy the API, rules and Hosting

Create the email secret with gcloud secrets create (or add a new secret version if it exists). Then configure EMAIL_FROM and CLOSING_EMAIL_RECIPIENTS and run:

    PROJECT_ID=aaxi-closing EMAIL_FROM='AAXI Closing <closing@your-domain.com>' CLOSING_EMAIL_RECIPIENTS='manager@example.com' bash migration/deploy-cloud-run.sh
    PROJECT_ID=aaxi-closing bash migration/deploy-firebase.sh

Update web/FirebaseRuntime.html only if the deployed Cloud Run URL differs from the configured URL, rebuild, and redeploy Hosting.

## 4. Create the first administrator and user passwords

    ADMIN_PASSWORD='temporary-private-password' node migration/scripts/bootstrap-admin.mjs admin@example.com 'Administrator' DJX3
    node migration/scripts/send-password-reset-links.mjs --dry-run
    node migration/scripts/send-password-reset-links.mjs --confirm-send

The final command sends external email. Run it only after checking the dry-run count and sender/recipient configuration.

## 5. Required cutover verification

Before directing users to Firebase Hosting:

1. Compare export/import counts for every collection.
2. Confirm all media archives were imported and system/migration.MediaImported is true.
3. Sign in as Admin and Lead accounts for DJX3 and DJX4.
4. Test start/finish inspection, optional photos, damage photo, Inspected Vans editing, Closing editing and Rescue editing.
5. Confirm DJX3 includes F-1 through F-6 after the Sheet export/import.
6. Confirm DJX4 Closing has no receipt-driver field and empty DVIC is N/A in the email.
7. Test offline save, browser close/reopen, automatic retry and duplicate operation IDs.
8. Test two users attempting the same van, spot, Closing, Rescue and completed inspection.
9. Send a Closing Notes email with pending items and with photos.
10. Confirm Firestore/Storage rules and Cloud Run logs have no permission or retry loops.

Only after those checks should the public link be switched to Firebase Hosting and the old Apps Script web deployment be made read-only/retired. Do not keep both backends accepting production writes.
