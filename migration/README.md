# CLOSING Firebase + Cloud Run migration

This directory introduces the migration path from Apps Script + Sheets as the live operational backend to Firebase and Cloud Run.

## Migration strategy

1. Keep the current Apps Script application operational.
2. Create Firebase Authentication, Firestore and Cloud Storage resources.
3. Deploy the Cloud Run API in `cloud-run-api/`.
4. Enable dual-write for inspections, vans, spots and locks.
5. Validate data parity with the CLOSING spreadsheet.
6. Switch reads to Firestore after verification.
7. Move rescues, closing data and users in later phases.
8. Retain Apps Script for Sheets reports, Drive documents and selected email workflows.

## Initial Firestore collections

- `users/{uid}`: role, station, active state and display profile.
- `vans/{vanId}`: current station, spot, status and update metadata.
- `spots/{station_spot}`: station, spot number and current van assignment.
- `inspectionLocks/{vanId}`: short-lived lock preventing concurrent inspection.
- `inspections/{inspectionId}`: inspection lifecycle and final result.
- `inspections/{inspectionId}/photos/{photoId}`: photo metadata and upload state.
- `syncQueue/{eventId}`: events waiting to be mirrored to Sheets/Apps Script.

## Required manual Google Cloud steps

These actions require the project owner because they involve account consent or billing:

1. Create or select a Firebase project.
2. Enable Firestore, Authentication and Cloud Storage.
3. Enable Cloud Run, Cloud Build, Artifact Registry and Secret Manager APIs.
4. Attach billing if Google requires the Blaze plan.
5. Create a service account for the Cloud Run service.
6. Add the allowed frontend origin and deploy the API.

## Safety controls

- Firestore transactions own van and spot assignment.
- Inspection locks expire automatically after five minutes.
- The API verifies Firebase ID tokens.
- Photos use resumable uploads and can be retried independently.
- Sheets is treated as reporting output, not the source of truth for live locks.
- The old Apps Script path stays available behind a feature flag during rollout.
