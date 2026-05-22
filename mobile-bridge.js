(function () {
  "use strict";

  const DEVICE_ID_KEY = "wms365-mobile-device-id";
  const COMPANY_CONTEXT_KEY = "wms365-mobile-company-context";
  const LEGACY_COUNT_COMPANY_KEY = "wms365_inventory_count_company";
  const QUEUE_DB_NAME = "wms365-mobile-offline";
  const QUEUE_DB_VERSION = 1;
  const QUEUE_STORE = "transactions";

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

  function envelope(payload, actionType) {
    return {
      ...(payload || {}),
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
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Offline storage is unavailable."));
    });
  }

  async function queueTransaction({ url, method = "POST", payload = {}, actionType = "" }) {
    const db = await openQueueDb();
    const record = {
      localId: `txn-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      url,
      method,
      payload: envelope(payload, actionType),
      actionType,
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
        const db = await openQueueDb();
        await new Promise((resolve, reject) => {
          const tx = db.transaction(QUEUE_STORE, "readwrite");
          tx.objectStore(QUEUE_STORE).delete(record.localId);
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error || new Error("Unable to clear synced transaction."));
        });
        db.close();
        synced += 1;
      } catch (error) {
        failed += 1;
        const db = await openQueueDb();
        await new Promise((resolve, reject) => {
          const tx = db.transaction(QUEUE_STORE, "readwrite");
          tx.objectStore(QUEUE_STORE).put({
            ...record,
            status: "FAILED",
            attempts: (Number(record.attempts) || 0) + 1,
            lastError: error.message || "Sync failed",
            updatedAt: new Date().toISOString()
          });
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error || new Error("Unable to update failed transaction."));
        });
        db.close();
        break;
      }
    }
    window.dispatchEvent(new CustomEvent("wms365:queue-changed", { detail: { synced, failed } }));
    return { synced, failed };
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
    envelope,
    vibrate,
    beep,
    setKeepAwake,
    isOnline,
    clearWebData,
    scanBarcode,
    queueTransaction,
    getQueuedTransactions,
    syncQueue,
    registerServiceWorker
  };

  window.addEventListener("online", () => syncQueue().catch(() => {}));
  registerServiceWorker();
})();
