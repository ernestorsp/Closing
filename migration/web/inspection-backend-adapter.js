import { firebaseRuntime } from './firebase-runtime.js';
import { createInspectionLockHeartbeat } from './firebase-api-client.js';

export class InspectionBackendAdapter {
  constructor({ appsScript, onLockLost } = {}) {
    this.appsScript = appsScript;
    this.api = firebaseRuntime.api();
    this.current = null;
    this.heartbeat = createInspectionLockHeartbeat({
      api: this.api,
      getCurrent: () => this.current,
      onLost: error => {
        this.current = null;
        this.heartbeat.stop();
        onLockLost?.(error);
      }
    });
  }

  get cloudEnabled() {
    return firebaseRuntime.enabled;
  }

  async claim({ vanId, inspectionId }) {
    if (!this.cloudEnabled) return this.appsScript.claim({ vanId, inspectionId });
    const result = await this.api.claimInspection({ vanId, inspectionId });
    this.current = { vanId: String(vanId), inspectionId: String(inspectionId) };
    this.heartbeat.start();
    return result;
  }

  async finish(payload) {
    if (!this.cloudEnabled) return this.appsScript.finish(payload);
    const normalized = {
      inspectionId: String(payload.inspectionId),
      vanId: String(payload.vanId),
      station: String(payload.station),
      spot: payload.station === 'SHOP' ? '' : String(payload.spot || ''),
      status: payload.status,
      notes: payload.notes || '',
      damageFound: payload.damageFound === true || payload.newDamageFound === 'Yes'
    };
    try {
      return await this.api.finishInspection(normalized);
    } catch (error) {
      if (['NETWORK_ERROR', 'TIMEOUT'].includes(error.code)) {
        await firebaseRuntime.queue.add('FINISH_INSPECTION', normalized, {
          id: `finish:${normalized.inspectionId}`
        });
        return { ok: true, queued: true, inspectionId: normalized.inspectionId };
      }
      throw error;
    } finally {
      this.current = null;
      this.heartbeat.stop();
    }
  }

  async release(vanId) {
    if (!this.cloudEnabled) return this.appsScript.release(vanId);
    this.current = null;
    this.heartbeat.stop();
    return this.api.releaseInspection(vanId);
  }

  installOfflineSync({ onSynced, onError } = {}) {
    return firebaseRuntime.queue.installAutoSync({
      FINISH_INSPECTION: async payload => {
        try {
          const result = await this.api.finishInspection(payload);
          onSynced?.(result, payload);
        } catch (error) {
          onError?.(error, payload);
          throw error;
        }
      }
    });
  }
}
