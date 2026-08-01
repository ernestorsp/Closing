export class ClosingApiError extends Error {
  constructor(message, { status = 0, code = 'UNKNOWN', details = null } = {}) {
    super(message);
    this.name = 'ClosingApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class ClosingApiClient {
  constructor({ baseUrl, getIdToken, fetchImpl = fetch, timeoutMs = 15000 }) {
    this.baseUrl = String(baseUrl || '').replace(/\/$/, '');
    this.getIdToken = getIdToken;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async request(path, { method = 'GET', body, idempotencyKey, timeoutMs = this.timeoutMs } = {}) {
    if (!this.baseUrl) throw new ClosingApiError('Cloud API URL is not configured.', { code: 'API_NOT_CONFIGURED' });
    const token = await this.getIdToken();
    if (!token) throw new ClosingApiError('Firebase sign-in is required.', { status: 401, code: 'UNAUTHENTICATED' });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(idempotencyKey ? { 'x-request-id': idempotencyKey } : {})
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      if (response.status === 204) return null;
      const payload = await response.json().catch(() => null);
      if (!response.ok || payload?.ok === false) {
        throw new ClosingApiError(payload?.error?.message || `Request failed (${response.status}).`, {
          status: response.status,
          code: payload?.error?.code || 'HTTP_ERROR',
          details: payload?.error?.details || null
        });
      }
      return payload;
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new ClosingApiError('The request timed out.', { code: 'TIMEOUT' });
      }
      if (error instanceof ClosingApiError) throw error;
      throw new ClosingApiError(error?.message || 'Network request failed.', { code: 'NETWORK_ERROR' });
    } finally {
      clearTimeout(timer);
    }
  }

  claimInspection({ vanId, inspectionId }) {
    return this.request('/v1/inspection-locks/claim', {
      method: 'POST', body: { vanId, inspectionId }, idempotencyKey: `claim:${inspectionId}`
    });
  }

  renewInspection({ vanId, inspectionId }) {
    return this.request('/v1/inspection-locks/renew', {
      method: 'POST', body: { vanId, inspectionId }, idempotencyKey: `renew:${inspectionId}`
    });
  }

  releaseInspection(vanId) {
    return this.request(`/v1/inspection-locks/${encodeURIComponent(vanId)}`, { method: 'DELETE' });
  }

  finishInspection(payload) {
    return this.request('/v1/inspections/finish', {
      method: 'POST', body: payload, idempotencyKey: `finish:${payload.inspectionId}`,
      timeoutMs: 30000
    });
  }
}

export function createInspectionLockHeartbeat({ api, getCurrent, intervalMs = 90_000, onLost }) {
  let timer = null;
  const tick = async () => {
    const current = getCurrent();
    if (!current?.vanId || !current?.inspectionId) return;
    try {
      await api.renewInspection(current);
    } catch (error) {
      if (['LOCK_NOT_OWNED', 'LOCK_EXPIRED', 'VAN_LOCKED'].includes(error.code)) onLost?.(error);
    }
  };
  return {
    start() {
      if (timer) return;
      timer = setInterval(tick, intervalMs);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    tick
  };
}
