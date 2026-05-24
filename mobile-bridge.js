(function () {
  "use strict";

  const DEVICE_ID_KEY = "wms365-mobile-device-id";
  const COMPANY_CONTEXT_KEY = "wms365-mobile-company-context";
  const LEGACY_COUNT_COMPANY_KEY = "wms365_inventory_count_company";
  const QUEUE_DB_NAME = "wms365-mobile-offline";
  const QUEUE_DB_VERSION = 2;
  const QUEUE_STORE = "transactions";
  const CACHE_STORE = "cache";
  const WAREHOUSE_STATE_CACHE_KEY = "warehouse-state-v1";
  const MOBILE_PRELOAD_CACHE_KEY = "warehouse-preload-v1";
  const DEVICE_PROFILE_CACHE_KEY = "wms365-device-profiles-v1";
  const DEVICE_PROFILE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
  const PICK_ORDERS_CACHE_PREFIX = "mobile-pick-orders";
  const COMPANY_FAST_CACHE_PREFIX = "warehouse-fast";
  const COMPANY_INDEX_CACHE_KEY = "warehouse-company-index-v1";
  let preloadPromise = null;
  let deviceProfilesPromise = null;
  let activeDeviceProfile = null;
  let wakeLock = null;

  function yieldToBrowser(delay = 0) {
    return new Promise((resolve) => setTimeout(resolve, delay));
  }

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

  function textContainsAny(text, values) {
    const haystack = String(text || "").toLowerCase();
    return Array.isArray(values) && values.some((value) => haystack.includes(String(value || "").toLowerCase()));
  }

  function getDeviceManufacturer() {
    try {
      return window.WMS365Android?.getDeviceManufacturer?.() || "";
    } catch {
      return "";
    }
  }

  function getDeviceBrand() {
    try {
      return window.WMS365Android?.getDeviceBrand?.() || "";
    } catch {
      return "";
    }
  }

  function getDeviceModel() {
    try {
      return window.WMS365Android?.getDeviceModel?.() || "";
    } catch {}
    return [navigator.platform || "", navigator.userAgent || ""].filter(Boolean).join(" ").trim();
  }

  function matchDeviceProfile(profile) {
    const match = profile?.match || {};
    return textContainsAny(getDeviceManufacturer(), match.manufacturerContains)
      || textContainsAny(getDeviceBrand(), match.brandContains)
      || textContainsAny(getDeviceModel(), match.modelContains)
      || textContainsAny(navigator.userAgent || getPlatform(), match.platformContains);
  }

  function fallbackDeviceProfile() {
    const android = /android/i.test(String(navigator.userAgent || "")) || getPlatform().startsWith("android");
    return {
      id: android ? "generic-android-phone" : "mobile-web",
      name: android ? "Generic Android phone" : "Mobile browser",
      status: "detected",
      scannerMode: "camera",
      showSoftKeyboardForScanFields: true,
      androidOptimizations: {
        useHardwareScannerBeforeCamera: false,
        cacheWarehouseDataLocally: true,
        preloadCompanyDataOnStartup: true,
        largeButtonsForGloves: true
      }
    };
  }

  function selectDeviceProfile(profiles = []) {
    const matched = profiles.find(matchDeviceProfile)
      || profiles.find((profile) => profile.id === "generic-android-phone")
      || fallbackDeviceProfile();
    activeDeviceProfile = matched;
    window.dispatchEvent(new CustomEvent("wms365:device-profile", { detail: { profile: matched } }));
    applyDeviceProfileToPage();
    return matched;
  }

  async function loadDeviceProfile({ force = false } = {}) {
    if (activeDeviceProfile && !force) return activeDeviceProfile;
    if (deviceProfilesPromise && !force) return deviceProfilesPromise;
    deviceProfilesPromise = (async () => {
      let payload = null;
      if (!force) {
        const cached = await getCachedData(DEVICE_PROFILE_CACHE_KEY, { maxAgeMs: DEVICE_PROFILE_MAX_AGE_MS }).catch(() => null);
        payload = cached?.payload || null;
      }
      if (!payload && isOnline()) {
        payload = await fetchJsonForCache("/device-profiles.json").catch(() => null);
        if (payload) await cacheData(DEVICE_PROFILE_CACHE_KEY, payload).catch(() => {});
      }
      return selectDeviceProfile(Array.isArray(payload?.profiles) ? payload.profiles : []);
    })().finally(() => {
      deviceProfilesPromise = null;
    });
    return deviceProfilesPromise;
  }

  function getDeviceProfile() {
    return activeDeviceProfile || fallbackDeviceProfile();
  }

  function getDeviceProfileId() {
    return getDeviceProfile().id || "";
  }

  function hasHardwareScanner() {
    try {
      if (typeof window.WMS365Android?.hasHardwareScanner === "function") {
        return !!window.WMS365Android.hasHardwareScanner();
      }
    } catch {}
    const profile = getDeviceProfile();
    if (profile?.showSoftKeyboardForScanFields === false && /hardware|wedge|datawedge/i.test(String(profile?.scannerMode || ""))) {
      return true;
    }
    return false;
  }

  function getScannerProfile() {
    try {
      if (typeof window.WMS365Android?.getScannerProfile === "function") {
        return window.WMS365Android.getScannerProfile() || (hasHardwareScanner() ? "hardware_wedge" : "camera");
      }
    } catch {}
    return getDeviceProfile()?.scannerMode || (hasHardwareScanner() ? "hardware_wedge" : "camera");
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
      return;
    } catch {}
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;
      const context = new AudioContext();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = String(type).toLowerCase() === "error" ? 220 : 880;
      gain.gain.setValueAtTime(0.0001, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.06, context.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.12);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + 0.13);
      setTimeout(() => context.close?.(), 220);
    } catch {}
  }

  function setKeepAwake(enabled) {
    try {
      window.WMS365Android?.setKeepScreenAwake?.(!!enabled);
      return;
    } catch {}
    if (!("wakeLock" in navigator)) return;
    if (enabled) {
      if (wakeLock) return;
      navigator.wakeLock.request("screen")
        .then((lock) => {
          wakeLock = lock;
          wakeLock.addEventListener?.("release", () => { wakeLock = null; });
        })
        .catch(() => {});
      return;
    }
    try {
      wakeLock?.release?.();
    } catch {}
    wakeLock = null;
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

  function prepareScanTarget(targetId) {
    const target = document.getElementById(String(targetId || ""));
    if (!target) return false;
    try {
      target.focus({ preventScroll: false });
      if (typeof target.select === "function") target.select();
    } catch {
      try { target.focus(); } catch {}
    }
    return true;
  }

  function scanBarcode(targetId, fallback) {
    prepareScanTarget(targetId);
    try {
      if (window.WMS365Android?.scanBarcode) {
        window.WMS365Android.scanBarcode(String(targetId || ""));
        return true;
      }
    } catch {}
    if (hasHardwareScanner()) return true;
    if (typeof fallback === "function") fallback();
    return false;
  }

  function scanPlaceholderFor(id) {
    if (/location/i.test(id)) return "Scan location";
    if (/sku|upc/i.test(id)) return "Scan SKU";
    if (/lot/i.test(id)) return "Scan lot";
    if (/order/i.test(id)) return "Scan order";
    return "Scan barcode";
  }

  function applyDeviceProfileToPage() {
    const profile = getDeviceProfile();
    const hardware = hasHardwareScanner();
    if (document.body) {
      document.body.dataset.deviceProfile = profile.id || "";
      document.body.classList.toggle("device-profile-hardware-scanner", hardware);
      document.body.classList.toggle("device-profile-camera-scanner", !hardware);
    }
    document.querySelectorAll("[data-scan-target]").forEach((button) => {
      const targetId = String(button.dataset.scanTarget || "");
      button.textContent = hardware ? "Trigger" : "Scan";
      button.title = hardware ? "Press the physical scanner trigger." : "Open camera scanner.";
      const target = document.getElementById(targetId);
      if (!target) return;
      if (hardware) {
        target.placeholder = scanPlaceholderFor(targetId);
        if (!isAndroidApp() && profile?.showSoftKeyboardForScanFields === false) {
          target.setAttribute("inputmode", "none");
          target.title = "Tap this field, then press the physical scanner trigger.";
        }
      } else if (!target.getAttribute("inputmode")) {
        target.removeAttribute("inputmode");
      }
    });
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

  function compactStatePayload(payload) {
    return {
      inventory: payload?.inventory || [],
      inventoryCounts: payload?.inventoryCounts || [],
      warehouseTasks: payload?.warehouseTasks || [],
      pallets: payload?.pallets || [],
      activity: payload?.activity || [],
      masters: payload?.masters || {},
      billing: payload?.billing || {},
      session: payload?.session || {},
      meta: payload?.meta || {}
    };
  }

  function deriveCompanies(payload) {
    const values = []
      .concat(payload?.masters?.owners || [])
      .concat((payload?.inventory || []).map((line) => line.accountName))
      .concat((payload?.inventoryCounts || []).map((count) => count.accountName))
      .concat((payload?.warehouseTasks || []).map((task) => task.accountName))
      .concat(payload?.session?.appUser?.assignedCompanies || [])
      .concat(payload?.session?.appUser?.inheritedCompanies || []);
    return [...new Set(values.map(normalizeCompany).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  }

  function pickOrdersCacheKey(company = "") {
    const normalized = normalizeCompany(company);
    return `${PICK_ORDERS_CACHE_PREFIX}:${normalized || "all"}`;
  }

  function companyFastCacheKey(company = "") {
    const normalized = normalizeCompany(company);
    return `${COMPANY_FAST_CACHE_PREFIX}:${normalized || "all"}`;
  }

  function matchesCompany(record, company) {
    const normalized = normalizeCompany(company);
    if (!normalized) return true;
    const candidates = [
      record?.accountName,
      record?.account_name,
      record?.owner,
      record?.ownerName,
      record?.company,
      record?.companyName,
      record?.customer,
      record?.customerName
    ].map(normalizeCompany).filter(Boolean);
    return candidates.includes(normalized);
  }

  function companySlice(compactState, company) {
    const normalized = normalizeCompany(company);
    const masters = compactState?.masters || {};
    const ownerRecords = Array.isArray(masters.ownerRecords) ? masters.ownerRecords : [];
    const ownerRecord = ownerRecords.find((owner) => matchesCompany(owner, normalized)) || null;
    const locations = Array.isArray(masters.locations)
      ? masters.locations.filter((location) => !normalized || matchesCompany(location, normalized) || !normalizeCompany(location?.accountName || location?.owner || location?.companyName))
      : [];
    const companyFulfillmentLocations = Array.isArray(masters.companyFulfillmentLocations)
      ? masters.companyFulfillmentLocations.filter((location) => matchesCompany(location, normalized))
      : [];
    return {
      accountName: normalized,
      cachedAt: new Date().toISOString(),
      inventory: (compactState?.inventory || []).filter((line) => matchesCompany(line, normalized)),
      inventoryCounts: (compactState?.inventoryCounts || []).filter((count) => matchesCompany(count, normalized)),
      warehouseTasks: (compactState?.warehouseTasks || []).filter((task) => matchesCompany(task, normalized)),
      pallets: (compactState?.pallets || []).filter((pallet) => matchesCompany(pallet, normalized)),
      items: (masters.items || []).filter((item) => matchesCompany(item, normalized)),
      locations,
      ownerRecord,
      fulfillmentLocations: companyFulfillmentLocations,
      partners: masters.partners || [],
      session: compactState?.session || {},
      meta: compactState?.meta || {}
    };
  }

  async function cacheCompanyFastSlices(compactState, companies, allCompanies = companies) {
    const normalizedCompanies = [...new Set((companies || []).map(normalizeCompany).filter(Boolean))];
    const normalizedAllCompanies = [...new Set((allCompanies || []).map(normalizeCompany).filter(Boolean))];
    const slices = [];
    for (const company of normalizedCompanies) {
      await yieldToBrowser();
      const slice = companySlice(compactState, company);
      await cacheData(companyFastCacheKey(company), slice);
      slices.push({
        accountName: company,
        inventory: slice.inventory.length,
        counts: slice.inventoryCounts.length,
        tasks: slice.warehouseTasks.length,
        items: slice.items.length,
        locations: slice.locations.length,
        pallets: slice.pallets.length
      });
    }
    await cacheData(COMPANY_INDEX_CACHE_KEY, {
      companies: normalizedAllCompanies,
      slices,
      cachedAt: new Date().toISOString()
    });
    return slices;
  }

  async function getCompanyFastData(company, options = {}) {
    const record = await getCachedData(companyFastCacheKey(company), options);
    return record?.payload || null;
  }

  async function fetchJsonForCache(url) {
    const response = await fetch(url, {
      cache: "no-store",
      headers: { "Content-Type": "application/json" }
    });
    const text = await response.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = {};
    }
    if (!response.ok) {
      const error = new Error(data.error || `Request failed (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return data;
  }

  async function fetchPickOrdersForCache(company = "") {
    const normalized = normalizeCompany(company);
    const query = normalized ? `?account_name=${encodeURIComponent(normalized)}&accountName=${encodeURIComponent(normalized)}` : "";
    try {
      return await fetchJsonForCache(`/api/mobile/pick-orders${query}`);
    } catch (error) {
      if (Number(error.status) !== 404) throw error;
      const fallbackQuery = normalized ? `?accountName=${encodeURIComponent(normalized)}&account_name=${encodeURIComponent(normalized)}` : "";
      return fetchJsonForCache(`/api/admin/portal-orders${fallbackQuery}`);
    }
  }

  async function preloadWarehouseData({ force = false, reason = "startup" } = {}) {
    if (preloadPromise && !force) return preloadPromise;
    preloadPromise = (async () => {
      if (!isOnline()) return { ok: false, offline: true };
      const startedAt = new Date().toISOString();
      const summary = {
        ok: true,
        reason,
        startedAt,
        completedAt: "",
        company: getCompanyContext(),
        companies: [],
        stateCached: false,
        pickOrdersCached: 0,
        errors: []
      };
      try {
        const activeCompany = normalizeCompany(getCompanyContext());
        if (isAndroidApp()) {
          const companiesToWarm = activeCompany ? [activeCompany] : [""];
          for (const company of companiesToWarm) {
            try {
              const ordersPayload = await fetchPickOrdersForCache(company);
              await cacheData(pickOrdersCacheKey(company), {
                ...(ordersPayload || {}),
                accountName: company,
                cachedAt: new Date().toISOString()
              });
              summary.pickOrdersCached += Array.isArray(ordersPayload?.orders) ? ordersPayload.orders.length : 0;
            } catch (error) {
              summary.errors.push({ scope: `pick-orders:${company || "all"}`, message: error.message || "Unable to warm pick orders" });
            }
          }
          summary.company = activeCompany;
          summary.companies = activeCompany ? [activeCompany] : [];
          summary.completedAt = new Date().toISOString();
          await cacheData(MOBILE_PRELOAD_CACHE_KEY, summary).catch(() => {});
          window.dispatchEvent(new CustomEvent("wms365:preload", { detail: summary }));
          return summary;
        }
        const statePayload = await fetchJsonForCache("/api/state");
        const compactState = compactStatePayload(statePayload);
        await yieldToBrowser();
        await cacheData(WAREHOUSE_STATE_CACHE_KEY, compactState);
        summary.stateCached = true;
        summary.companies = deriveCompanies(compactState);
        summary.companySlicesCached = 0;
        summary.companySlices = [];
        const companiesToSlice = activeCompany
          ? [activeCompany]
          : summary.companies.slice(0, isAndroidApp() ? 1 : 3);
        try {
          summary.companySlices = await cacheCompanyFastSlices(compactState, companiesToSlice, summary.companies);
          summary.companySlicesCached = summary.companySlices.length;
        } catch (error) {
          summary.errors.push({ scope: "company-fast-cache", message: error.message || "Unable to warm company fast cache" });
        }

        const companiesToWarm = activeCompany
          ? [activeCompany]
          : summary.companies.slice(0, 3);
        for (const company of companiesToWarm) {
          try {
            const ordersPayload = await fetchPickOrdersForCache(company);
            await cacheData(pickOrdersCacheKey(company), {
              ...(ordersPayload || {}),
              accountName: company,
              cachedAt: new Date().toISOString()
            });
            summary.pickOrdersCached += Array.isArray(ordersPayload?.orders) ? ordersPayload.orders.length : 0;
          } catch (error) {
            summary.errors.push({ scope: `pick-orders:${company || "all"}`, message: error.message || "Unable to warm pick orders" });
          }
        }
      } catch (error) {
        summary.ok = false;
        summary.errors.push({ scope: "state", message: error.message || "Unable to warm warehouse data" });
      }
      summary.completedAt = new Date().toISOString();
      try {
        await cacheData(MOBILE_PRELOAD_CACHE_KEY, summary);
      } catch {}
      window.dispatchEvent(new CustomEvent("wms365:preload", { detail: summary }));
      return summary;
    })().finally(() => {
      preloadPromise = null;
    });
    return preloadPromise;
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
    getDeviceManufacturer,
    getDeviceBrand,
    getDeviceProfile,
    getDeviceProfileId,
    loadDeviceProfile,
    hasHardwareScanner,
    getScannerProfile,
    getDeviceModel,
    getAuditContext,
    makeIdempotencyKey,
    envelope,
    vibrate,
    beep,
    setKeepAwake,
    isOnline,
    clearWebData,
    prepareScanTarget,
    scanBarcode,
    applyDeviceProfileToPage,
    queueTransaction,
    queueOrSendTransaction,
    getQueuedTransactions,
    getQueueSummary,
    retryFailedTransactions,
    cacheData,
    getCachedData,
    getCompanyFastData,
    preloadWarehouseData,
    pickOrdersCacheKey,
    companyFastCacheKey,
    syncQueue,
    registerServiceWorker
  };

  window.addEventListener("online", () => syncQueue().catch(() => {}));
  window.addEventListener("wms365:company-context", () => preloadWarehouseData({ force: true, reason: "company-context" }).catch(() => {}));
  window.addEventListener("wms365:device-profile", () => applyDeviceProfileToPage());
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      applyDeviceProfileToPage();
      loadDeviceProfile().catch(() => {});
    }, { once: true });
  } else {
    applyDeviceProfileToPage();
    loadDeviceProfile().catch(() => {});
  }
  registerServiceWorker();
  setTimeout(() => preloadWarehouseData({ reason: "startup" }).catch(() => {}), 600);
})();
