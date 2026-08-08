const LOCAL_FIRST = {
  OPERATIONS_SHEET: "SYNC_OPERATIONS",
  METADATA_SHEET: "SYNC_METADATA",
  PROCESSING_TIMEOUT_MS: 4 * 60 * 1000,
  TYPES: [
    "START_INSPECTION",
    "SAVE_INSPECTION_PHOTO",
    "SAVE_DAMAGE",
    "FINISH_INSPECTION",
    "SAVE_CLOSING",
    "SAVE_RESCUES",
    "SEND_NOTES",
    "EDIT_INSPECTION",
  ],
};

let lfSheetsEnsuredForExecution_ = false;

function lfEnsureColumns_(sheet, headers) {
  if (!sheet) throw new Error("Required data sheet is missing.");
  const width = Math.max(1, sheet.getLastColumn());
  const current = sheet.getRange(1, 1, 1, width).getValues()[0].map(String);
  const missing = headers.filter((header) => !current.includes(header));
  if (missing.length) {
    sheet
      .getRange(1, width + 1, 1, missing.length)
      .setValues([missing])
      .setFontWeight("bold")
      .setBackground("#d9ead3");
  }
}

function lfEnsureSheets_(ss) {
  if (lfSheetsEnsuredForExecution_) return;
  ensureSheet_(ss, LOCAL_FIRST.OPERATIONS_SHEET, [
    "OperationID",
    "Type",
    "Status",
    "StartedAt",
    "CompletedAt",
    "UpdatedAt",
    "UserEmail",
    "Station",
    "EntityID",
    "Attempts",
    "ResultJSON",
    "LastError",
  ]);
  ensureSheet_(ss, LOCAL_FIRST.METADATA_SHEET, [
    "MetadataKey",
    "Version",
    "UpdatedAt",
    "UpdatedByEmail",
    "Fingerprint",
  ]);
  ensureClosingSheets_(ss);
  lfEnsureColumns_(ss.getSheetByName(APP.SHEETS.closingData), [
    "Version",
    "UpdatedAt",
    "LastOperationID",
  ]);
  lfEnsureColumns_(ss.getSheetByName(APP.SHEETS.closingNotes), [
    "Status",
    "OperationID",
    "WarningSummary",
  ]);
  lfEnsureColumns_(ss.getSheetByName(APP.SHEETS.inspections), [
    "UpdatedAt",
    "Version",
    "EditedAt",
    "EditedByEmail",
    "LastOperationID",
  ]);
  lfEnsureColumns_(ss.getSheetByName(APP.SHEETS.photos), ["OperationID"]);
  lfEnsureColumns_(ss.getSheetByName(APP.SHEETS.damages), ["OperationID"]);
  lfSheetsEnsuredForExecution_ = true;
}

function lfSafeOperationId_(value) {
  const id = String(value || "").trim();
  if (!/^[A-Za-z0-9_.:-]{8,160}$/.test(id))
    throw new Error("Invalid synchronization operation ID.");
  return id;
}

function lfParseJSON_(value, fallback) {
  try {
    return JSON.parse(String(value || ""));
  } catch (e) {
    return fallback;
  }
}

function lfBeginOperation_(operation, session) {
  return lock_(() => {
    const ss = db_();
    lfEnsureSheets_(ss);
    const sheet = ss.getSheetByName(LOCAL_FIRST.OPERATIONS_SHEET);
    const existing = find_(
      ss,
      LOCAL_FIRST.OPERATIONS_SHEET,
      "OperationID",
      operation.id,
    );
    const now = new Date();
    if (existing && String(existing.Status) === "synced") {
      return { completed: true, result: lfParseJSON_(existing.ResultJSON, {}) };
    }
    if (
      existing &&
      String(existing.Status) === "syncing" &&
      Date.now() -
        new Date(existing.UpdatedAt || existing.StartedAt || 0).getTime() <
        LOCAL_FIRST.PROCESSING_TIMEOUT_MS
    ) {
      return { busy: true };
    }
    const values = {
      OperationID: operation.id,
      Type: operation.type,
      Status: "syncing",
      StartedAt: existing ? existing.StartedAt || now : now,
      CompletedAt: "",
      UpdatedAt: now,
      UserEmail: session.email,
      Station: String(operation.station || ""),
      EntityID: String(operation.entityId || ""),
      Attempts: Number((existing && existing.Attempts) || 0) + 1,
      ResultJSON: "",
      LastError: "",
    };
    if (existing) update_(sheet, "OperationID", operation.id, values);
    else append_(sheet, values);
    return { started: true };
  });
}

function lfFinishOperation_(operation, result, error) {
  return lock_(() => {
    const ss = db_();
    lfEnsureSheets_(ss);
    const compact = result
      ? {
          ok: result.ok !== false,
          inspection: result.inspection || undefined,
          van: result.van || undefined,
          record: result.record || undefined,
          version: result.version || undefined,
          clientInspectionId: result.clientInspectionId || undefined,
          message: result.message || "",
        }
      : {};
    const values = {
      Status: error ? "retry" : "synced",
      UpdatedAt: new Date(),
      CompletedAt: error ? "" : new Date(),
      ResultJSON: error ? "" : JSON.stringify(compact),
      LastError: error
        ? String((error && error.message) || error).slice(0, 4000)
        : "",
    };
    update_(
      ss.getSheetByName(LOCAL_FIRST.OPERATIONS_SHEET),
      "OperationID",
      operation.id,
      values,
    );
  });
}

function syncApplyOperation(token, operation) {
  const session = auth_(token);
  operation = operation || {};
  operation.id = lfSafeOperationId_(operation.id);
  operation.type = String(operation.type || "");
  operation.payload = operation.payload || {};
  if (!LOCAL_FIRST.TYPES.includes(operation.type))
    throw new Error("Unsupported synchronization operation.");
  const user = session.user || user_(session.email);
  const requestedStation = String(operation.station || workingStation_(user));
  if (
    !APP.WORK_STATIONS.includes(requestedStation) ||
    !allowedStations_(user).includes(requestedStation)
  )
    throw new Error("Permission required for the synchronization station.");
  operation.station = requestedStation;
  operation.day = validDateInput_(operation.day || day_());
  const state = lfBeginOperation_(operation, session);
  if (state.completed)
    return {
      ok: true,
      duplicate: true,
      operationId: operation.id,
      result: state.result,
    };
  if (state.busy) throw new Error("SYNC_BUSY: operation is already syncing.");
  try {
    const result = lfDispatchOperation_(token, session, operation);
    lfFinishOperation_(operation, result, null);
    return { ok: true, operationId: operation.id, result: result || {} };
  } catch (error) {
    try {
      lfFinishOperation_(operation, null, error);
    } catch (ignored) {}
    throw error;
  }
}

function lfDispatchOperation_(token, session, operation) {
  const input = operation.payload || {};
  input._operationStation = operation.station;
  input._operationDay = operation.day;
  switch (operation.type) {
    case "START_INSPECTION":
      return lfStartInspection_(session, input, operation.id);
    case "SAVE_INSPECTION_PHOTO":
      return lfSaveInspectionPhoto_(session, input, operation.id);
    case "SAVE_DAMAGE":
      return lfSaveDamage_(session, input, operation.id);
    case "FINISH_INSPECTION":
      lfRenewInspection_(session.email, input.inspectionId, operation.id);
      return finishInspection(token, input);
    case "SAVE_CLOSING":
      return lfSaveClosing_(session, input, operation.id);
    case "SAVE_RESCUES":
      return lfSaveRescues_(session, input, operation.id);
    case "SEND_NOTES":
      return lfSendNotes_(session, input, operation.id);
    case "EDIT_INSPECTION":
      return lfEditInspection_(session, input, operation.id);
    default:
      throw new Error("Unsupported synchronization operation.");
  }
}

function lfClearAppCache_(email, station) {
  try {
    CacheService.getScriptCache().remove(
      "APP_DATA_V2_" + hash_(norm_(email) + "|" + station + "|" + day_()),
    );
  } catch (e) {}
}

function lfInspectionData_(ss, inspectionId, email) {
  const inspection = find_(
    ss,
    APP.SHEETS.inspections,
    "InspectionID",
    inspectionId,
  );
  if (!inspection) throw new Error("Inspection not found.");
  if (inspection.InspectionState === "Completed") {
    return {
      inspection,
      photos: rows_(ss.getSheetByName(APP.SHEETS.photos)).filter(
        (row) =>
          String(row.InspectionID) === String(inspectionId) &&
          APP.PARTS.includes(row.Part),
      ),
      damages: rows_(ss.getSheetByName(APP.SHEETS.damages)).filter(
        (row) => String(row.InspectionID) === String(inspectionId),
      ),
      spots: [],
      requiredParts: APP.PARTS,
      statuses: APP.STATUSES,
    };
  }
  return inspectionData_(ss, inspectionId, email);
}

function lfStartInspection_(session, input, operationId) {
  return lock_(() => {
    const ss = db_();
    lfEnsureSheets_(ss);
    const van = find_(ss, APP.SHEETS.vans, "VanID", input.vanId);
    if (!van || !yes_(van.Active)) throw new Error("Van not found.");
    const requestedId = lfSafeOperationId_(input.inspectionId || operationId);
    const byId = find_(ss, APP.SHEETS.inspections, "InspectionID", requestedId);
    if (byId) {
      if (norm_(byId.UserEmail) !== norm_(session.email))
        throw new Error("CONFLICT: inspection belongs to another user.");
      if (byId.InspectionState === "Cancelled")
        update_(
          ss.getSheetByName(APP.SHEETS.inspections),
          "InspectionID",
          requestedId,
          {
            InspectionState: "In Progress",
            StartedAt: new Date(),
            UpdatedAt: new Date(),
          },
        );
      return lfInspectionData_(ss, requestedId, session.email);
    }
    const existing = rowsTail_(
      ss.getSheetByName(APP.SHEETS.inspections),
      1200,
    ).find(
      (row) =>
        String(row.VanID) === String(van.VanID) &&
        row.InspectionState === "In Progress" &&
        storedDay_(row.InspectionDate || row.StartedAt) === input._operationDay,
    );
    if (existing) {
      if (norm_(existing.UserEmail) !== norm_(session.email))
        throw new Error(
          "CONFLICT: this van is being inspected by another user.",
        );
      update_(
        ss.getSheetByName(APP.SHEETS.inspections),
        "InspectionID",
        existing.InspectionID,
        {
          StartedAt: new Date(),
          UpdatedAt: new Date(),
          LastOperationID: operationId,
        },
      );
      const result = lfInspectionData_(
        ss,
        existing.InspectionID,
        session.email,
      );
      result.clientInspectionId = requestedId;
      return result;
    }
    const user = user_(session.email);
    const workingStation = String(
      input._operationStation || workingStation_(user),
    );
    const station = van.CurrentStation || workingStation;
    const spot = station === "SHOP" ? "SHOP" : van.CurrentSpot || "";
    append_(ss.getSheetByName(APP.SHEETS.inspections), {
      InspectionID: requestedId,
      InspectionDate: input._operationDay,
      StartedAt: new Date(),
      UserEmail: session.email,
      UserName: user.Name,
      WorkingStation: workingStation,
      VanID: van.VanID,
      VanNumber: van.VanNumber,
      PreviousStation: station,
      Station: station,
      PreviousSpot: spot,
      Spot: spot,
      PreviousStatus: van.CurrentStatus || "",
      Status: van.CurrentStatus || "Operational",
      LocationChanged: false,
      PhotoProgress: "0/6",
      InspectionState: "In Progress",
      UpdatedAt: new Date(),
      Version: 1,
      LastOperationID: operationId,
    });
    audit_(
      session.email,
      "START_INSPECTION_LOCAL_FIRST",
      "INSPECTION",
      requestedId,
      "Van " + van.VanNumber,
    );
    lfClearAppCache_(session.email, workingStation);
    return lfInspectionData_(ss, requestedId, session.email);
  });
}

function lfRenewInspection_(email, inspectionId, operationId) {
  return lock_(() => {
    const ss = db_();
    lfEnsureSheets_(ss);
    const inspection = find_(
      ss,
      APP.SHEETS.inspections,
      "InspectionID",
      inspectionId,
    );
    if (!inspection) throw new Error("Inspection not found.");
    if (inspection.InspectionState === "Completed") {
      if (!lfCanEditInspection_(user_(email), inspection))
        throw new Error("Permission required to edit this inspection.");
      return inspection;
    }
    if (norm_(inspection.UserEmail) !== norm_(email))
      throw new Error("CONFLICT: inspection belongs to another user.");
    if (inspection.InspectionState === "Cancelled") {
      update_(
        ss.getSheetByName(APP.SHEETS.inspections),
        "InspectionID",
        inspectionId,
        {
          InspectionState: "In Progress",
          StartedAt: new Date(),
          UpdatedAt: new Date(),
          LastOperationID: operationId,
        },
      );
      audit_(
        email,
        "RESUME_PENDING_INSPECTION",
        "INSPECTION",
        inspectionId,
        operationId,
      );
      return inspection;
    }
    if (inspection.InspectionState !== "In Progress")
      throw new Error("CONFLICT: inspection is no longer editable.");
    update_(
      ss.getSheetByName(APP.SHEETS.inspections),
      "InspectionID",
      inspectionId,
      {
        StartedAt: new Date(),
        UpdatedAt: new Date(),
        LastOperationID: operationId,
      },
    );
    return inspection;
  });
}

function lfSaveInspectionPhoto_(session, input, operationId) {
  lfRenewInspection_(session.email, input.inspectionId, operationId);
  return lock_(() => {
    const ss = db_();
    lfEnsureSheets_(ss);
    const inspection = find_(
      ss,
      APP.SHEETS.inspections,
      "InspectionID",
      input.inspectionId,
    );
    const completed = inspection.InspectionState === "Completed";
    if (completed) {
      if (!lfCanEditInspection_(user_(session.email), inspection))
        throw new Error("Permission required to edit this inspection.");
    } else {
      editable_(inspection, session.email);
    }
    if (!APP.PARTS.includes(input.part))
      throw new Error("Invalid photo position.");
    if (!/^data:image\/(jpeg|jpg|png);base64,/.test(String(input.image || "")))
      throw new Error("A camera photo is required.");
    const sheet = ss.getSheetByName(APP.SHEETS.photos);
    const photos = rows_(sheet);
    const operationPhoto = photos.find(
      (row) => String(row.OperationID) === operationId,
    );
    if (operationPhoto)
      return lfInspectionData_(ss, inspection.InspectionID, session.email);
    const existing = photos.find(
      (row) =>
        String(row.InspectionID) === String(inspection.InspectionID) &&
        row.Part === input.part,
    );
    const photoId = existing ? existing.PhotoID : "photo_" + operationId;
    const file = savePhoto_(input.image, inspection, input.part, photoId);
    const capturedAt = new Date();
    if (existing) {
      update_(sheet, "PhotoID", existing.PhotoID, {
        FileURL: file.getUrl(),
        FileID: file.getId(),
        CapturedAt: capturedAt,
        CapturedBy: session.email,
        DamageAssessment: "No Damage",
        DamageNotes: "",
        OperationID: operationId,
      });
      try {
        if (existing.FileID && String(existing.FileID) !== String(file.getId()))
          DriveApp.getFileById(existing.FileID).setTrashed(true);
      } catch (e) {}
    } else {
      const previous = previous_(
        ss,
        inspection.VanID,
        input.part,
        inspection.InspectionID,
      );
      append_(sheet, {
        PhotoID: photoId,
        InspectionID: inspection.InspectionID,
        VanID: inspection.VanID,
        VanNumber: inspection.VanNumber,
        Part: input.part,
        FileURL: file.getUrl(),
        FileID: file.getId(),
        CapturedAt: capturedAt,
        CapturedBy: session.email,
        PreviousPhotoID: previous ? previous.PhotoID : "",
        DamageAssessment: "No Damage",
        DamageNotes: "",
        OperationID: operationId,
      });
    }
    const count = new Set(
      rows_(sheet)
        .filter(
          (row) =>
            String(row.InspectionID) === String(inspection.InspectionID) &&
            APP.PARTS.includes(row.Part),
        )
        .map((row) => row.Part),
    ).size;
    const inspectionChanges = {
      PhotoProgress: count + "/6",
      LastOperationID: operationId,
    };
    if (!completed) inspectionChanges.UpdatedAt = new Date();
    update_(
      ss.getSheetByName(APP.SHEETS.inspections),
      "InspectionID",
      inspection.InspectionID,
      inspectionChanges,
    );
    audit_(
      session.email,
      existing ? "RETAKE_PHOTO" : "SAVE_PHOTO",
      "INSPECTION",
      inspection.InspectionID,
      input.part,
    );
    if (completed)
      lfClearAppCache_(session.email, workingStation_(user_(session.email)));
    return lfInspectionData_(ss, inspection.InspectionID, session.email);
  });
}

function lfSaveDamage_(session, input, operationId) {
  lfRenewInspection_(session.email, input.inspectionId, operationId);
  return lock_(() => {
    const ss = db_();
    lfEnsureSheets_(ss);
    const inspection = find_(
      ss,
      APP.SHEETS.inspections,
      "InspectionID",
      input.inspectionId,
    );
    const completed = inspection.InspectionState === "Completed";
    if (completed) {
      if (!lfCanEditInspection_(user_(session.email), inspection))
        throw new Error("Permission required to edit this inspection.");
    } else {
      editable_(inspection, session.email);
    }
    const part = String(input.part || "").trim();
    if (!APP.DEFECTS.includes(part))
      throw new Error("Select the van defect or affected part.");
    if (!/^data:image\/(jpeg|jpg|png);base64,/.test(String(input.image || "")))
      throw new Error("Take a close-up photo of the defect.");
    const existing = rows_(ss.getSheetByName(APP.SHEETS.damages)).find(
      (row) => String(row.OperationID) === operationId,
    );
    if (existing)
      return lfInspectionData_(ss, inspection.InspectionID, session.email);
    const photoId = "damage_photo_" + operationId;
    const damageId = "damage_" + operationId;
    const file = savePhoto_(input.image, inspection, "Defect " + part, photoId);
    append_(ss.getSheetByName(APP.SHEETS.photos), {
      PhotoID: photoId,
      InspectionID: inspection.InspectionID,
      VanID: inspection.VanID,
      VanNumber: inspection.VanNumber,
      Part: "Damage - " + part,
      FileURL: file.getUrl(),
      FileID: file.getId(),
      CapturedAt: new Date(),
      CapturedBy: session.email,
      PreviousPhotoID: "",
      DamageAssessment: "New Damage",
      DamageNotes: part,
      OperationID: operationId,
    });
    append_(ss.getSheetByName(APP.SHEETS.damages), {
      DamageID: damageId,
      InspectionID: inspection.InspectionID,
      VanID: inspection.VanID,
      VanNumber: inspection.VanNumber,
      Part: part,
      Assessment: "New Damage",
      Severity: input.severity || "Medium",
      Description: "",
      PhotoID: photoId,
      ReportedAt: new Date(),
      ReportedBy: session.email,
      ResolutionStatus: "Open",
      OperationID: operationId,
    });
    const inspectionChanges = {
      NewDamageFound: "Yes",
      LastOperationID: operationId,
    };
    if (!completed) inspectionChanges.UpdatedAt = new Date();
    update_(
      ss.getSheetByName(APP.SHEETS.inspections),
      "InspectionID",
      inspection.InspectionID,
      inspectionChanges,
    );
    audit_(
      session.email,
      "REPORT_DAMAGE",
      "INSPECTION",
      inspection.InspectionID,
      part,
    );
    if (completed)
      lfClearAppCache_(session.email, workingStation_(user_(session.email)));
    return lfInspectionData_(ss, inspection.InspectionID, session.email);
  });
}

function lfSameMoment_(left, right) {
  if (!left && !right) return true;
  const a = new Date(left || 0).getTime();
  const b = new Date(right || 0).getTime();
  return !!a && !!b && Math.abs(a - b) < 2;
}

function lfChangedFields_(before, after, fields) {
  return fields.reduce((changes, field) => {
    const oldValue = before ? before[field] : "";
    const newValue = after ? after[field] : "";
    if (
      String(oldValue == null ? "" : oldValue) !==
      String(newValue == null ? "" : newValue)
    )
      changes[field] = { before: oldValue, after: newValue };
    return changes;
  }, {});
}

function lfSaveClosing_(session, input, operationId) {
  return lock_(() => {
    const ss = db_();
    lfEnsureSheets_(ss);
    const user = user_(session.email);
    const station = String(input._operationStation || workingStation_(user));
    input = input || {};
    const date = validDateInput_(input.date);
    const pickup = String(input.pickupAll || "");
    if (!["Yes", "No"].includes(pickup))
      throw new Error("Select whether all pickups were collected.");
    const existing = closingRecord_(ss, date, station);
    const expected = input.expectedUpdatedAt || input.expectedSavedAt || "";
    const actual = existing && (existing.UpdatedAt || existing.SavedAt);
    const sameEditor =
      existing && norm_(existing.SavedByEmail) === norm_(session.email);
    if (
      existing &&
      (!expected || !lfSameMoment_(expected, actual)) &&
      !sameEditor
    )
      throw new Error(
        "CONFLICT: Closing was changed by another user. Synchronize and review the newer version.",
      );
    const allDrivers = rescueData_(ss).drivers;
    const driverById = new Map(
      allDrivers.map((row) => [String(row.DriverID), row]),
    );
    const driverList = (values, label) =>
      [
        ...new Set(
          (Array.isArray(values) ? values : []).map(String).filter(Boolean),
        ),
      ].map((id) => {
        const driver = driverById.get(id);
        if (!driver)
          throw new Error(
            "A selected " + label + " driver is no longer available.",
          );
        return driver;
      });
    const lateDrivers = driverList(input.lateDriverIds, "RTS");
    const dvicDrivers = driverList(input.dvicDriverIds, "DVIC");
    const activeVans = rows_(ss.getSheetByName(APP.SHEETS.vans)).filter((row) =>
      yes_(row.Active),
    );
    const counts = vanStatusCounts_(activeVans, station);
    const now = new Date();
    const key = date + "_" + station;
    const record = {
      RecordKey: key,
      RecordID: (existing || {}).RecordID || Utilities.getUuid(),
      RecordDate: date,
      Station: station,
      OperationalVans: counts.Operational,
      DownedVans: counts.Downed,
      GroundedVans: counts.Grounded,
      RoutesTomorrow: intRange_(
        input.routesTomorrow,
        1,
        100,
        "Routes for Tomorrow",
      ),
      PickupAll: pickup,
      PickupComment:
        pickup === "No" ? String(input.pickupComment || "").trim() : "",
      Phones: intRange_(input.phones, 1, 100, "Phones"),
      BatteryPacks: intRange_(input.batteryPacks, 1, 100, "Battery Packs"),
      DriversWithReceipts:
        station === "DJX4"
          ? ""
          : intRange_(
              input.driversWithReceipts,
              1,
              25,
              "Drivers with Receipts",
            ),
      ReturnedPackages: intRange_(
        input.returnedPackages,
        0,
        99999,
        "Returned Packages",
      ),
      LateRTSDriverIDs: lateDrivers
        .map((row) => String(row.DriverID))
        .join(" | "),
      LateRTSDrivers: lateDrivers.map((row) => row.Driver).join(" | "),
      DVICDriverIDs: dvicDrivers.map((row) => String(row.DriverID)).join(" | "),
      DVICDrivers: dvicDrivers.map((row) => row.Driver).join(" | "),
      SavedAt: now,
      SavedByEmail: session.email,
      SavedByName: user.Name,
      Version: Number((existing && existing.Version) || 0) + 1,
      UpdatedAt: now,
      LastOperationID: operationId,
    };
    upsertObject_(
      ss.getSheetByName(APP.SHEETS.closingData),
      "RecordKey",
      key,
      record,
    );
    const changes = lfChangedFields_(existing, record, [
      "RoutesTomorrow",
      "PickupAll",
      "PickupComment",
      "Phones",
      "BatteryPacks",
      "DriversWithReceipts",
      "ReturnedPackages",
      "LateRTSDriverIDs",
      "DVICDriverIDs",
    ]);
    audit_(
      session.email,
      existing ? "EDIT_DAILY_CLOSING" : "SAVE_DAILY_CLOSING",
      "CLOSING",
      key,
      JSON.stringify(changes),
    );
    lfClearAppCache_(session.email, station);
    return {
      ok: true,
      record,
      vanCounts: counts,
      message: "Closing saved locally and synchronized for " + station + ".",
    };
  });
}

function lfMetadata_(ss, key) {
  return find_(ss, LOCAL_FIRST.METADATA_SHEET, "MetadataKey", key) || null;
}

function lfRescueFingerprint_(rows) {
  const clean = (rows || [])
    .filter((row) => !yes_(row.Deleted))
    .map((row) => [
      String(row.RescueID || ""),
      String(row.RescuerDriverID || ""),
      String(row.RecipientDriverID || ""),
      Number(row.Stops || 0),
      Number(row.Packages || 0),
      String(row.Affects || ""),
      String(row.Notes || ""),
    ])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return hash_(JSON.stringify(clean));
}

function lfSoftDeleteDay_(sheet, dateHeader, stationHeader, station, date) {
  if (!sheet || sheet.getLastRow() < 2) return;
  const data = sheet.getDataRange().getValues();
  const headers = data[0].map(String);
  const dateCol = headers.indexOf(dateHeader);
  const stationCol = headers.indexOf(stationHeader);
  const deletedCol = headers.indexOf("Deleted");
  if (dateCol < 0 || stationCol < 0 || deletedCol < 0) return;
  let changed = false;
  const values = data.slice(1).map((row) => {
    const remove =
      dateKey_(row[dateCol]) === date && String(row[stationCol]) === station;
    if (remove) changed = true;
    return [remove ? true : row[deletedCol]];
  });
  if (changed)
    sheet.getRange(2, deletedCol + 1, values.length, 1).setValues(values);
}

function lfSaveRescues_(session, payload, operationId) {
  return lock_(() => {
    const ss = db_();
    lfEnsureSheets_(ss);
    const user = user_(session.email);
    const station = String(payload._operationStation || workingStation_(user));
    const date = validDateInput_(payload._operationDay || day_());
    const key = "RESCUE_" + date + "_" + station;
    const metadata = lfMetadata_(ss, key);
    const currentVersion = Number((metadata && metadata.Version) || 0);
    const expectedVersion = Number(payload.expectedVersion || 0);
    if (currentVersion !== expectedVersion)
      throw new Error(
        "CONFLICT: Rescue was changed by another user. Synchronize and review the newer version.",
      );
    const dailyInput = Array.isArray(payload.dailyDrivers)
      ? payload.dailyDrivers
      : [];
    const rescueInput = Array.isArray(payload.rescues) ? payload.rescues : [];
    if (dailyInput.length > 100 || rescueInput.length > 300)
      throw new Error("Too many rescues in one save.");
    const master = rescueData_(ss).drivers;
    const masterById = new Map(
      master.map((row) => [String(row.DriverID), row]),
    );
    const dailyById = new Map();
    dailyInput.forEach((item) => {
      const driver = masterById.get(String(item.driverId || ""));
      if (!driver)
        throw new Error("A selected rescue driver is no longer available.");
      dailyById.set(String(driver.DriverID), driver);
    });
    const number = (value, label, index) => {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1)
        throw new Error(
          "Rescue " + index + ": " + label + " must be at least 1.",
        );
      return parsed;
    };
    const now = new Date();
    const rescueDate = new Date(date + "T12:00:00");
    const rescues = rescueInput.map((item, index) => {
      const rescuer = dailyById.get(String(item.rescuerDriverId || ""));
      const recipient = masterById.get(String(item.recipientDriverId || ""));
      const affects = String(item.affects || "");
      if (!rescuer)
        throw new Error(
          "Rescue " + (index + 1) + ": select a valid rescue driver.",
        );
      if (!recipient)
        throw new Error(
          "Rescue " + (index + 1) + ": select the driver who received it.",
        );
      if (!["Yes", "No"].includes(affects))
        throw new Error("Rescue " + (index + 1) + ": select Affects.");
      const rescueId = lfSafeOperationId_(
        item.rescueId || "rescue_" + operationId + "_" + index,
      );
      return {
        RescueID: rescueId,
        RescueDate: rescueDate,
        CreatedAt: now,
        UpdatedAt: now,
        UserEmail: session.email,
        UserName: user.Name,
        Station: station,
        RescuerDriverID: rescuer.DriverID,
        RescuerDriver: rescuer.Driver,
        RecipientDriverID: recipient.DriverID,
        RecipientDriver: recipient.Driver,
        Stops: number(item.stops, "Stops", index + 1),
        Packages: number(item.packages, "Packages", index + 1),
        Affects: affects,
        Notes: String(item.notes || "").trim(),
        Deleted: false,
        Status: "Saved",
        SavedAt: now,
      };
    });
    lfSoftDeleteDay_(
      ss.getSheetByName(APP.SHEETS.dailyRescueDrivers),
      "AssignmentDate",
      "Station",
      station,
      date,
    );
    lfSoftDeleteDay_(
      ss.getSheetByName(APP.SHEETS.rescues),
      "RescueDate",
      "Station",
      station,
      date,
    );
    appendMany_(
      ss.getSheetByName(APP.SHEETS.dailyRescueDrivers),
      [...dailyById.values()].map((driver) => ({
        AssignmentID:
          "assignment_" +
          date.replace(/-/g, "") +
          "_" +
          station +
          "_" +
          driver.DriverID,
        AssignmentDate: rescueDate,
        CreatedAt: now,
        UserEmail: session.email,
        UserName: user.Name,
        Station: station,
        DriverID: driver.DriverID,
        Driver: driver.Driver,
        Deleted: false,
      })),
    );
    appendMany_(ss.getSheetByName(APP.SHEETS.rescues), rescues);
    const outputName = "RESCUES " + station;
    const headers = [
      "Rescue ID",
      "Date",
      "Station",
      "Rescue Driver",
      "Driver Rescued",
      "Stops",
      "Packages",
      "Affects",
      "Notes",
      "Saved At",
      "Final Saved At",
      "Saved By",
    ];
    const outputSheet =
      ss.getSheetByName(outputName) || ss.insertSheet(outputName);
    if (outputSheet.getLastRow() === 0)
      outputSheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    const outputRows = outputSheet.getDataRange().getValues();
    const outputHeaders = outputRows[0].map(String);
    if (outputHeaders[0] !== "Rescue ID")
      throw new Error(
        outputName +
          ' has unexpected columns. Add "Rescue ID" as the first column.',
      );
    const idCol = outputHeaders.indexOf("Rescue ID");
    const dateCol = outputHeaders.indexOf("Date");
    const stationCol = outputHeaders.indexOf("Station");
    const keepIds = new Set(rescues.map((row) => String(row.RescueID)));
    for (let row = outputRows.length - 1; row >= 1; row--) {
      if (
        dateKey_(outputRows[row][dateCol]) === date &&
        String(outputRows[row][stationCol]) === station &&
        !keepIds.has(String(outputRows[row][idCol]))
      )
        outputSheet.deleteRow(row + 1);
    }
    const currentOutput = rows_(outputSheet);
    const rowById = new Map(
      currentOutput.map((row, index) => [String(row["Rescue ID"]), index + 2]),
    );
    rescues.forEach((rescue) => {
      const values = [
        rescue.RescueID,
        rescueDate,
        station,
        rescue.RescuerDriver,
        rescue.RecipientDriver,
        rescue.Stops,
        rescue.Packages,
        rescue.Affects,
        rescue.Notes || "",
        rescue.SavedAt,
        now,
        user.Name || session.email,
      ];
      const row = rowById.get(String(rescue.RescueID));
      if (row)
        outputSheet.getRange(row, 1, 1, headers.length).setValues([values]);
      else outputSheet.appendRow(values);
    });
    outputSheet
      .getRange(1, 1, 1, headers.length)
      .setFontWeight("bold")
      .setBackground(station === "DJX3" ? "#f4cccc" : "#d9ead3");
    outputSheet.setFrozenRows(1);
    outputSheet.autoResizeColumns(1, headers.length);
    if (outputSheet.getMaxRows() > 1)
      outputSheet.showRows(2, outputSheet.getMaxRows() - 1);
    rows_(outputSheet).forEach((row, index) => {
      if (dateKey_(row.Date) !== date) outputSheet.hideRows(index + 2);
    });
    const version = currentVersion + 1;
    const fingerprint = lfRescueFingerprint_(rescues);
    upsertObject_(
      ss.getSheetByName(LOCAL_FIRST.METADATA_SHEET),
      "MetadataKey",
      key,
      {
        MetadataKey: key,
        Version: version,
        UpdatedAt: now,
        UpdatedByEmail: session.email,
        Fingerprint: fingerprint,
      },
    );
    audit_(
      session.email,
      currentVersion ? "EDIT_DAILY_RESCUES" : "FINALIZE_DAILY_RESCUES",
      "RESCUE",
      station,
      JSON.stringify({
        date,
        count: rescues.length,
        version,
        beforeFingerprint: (metadata && metadata.Fingerprint) || "",
        afterFingerprint: fingerprint,
      }),
    );
    lfClearAppCache_(session.email, station);
    return {
      ok: true,
      count: rescues.length,
      version,
      message: rescues.length
        ? rescues.length + " rescues synchronized to " + outputName + "."
        : "No rescues today. " + station + " was closed successfully.",
    };
  });
}

function getLocalFirstMetadata(token) {
  const session = auth_(token);
  return lock_(() => {
    const ss = db_();
    const user = user_(session.email);
    const station = workingStation_(user);
    lfEnsureSheets_(ss);
    const rescue = lfMetadata_(ss, "RESCUE_" + day_() + "_" + station);
    return {
      rescueVersion: Number((rescue && rescue.Version) || 0),
      rescueUpdatedAt: (rescue && rescue.UpdatedAt) || "",
    };
  });
}

function lfPendingLabels_(readiness) {
  const labels = [];
  if (!readiness.inspectionsReady)
    labels.push("vans without a completed inspection");
  if (!readiness.rescuesReady) labels.push("Rescue not finalized");
  if (!readiness.closingReady) labels.push("Closing data not saved");
  return labels;
}

function lfSaveClosingNotePhotos_(photos, station, date, operationId) {
  if (!Array.isArray(photos) || !photos.length) return [];
  if (photos.length > 6) throw new Error("You can attach up to 6 photos.");
  const root = closingNotesPhotoFolder_();
  const dateFolder = folder_(root, date);
  const stationFolder = folder_(dateFolder, station);
  return photos.map((photo, index) => {
    const data = String(photo.data || "");
    const match = data.match(/^data:(image\/(?:jpeg|jpg|png));base64,/);
    if (!match) throw new Error("Photo " + (index + 1) + " is invalid.");
    const extension = match[1].includes("png") ? "png" : "jpg";
    const name = (operationId + "_" + (index + 1) + "." + extension).replace(
      /[^\w.\-]+/g,
      "_",
    );
    const existing = stationFolder.getFilesByName(name);
    const file = existing.hasNext()
      ? existing.next()
      : stationFolder.createFile(
          Utilities.newBlob(
            Utilities.base64Decode(data.split(",")[1]),
            match[1],
            name,
          ),
        );
    return {
      file,
      blob: file
        .getBlob()
        .setName(String(photo.name || name).replace(/[^\w.\-]+/g, "_")),
    };
  });
}

function lfSendNotes_(session, input, operationId) {
  return lock_(() => {
    const ss = db_();
    const user = user_(session.email);
    const station = String(input._operationStation || workingStation_(user));
    lfEnsureSheets_(ss);
    const operationDate = validDateInput_(input._operationDay || day_());
    const existing = closingNote_(ss, operationDate, station);
    if (existing && String(existing.Status || "Sent") === "Sent")
      return {
        ok: true,
        alreadySent: true,
        record: existing,
        message: "Closing notes were already sent.",
      };
    const notes = String((input && input.notes) || "").trim();
    if (!notes) throw new Error("Write the closing notes before sending.");
    const readiness =
      operationDate === day_() ? closingReadiness_(ss, station) : null;
    const warnings = readiness ? lfPendingLabels_(readiness) : [];
    if (warnings.length && !(input && input.force))
      throw new Error("PENDING_CONFIRMATION: " + warnings.join(", "));
    const counts = vanStatusCounts_(
      rows_(ss.getSheetByName(APP.SHEETS.vans)).filter((row) =>
        yes_(row.Active),
      ),
      station,
    );
    const data = closingRecord_(ss, operationDate, station) || {
      RecordDate: operationDate,
      OperationalVans: counts.Operational,
      DownedVans: counts.Downed,
      GroundedVans: counts.Grounded,
      RoutesTomorrow: "N/A",
      PickupAll: "N/A",
      PickupComment: "",
      Phones: "N/A",
      BatteryPacks: "N/A",
      DriversWithReceipts: "N/A",
      ReturnedPackages: "N/A",
      LateRTSDrivers: "N/A",
      DVICDrivers: "N/A",
    };
    const date = storedDay_(data.RecordDate) || operationDate;
    const key = date + "_" + station;
    const recipients = closingEmailRecipients_(ss, session.email);
    const photos = lfSaveClosingNotePhotos_(
      input && input.photos,
      station,
      date,
      operationId,
    );
    const rescues = rescueData_(ss, station).rescues.filter(
      (row) => row.Status === "Saved",
    );
    const fleet = fleetEmailData_(ss, station);
    const photoBaseUrl = ScriptApp.getService().getUrl();
    if (!photoBaseUrl)
      throw new Error(
        "Deploy the project as a Web App before sending Closing Notes.",
      );
    fleet.defects.forEach((van) =>
      van.defects.forEach((damage) => {
        damage.photoViewUrl = damage.photoFileId
          ? photoBaseUrl +
            "?closingPhoto=" +
            encodeURIComponent(closingPhotoToken_(damage.photoFileId))
          : "";
      }),
    );
    const displayDate = Utilities.formatDate(
      new Date(date + "T12:00:00"),
      "America/New_York",
      "EEEE, MM-dd-yyyy",
    );
    const subject = station + " - Closing Notes - " + displayDate;
    const pendingRecord = {
      NoteKey: key,
      NoteID: (existing || {}).NoteID || Utilities.getUuid(),
      NoteDate: date,
      Station: station,
      Notes: notes,
      PhotoFileIDs: photos.map((item) => item.file.getId()).join(" | "),
      PhotoFileURLs: photos.map((item) => item.file.getUrl()).join(" | "),
      PhotoCount: photos.length,
      EmailRecipients: recipients.join(", "),
      EmailSubject: subject,
      SentAt: "",
      SentByEmail: session.email,
      SentByName: user.Name,
      Status: "Sending",
      OperationID: operationId,
      WarningSummary: warnings.join(" | "),
    };
    if (MailApp.getRemainingDailyQuota() < recipients.length)
      throw new Error(
        "Not enough email quota remains to send Closing Notes today.",
      );
    MailApp.sendEmail({
      to: recipients.join(","),
      subject,
      body: station + " Closing Notes for " + displayDate + "\n\n" + notes,
      htmlBody: closingEmailHtml_(
        station,
        displayDate,
        data,
        rescues,
        notes,
        photos.length,
        fleet,
        user.Name || session.email,
      ),
      attachments: photos.map((item) => item.blob),
      name: (user.Name || "AAXI Closing") + " · " + session.email,
      replyTo: session.email,
    });
    const record = Object.assign({}, pendingRecord, {
      SentAt: new Date(),
      Status: "Sent",
    });
    upsertObject_(
      ss.getSheetByName(APP.SHEETS.closingNotes),
      "NoteKey",
      key,
      record,
    );
    audit_(
      session.email,
      "SEND_CLOSING_NOTES",
      "CLOSING_NOTES",
      key,
      JSON.stringify({ recipients, warnings }),
    );
    lfClearAppCache_(session.email, station);
    return {
      ok: true,
      record,
      warnings,
      message:
        "Closing notes emailed to " +
        recipients.length +
        " recipient" +
        (recipients.length === 1 ? "" : "s") +
        ".",
    };
  });
}

function lfCanEditInspection_(user, inspection) {
  if (yes_(user.IsAdmin) || norm_(user.Role) === "admin") return true;
  const station = String(inspection.WorkingStation || inspection.Station || "");
  return (
    allowedStations_(user).includes(station) &&
    storedDay_(inspection.CompletedAt || inspection.InspectionDate) === day_()
  );
}

function lfEditInspection_(session, input, operationId) {
  return lock_(() => {
    const ss = db_();
    lfEnsureSheets_(ss);
    const user = user_(session.email);
    const inspection = find_(
      ss,
      APP.SHEETS.inspections,
      "InspectionID",
      input.inspectionId,
    );
    if (!inspection || inspection.InspectionState !== "Completed")
      throw new Error("Completed inspection not found.");
    if (!lfCanEditInspection_(user, inspection))
      throw new Error("Permission required to edit this inspection.");
    const actualVersion =
      inspection.UpdatedAt || inspection.EditedAt || inspection.CompletedAt;
    const expectedVersion = Number(input.expectedVersion || 0);
    const storedVersion = Number(inspection.Version || 0);
    const versionIsCurrent =
      expectedVersion > 0 && expectedVersion === storedVersion;
    const timestampIsCurrent =
      !!input.expectedUpdatedAt &&
      lfSameMoment_(input.expectedUpdatedAt, actualVersion);
    const stale = expectedVersion > 0 ? !versionIsCurrent : !timestampIsCurrent;
    const sameEditor =
      inspection.EditedByEmail &&
      norm_(inspection.EditedByEmail) === norm_(session.email);
    const neverEdited = !norm_(inspection.EditedByEmail);
    if (
      stale &&
      !sameEditor &&
      !neverEdited
    )
      throw new Error(
        "CONFLICT: this inspection has a newer version. Synchronize before saving your changes.",
      );
    const station = String(input.station || inspection.Station || "");
    if (!APP.STATIONS.includes(station))
      throw new Error("Select a valid van location.");
    const atShop = station === "SHOP";
    const status = atShop ? "Grounded" : String(input.status || "");
    if (!APP.STATUSES.includes(status))
      throw new Error("Select a valid van status.");
    let spot = "SHOP";
    if (!atShop) {
      const spotRow = find_(ss, APP.SHEETS.spots, "SpotID", input.spotId);
      if (
        !spotRow ||
        String(spotRow.Station) !== station ||
        !yes_(spotRow.Active)
      )
        throw new Error("Select an available spot.");
      const owner = completedSpotOwner_(
        ss,
        station,
        spotRow.Spot,
        inspection.VanID,
      );
      if (owner)
        throw new Error(
          "CONFLICT: spot " + spotRow.Spot + " is occupied by another van.",
        );
      spot = String(spotRow.Spot);
    }
    const notes = String(input.notes || "").trim();
    const hasDamage = rows_(ss.getSheetByName(APP.SHEETS.damages)).some(
      (damage) =>
        String(damage.InspectionID) === String(inspection.InspectionID),
    );
    let newDamageFound = String(input.newDamageFound || "");
    if (hasDamage) newDamageFound = "Yes";
    if (!["Yes", "No"].includes(newDamageFound))
      throw new Error("Select whether new damage was found.");
    if (
      newDamageFound === "Yes" &&
      !hasDamage &&
      inspection.NewDamageFound !== "Yes"
    )
      throw new Error("Take a close-up photo of the new damage.");
    const now = new Date();
    const version = Number(inspection.Version || 0) + 1;
    const changed = lfChangedFields_(
      inspection,
      {
        Station: station,
        Spot: spot,
        Status: status,
        Notes: notes,
        NewDamageFound: newDamageFound,
      },
      ["Station", "Spot", "Status", "Notes", "NewDamageFound"],
    );
    clearVanSpot_(ss, inspection.VanID);
    if (!atShop) {
      displacePendingSpot_(ss, station, spot, inspection.VanID);
      occupy_(ss, station, spot, inspection.VanID);
    }
    update_(
      ss.getSheetByName(APP.SHEETS.inspections),
      "InspectionID",
      inspection.InspectionID,
      {
        Station: station,
        Spot: spot,
        Status: status,
        Notes: notes,
        NewDamageFound: newDamageFound,
        UpdatedAt: now,
        EditedAt: now,
        EditedByEmail: session.email,
        Version: version,
        LastOperationID: operationId,
      },
    );
    const van = find_(ss, APP.SHEETS.vans, "VanID", inspection.VanID);
    if (
      van &&
      String(van.LastInspectionID || "") === String(inspection.InspectionID)
    ) {
      update_(ss.getSheetByName(APP.SHEETS.vans), "VanID", inspection.VanID, {
        HomeStation: APP.WORK_STATIONS.includes(station)
          ? station
          : vanStation_(van),
        CurrentStation: station,
        CurrentSpot: spot,
        CurrentStatus: status,
        UpdatedAt: now,
      });
    }
    audit_(
      session.email,
      "EDIT_COMPLETED_INSPECTION",
      "INSPECTION",
      inspection.InspectionID,
      JSON.stringify(changed),
    );
    lfClearAppCache_(session.email, workingStation_(user));
    return {
      ok: true,
      inspection: find_(
        ss,
        APP.SHEETS.inspections,
        "InspectionID",
        inspection.InspectionID,
      ),
      van: find_(ss, APP.SHEETS.vans, "VanID", inspection.VanID),
      changes: changed,
      message: "Inspection changes synchronized.",
    };
  });
}

function getEditableInspection(token, inspectionId) {
  const session = auth_(token);
  const ss = db_();
  const user = user_(session.email);
  lfEnsureSheets_(ss);
  const inspection = find_(
    ss,
    APP.SHEETS.inspections,
    "InspectionID",
    inspectionId,
  );
  if (!inspection || inspection.InspectionState !== "Completed")
    throw new Error("Completed inspection not found.");
  if (!lfCanEditInspection_(user, inspection))
    throw new Error("Permission required to edit this inspection.");
  return {
    inspection,
    photos: rows_(ss.getSheetByName(APP.SHEETS.photos)).filter(
      (photo) =>
        String(photo.InspectionID) === String(inspectionId) &&
        APP.PARTS.includes(photo.Part),
    ),
    damages: rows_(ss.getSheetByName(APP.SHEETS.damages)).filter(
      (damage) => String(damage.InspectionID) === String(inspectionId),
    ),
    requiredParts: APP.PARTS,
    statuses: APP.STATUSES,
    mediaLoaded: true,
    spots: rows_(ss.getSheetByName(APP.SHEETS.spots))
      .filter((spot) => yes_(spot.Active))
      .map((spot) => ({
        SpotID: String(spot.SpotID),
        Station: String(spot.Station),
        Spot: String(spot.Spot),
        OccupiedByVanID: String(spot.OccupiedByVanID || ""),
      })),
    audit: rowsTail_(ss.getSheetByName(APP.SHEETS.audit), 500)
      .filter(
        (event) =>
          String(event.EntityType) === "INSPECTION" &&
          String(event.EntityID) === String(inspectionId) &&
          String(event.Action).includes("EDIT"),
      )
      .sort(
        (left, right) =>
          new Date(right.Timestamp || 0) - new Date(left.Timestamp || 0),
      )
      .slice(0, 20),
  };
}
