(function () {
  "use strict";

  const DEVICE_ID_KEY = "wms365-mobile-device-id";
  const COMPANY_CONTEXT_KEY = "wms365-mobile-company-context";
  const LEGACY_COUNT_COMPANY_KEY = "wms365_inventory_count_company";
  const QUEUE_DB_NAME = "wms365-mobile-offline";
  const QUEUE_DB_VERSION = 2;
  const QUEUE_STORE = "transactions";
  const CACHE_STORE = "cache";

  function isAndroidApp() {
    return !!window.WMS365Android;
  }

  function isIos() {
    return /iphone|ipad|ipod/i.test(String(navigator.userAgent || ""));
  }

  function makeDeviceId() {
    if (window.crypto?.randomUUID) return `web-${window.crypto.randomUUID()}`;
    return `web-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
  }

  function getDeviceId() {
    try {
      const androidId = window.WMS365Android?.getDeviceId?.();
      if (androidId) return `android-${androidId}`;
    } catch {}
    try {
      const existing = localStorage.getItem(DEVICE_ID_KEY);
      if (existing) return existing;
      const next = makeDeviceId();
      localStorage.setItem(DEVICE_ID_KEY, next);
      return next;
    } catch {
      return makeDeviceId();
    }
  }

  function getSource() {
    return isAndroidApp() ? "android_app" : "mobile_web";
  }

  function normalizeCompany(value) {
    return String(value || "").trim().replace(/\s+/g, " ").toUpperCase();
  }

  function getCompanyContext() {
    try {
      return normalizeCompany(
        localStorage.getItem(COMPANY_CONTEXT_KEY)
        || localStorage.getItem(LEGACY_COUNT_COMPANY_KEY)
        || ""
      );
    } catch {
      return "";
    }
  }

  function setCompanyContext(company) {
    const normalized = normalizeCompany(company);
    try {
      if (normalized) {
        localStorage.setItem(COMPANY_CONTEXT_KEY, normalized);
        localStorage.setItem(LEGACY_COUNT_COMPANY_KEY, normalized);
      } else {
        localStorage.removeItem(COMPANY_CONTEXT_KEY);
        localStorage.removeItem(LEGACY_COUNT_COMPANY_KEY);
      }
    } catch {}
    window.dispatchEvent(new CustomEvent("wms365:company-context", { detail: { company: normalized } }));
    return normalized;
  }

  function clearCompanyContext() {
    return setCompanyContext("");
  }

  function getPlatform() {
    try {
      const platform = window.WMS365Android?.getPlatform?.();
      if (platform) return platform;
    } catch {}
    if (isAndroidApp()) return "android";
    if (isIos()) return "ios";
    return /android/i.test(String(navigator.userAgent || "")) ? "android_browser" : "web";
  }

  function getAppVersion() {
    try {
      return window.WMS365Android?.getAppVersion?.() || "web";
    } catch {
      return "web";
    }
  }

  function getAuditContext(actionType) {
    const timestamp = new Date().toISOString();
    const deviceId = getDeviceId();
    const platform = getPlatform();
    const appVersion = getAppVersion();
    return {
      source: getSource(),
      deviceId,
      device_id: deviceId,
      platform,
      appVersion,
      app_version: appVersion,
      actionType: String(actionType || "").trim(),
      action_type: String(actionType || "").trim(),
      clientTimestamp: timestamp,
      client_timestamp: timestamp
    };
  }

  function makeIdempotencyKey(actionType = "mobile") {
    const prefix = String(actionType || "mobile").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "mobile";
    if (window.crypto?.randomUUID) return `${prefix}-${window.crypto.randomUUID()}`;
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
  }

  function withIdempotency(payload, actionType) {
    const next = { ...(payload || {}) };
    const existing = next.idempotencyKey || next.idempotency_key || next.auditContext?.idempotencyKey || "";
    const key = existing || makeIdempotencyKey(actionType);
    next.idempotencyKey = key;
    next.idempotency_key = key;
    return next;
  }

  function envelope(payload, actionType) {
    const body = withIdempotency(payload, actionType);
    return {
      ...body,
      ...getAuditContext(actionType)
    };
  }

  function vibrate(durationMs = 45) {
    try {
      window.WMS365Android?.vibrate?.(Number(durationMs) || 45);
      return;
    } catch {}
    try {
      navigator.vibrate?.(Number(durationMs) || 45);
    } catch {}
  }

  function beep(type = "success") {
    try {
      window.WMS365Android?.beep?.(type);
    } catch {}
  }

  function setKeepAwake(enabled) {
    try {
      window.WMS365Android?.setKeepScreenAwake?.(!!enabled);
    } catch {}
  }

  function isOnline() {
    try {
      if (typeof window.WMS365Android?.isOnline === "function") return !!window.WMS365Android.isOnline();
    } catch {}
    return navigator.onLine !== false;
  }

  function clearWebData() {
    try {
      window.WMS365Android?.clearWebData?.();
    } catch {}
  }

  function scanBarcode(targetId, fallback) {
    try {
      if (window.WMS365Android?.scanBarcode) {
        window.WMS365Android.scanBarcode(String(targetId || ""));
        return true;
      }
    } catch {}
    if (typeof fallback === "function") fallback();
    return false;
  }

  function openQueueDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(QUEUE_DB_NAME, QUEUE_DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(QUEUE_STORE)) {
          const store = db.createObjectStore(QUEUE_STORE, { keyPath: "localId" });
          store.createIndex("status", "status", { unique: false });
          store.createIndex("createdAt", "createdAt", { unique: false });
        }
        if (!db.objectStoreNames.contains(CACHE_STORE)) {
          db.createObjectStore(CACHE_STORE, { keyPath: "key" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Offline storage is unavailable."));
    });
  }

  async function putQueueRecord(record) {
    const db = await openQueueDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(QUEUE_STORE, "readwrite");
      tx.objectStore(QUEUE_STORE).put(record);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error("Unable to update offline queue."));
    });
    db.close();
    return record;
  }

  async function deleteQueueRecord(localId) {
    const db = await openQueueDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(QUEUE_STORE, "readwrite");
      tx.objectStore(QUEUE_STORE).delete(localId);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error("Unable to clear synced transaction."));
    });
    db.close();
  }

  async function queueTransaction({ url, method = "POST", payload = {}, actionType = "" }) {
    const body = envelope(payload, actionType);
    const db = await openQueueDb();
    const record = {
      localId: `txn-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      url,
      method,
      payload: body,
      actionType,
      idempotencyKey: body.idempotencyKey || body.idempotency_key || "",
      status: "PENDING",
      attempts: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await new Promise((resolve, reject) => {
      const tx = db.transaction(QUEUE_STORE, "readwrite");
      tx.objectStore(QUEUE_STORE).put(record);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error("Unable to queue transaction."));
    });
    db.close();
    window.dispatchEvent(new CustomEvent("wms365:queue-changed", { detail: { status: "PENDING" } }));
    return record;
  }

  async function getQueuedTransactions() {
    const db = await openQueueDb();
    const records = await new Promise((resolve, reject) => {
      const tx = db.transaction(QUEUE_STORE, "readonly");
      const request = tx.objectStore(QUEUE_STORE).getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error || new Error("Unable to read offline queue."));
    });
    db.close();
    return records;
  }

  async function getQueueSummary(actionTypes = []) {
    const filter = new Set((Array.isArray(actionTypes) ? actionTypes : [actionTypes]).filter(Boolean));
    const records = await getQueuedTransactions();
    return records
      .filter((record) => !filter.size || filter.has(record.actionType))
      .reduce((summary, record) => {
        const status = record.status === "FAILED" ? "failed" : "pending";
        summary[status] += 1;
        summary.total += 1;
        return summary;
      }, { pending: 0, failed: 0, total: 0 });
  }

  async function cacheData(key, payload) {
    const cacheKey = String(key || "").trim();
    if (!cacheKey) return null;
    const db = await openQueueDb();
    const record = {
      key: cacheKey,
      payload,
      cachedAt: new Date().toISOString(),
      source: getSource(),
      appVersion: getAppVersion()
    };
    await new Promise((resolve, reject) => {
      const tx = db.transaction(CACHE_STORE, "readwrite");
      tx.objectStore(CACHE_STORE).put(record);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error("Unable to cache device data."));
    });
    db.close();
    return record;
  }

  async function getCachedData(key, { maxAgeMs = 0 } = {}) {
    const cacheKey = String(key || "").trim();
    if (!cacheKey) return null;
    const db = await openQueueDb();
    const record = await new Promise((resolve, reject) => {
      const tx = db.transaction(CACHE_STORE, "readonly");
      const request = tx.objectStore(CACHE_STORE).get(cacheKey);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error("Unable to read cached device data."));
    });
    db.close();
    if (!record) return null;
    const age = Date.now() - Date.parse(record.cachedAt || "");
    if (maxAgeMs && Number.isFinite(age) && age > maxAgeMs) return null;
    return record;
  }

  async function syncQueue() {
    if (!navigator.onLine) return { synced: 0, failed: 0 };
    const records = (await getQueuedTransactions()).filter((record) => record.status !== "SYNCED");
    let synced = 0;
    let failed = 0;
    for (const record of records.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))) {
      try {
        const response = await fetch(record.url, {
          method: record.method || "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(record.payload || {})
        });
        if (!response.ok) throw new Error(`Sync failed (${response.status})`);
        await deleteQueueRecord(record.localId);
        synced += 1;
      } catch (error) {
        failed += 1;
        await putQueueRecord({
          ...record,
          status: "FAILED",
          attempts: (Number(record.attempts) || 0) + 1,
          lastError: error.message || "Sync failed",
          updatedAt: new Date().toISOString()
        });
        break;
      }
    }
    window.dispatchEvent(new CustomEvent("wms365:queue-changed", { detail: { synced, failed } }));
    return { synced, failed };
  }

  async function retryFailedTransactions(actionTypes = []) {
    const filter = new Set((Array.isArray(actionTypes) ? actionTypes : [actionTypes]).filter(Boolean));
    const failed = (await getQueuedTransactions()).filter((record) => record.status === "FAILED" && (!filter.size || filter.has(record.actionType)));
    for (const record of failed) {
      await putQueueRecord({ ...record, status: "PENDING", updatedAt: new Date().toISOString() });
    }
    window.dispatchEvent(new CustomEvent("wms365:queue-changed", { detail: { retrying: failed.length } }));
    return syncQueue();
  }

  async function queueOrSendTransaction({ url, method = "POST", payload = {}, actionType = "", queueOnStatus = [0, 408, 429, 500, 502, 503, 504] }) {
    const body = envelope(payload, actionType);
    if (!isOnline()) {
      const record = await queueTransaction({ url, method, payload: body, actionType });
      return { queued: true, record };
    }
    try {
      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const text = await response.text();
      const data = text ? JSON.parse(text) : {};
      if (!response.ok) {
        const error = new Error(data.error || `Request failed (${response.status})`);
        error.status = response.status;
        error.data = data;
        throw error;
      }
      window.dispatchEvent(new CustomEvent("wms365:queue-changed", { detail: { synced: 1 } }));
      return { queued: false, data };
    } catch (error) {
      const status = Number(error.status) || 0;
      if (!navigator.onLine || queueOnStatus.includes(status) || status >= 500) {
        const record = await queueTransaction({ url, method, payload: body, actionType });
        return { queued: true, record, error };
      }
      throw error;
    }
  }

  async function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return false;
    if (!/^https:$/i.test(location.protocol) && location.hostname !== "localhost") return false;
    try {
      const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      return !!registration;
    } catch {
      return false;
    }
  }

  window.WMS365Mobile = {
    isAndroidApp,
    isIos,
    getDeviceId,
    getSource,
    getCompanyContext,
    setCompanyContext,
    clearCompanyContext,
    getPlatform,
    getAppVersion,
    getAuditContext,
    makeIdempotencyKey,
    envelope,
    vibrate,
    beep,
    setKeepAwake,
    isOnline,
    clearWebData,
    scanBarcode,
    queueTransaction,
    queueOrSendTransaction,
    getQueuedTransactions,
    getQueueSummary,
    retryFailedTransactions,
    cacheData,
    getCachedData,
    syncQueue,
    registerServiceWorker
  };

  window.addEventListener("online", () => syncQueue().catch(() => {}));
  registerServiceWorker();
})();
