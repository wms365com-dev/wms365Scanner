const marketingUi = {
    buildLabels: [...document.querySelectorAll("[data-build-label]")],
    yearLabels: [...document.querySelectorAll("[data-site-year]")],
    forms: [...document.querySelectorAll("[data-demo-form]")],
    stripeButtons: [...document.querySelectorAll("[data-stripe-plan]")],
    stripeStatus: [...document.querySelectorAll("[data-stripe-status]")]
};
const marketingConfig = loadMarketingConfig();

const stripePlanState = new Map();

marketingUi.yearLabels.forEach((node) => {
    node.textContent = String(new Date().getFullYear());
});

refreshMarketingBuildLabel().catch(() => {
    marketingUi.buildLabels.forEach((node) => {
        node.textContent = "Deployment: build unavailable";
    });
});

marketingUi.forms.forEach((form) => {
    form.addEventListener("submit", (event) => onDemoRequestSubmit(event, form));
});

marketingUi.stripeButtons.forEach((button) => {
    button.addEventListener("click", (event) => onStripeCheckoutClick(event, button));
});

if (marketingUi.stripeButtons.length) {
    loadStripeCheckoutConfig().catch(() => {
        marketingUi.stripeButtons.forEach((button) => applyStripeButtonState(button, { enabled: false }));
    });
    applyStripeReturnMessage().catch(() => {});
}

function setFormMessage(form, text, tone = "info") {
    const messageEl = form.querySelector("[data-demo-message]");
    if (!messageEl) return;
    messageEl.className = `status ${tone}`;
    messageEl.textContent = text;
}

function setFormBusy(form, busy) {
    const submitBtn = form.querySelector("[data-demo-submit]");
    if (!submitBtn) return;
    submitBtn.disabled = busy;
    submitBtn.textContent = busy ? "Sending..." : (submitBtn.dataset.idleLabel || "Request Demo");
}

function getStripeStatusElement(planKey) {
    return marketingUi.stripeStatus.find((node) => node.dataset.stripeStatus === planKey) || null;
}

function setStripeStatus(planKey, text, tone = "info") {
    const statusEl = getStripeStatusElement(planKey);
    if (!statusEl) return;
    statusEl.className = `status ${tone}`;
    statusEl.textContent = text;
}

function applyStripeButtonState(button, config) {
    const enabled = config?.enabled === true;
    const enabledLabel = button.dataset.stripeLabelEnabled || "Start via Stripe";
    const disabledLabel = button.dataset.stripeLabelDisabled || "Book Demo";
    button.dataset.stripeEnabled = enabled ? "true" : "false";
    button.textContent = enabled ? enabledLabel : disabledLabel;
    if (!enabled) {
        setStripeStatus(button.dataset.stripePlan || "", "Stripe checkout for this plan is not configured yet. Use Book Demo for guided pricing.", "info");
    } else {
        setStripeStatus(button.dataset.stripePlan || "", "Secure hosted Stripe checkout is available for this plan.", "info");
    }
}

function stripStripeSessionIdFromUrl() {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("session_id")) return;
    url.searchParams.delete("session_id");
    window.history.replaceState({}, document.title, url.toString());
}

async function requestMarketingJson(url, options = {}) {
    const response = await fetch(url, {
        headers: {
            "Content-Type": "application/json",
            ...(options.headers || {})
        },
        ...options
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    if (!response.ok) {
        throw new Error(data.error || "Request failed.");
    }
    return data;
}

function readMarketingMeta(name) {
    const node = document.querySelector(`meta[name="${name}"]`);
    return String(node?.getAttribute("content") || "").trim();
}

function normalizeBaseUrl(value) {
    return String(value || "").trim().replace(/\/+$/, "");
}

function getDefaultAppBaseUrl() {
    const host = String(window.location.hostname || "").trim().toLowerCase();
    if (!host || host === "localhost" || host === "127.0.0.1") {
        return window.location.origin;
    }
    return "https://app.wms365.co";
}

function loadMarketingConfig() {
    const appBaseUrl = normalizeBaseUrl(readMarketingMeta("wms365-app-url")) || getDefaultAppBaseUrl();
    const apiBaseUrl = normalizeBaseUrl(readMarketingMeta("wms365-api-url")) || appBaseUrl;
    return {
        appBaseUrl,
        apiBaseUrl
    };
}

function resolveMarketingApiUrl(path) {
    const normalizedPath = String(path || "").startsWith("/") ? String(path || "") : `/${String(path || "")}`;
    return `${marketingConfig.apiBaseUrl}${normalizedPath}`;
}

async function refreshMarketingBuildLabel() {
    const payload = await requestMarketingJson(resolveMarketingApiUrl("/api/version"));
    const label = String(payload?.build?.label || "").trim() || "build unavailable";
    marketingUi.buildLabels.forEach((node) => {
        node.textContent = `Deployment: ${label}`;
    });
}

async function loadStripeCheckoutConfig() {
    const payload = await requestMarketingJson(resolveMarketingApiUrl("/api/site/stripe-config"));
    const plans = Array.isArray(payload?.plans) ? payload.plans : [];
    stripePlanState.clear();
    plans.forEach((plan) => {
        stripePlanState.set(String(plan.key || ""), plan);
    });
    marketingUi.stripeButtons.forEach((button) => {
        applyStripeButtonState(button, stripePlanState.get(button.dataset.stripePlan || "") || { enabled: false });
    });
}

async function onDemoRequestSubmit(event, form) {
    event.preventDefault();
    const formData = new FormData(form);
    const payload = {
        fullName: formData.get("fullName"),
        workEmail: formData.get("workEmail"),
        companyName: formData.get("companyName"),
        phone: formData.get("phone"),
        roleTitle: formData.get("roleTitle"),
        operationsType: formData.get("operationsType"),
        warehouseCount: formData.get("warehouseCount"),
        monthlyOrderVolume: formData.get("monthlyOrderVolume"),
        interestAreas: formData.getAll("interestAreas"),
        message: formData.get("message"),
        companyWebsite: formData.get("companyWebsite"),
        sourcePage: window.location.href,
        browserLocale: navigator.language || ""
    };

    setFormBusy(form, true);
    setFormMessage(form, "Submitting your request...", "info");
    try {
        await requestMarketingJson(resolveMarketingApiUrl("/api/site/demo-request"), {
            method: "POST",
            body: JSON.stringify(payload)
        });
        form.reset();
        setFormMessage(
            form,
            form.dataset.successMessage || "Thanks. Your demo request was sent and we'll follow up soon.",
            "success"
        );
    } catch (error) {
        setFormMessage(form, error.message || "We could not submit your request right now.", "error");
    } finally {
        setFormBusy(form, false);
    }
}

function planKeyFromSlug(value) {
    const normalized = String(value || "").trim().toLowerCase();
    if (normalized === "launch-warehouse") return "LAUNCH_WAREHOUSE";
    if (normalized === "customer-facing-operation") return "CUSTOMER_FACING_OPERATION";
    return "";
}

async function applyStripeReturnMessage() {
    const params = new URLSearchParams(window.location.search);
    const checkoutState = String(params.get("checkout") || "").trim().toLowerCase();
    const planKey = planKeyFromSlug(params.get("plan"));
    const sessionId = String(params.get("session_id") || "").trim();
    if (!checkoutState || !planKey) return;
    if (checkoutState === "success") {
        try {
            if (!sessionId) {
                throw new Error("Checkout session id missing from success redirect.");
            }
            const payload = await requestMarketingJson(`${resolveMarketingApiUrl("/api/site/stripe-checkout-session")}?sessionId=${encodeURIComponent(sessionId)}`);
            const checkoutSession = payload?.checkoutSession || {};
            const companyName = checkoutSession.companyName || checkoutSession.companyAccountName || "your company";
            const planLabel = checkoutSession.planLabel || "your plan";
            const statusLabel = String(checkoutSession.status || "").replace(/_/g, " ").toLowerCase();
            const tone = checkoutSession.isProvisionable ? "success" : "info";
            setStripeStatus(
                planKey,
                `Stripe checkout completed for ${companyName}. ${planLabel} is now ${statusLabel || "processing"}, and WMS365 captured the onboarding record.`,
                tone
            );
        } catch (_error) {
            setStripeStatus(planKey, "Stripe checkout completed. We captured your subscription details and will continue onboarding from the billing record.", "success");
        } finally {
            stripStripeSessionIdFromUrl();
        }
    } else if (checkoutState === "cancelled") {
        setStripeStatus(planKey, "Stripe checkout was cancelled. You can try again or book a guided demo instead.", "info");
    }
}

function collectStripeCheckoutPayload(button) {
    const form = button.closest("[data-stripe-signup-form]") || button.closest(".price-card")?.querySelector("[data-stripe-signup-form]");
    if (!form) {
        return {
            planKey: button.dataset.stripePlan || "",
            sourcePage: window.location.href
        };
    }
    const formData = new FormData(form);
    return {
        planKey: button.dataset.stripePlan || "",
        fullName: String(formData.get("fullName") || "").trim(),
        workEmail: String(formData.get("workEmail") || "").trim(),
        companyName: String(formData.get("companyName") || "").trim(),
        sourcePage: window.location.href
    };
}

function validateStripeCheckoutPayload(button, payload) {
    if (button.dataset.stripeRequiresLead !== "true") {
        return true;
    }
    const missingFieldName = !payload.fullName
        ? "fullName"
        : !payload.workEmail
            ? "workEmail"
            : !payload.companyName
                ? "companyName"
                : "";
    if (!missingFieldName) {
        return true;
    }

    const signupForm = button.closest("[data-stripe-signup-form]") || button.closest(".price-card")?.querySelector("[data-stripe-signup-form]");
    const missingField = signupForm?.querySelector(`[name="${missingFieldName}"]`) || null;
    if (missingField && typeof missingField.focus === "function") {
        missingField.focus();
    }
    const missingLabels = {
        fullName: "full name",
        workEmail: "work email",
        companyName: "company name"
    };
    setStripeStatus(payload.planKey, `Please enter your ${missingLabels[missingFieldName] || "details"} before starting Stripe checkout.`, "error");
    return false;
}

async function onStripeCheckoutClick(event, button) {
    const planKey = button.dataset.stripePlan || "";
    if (button.dataset.stripeEnabled !== "true") {
        return;
    }

    const payload = collectStripeCheckoutPayload(button);
    if (!validateStripeCheckoutPayload(button, payload)) {
        event.preventDefault();
        return;
    }

    event.preventDefault();
    const idleLabel = button.dataset.stripeLabelEnabled || "Start via Stripe";
    button.textContent = "Redirecting...";
    button.setAttribute("aria-busy", "true");
    setStripeStatus(planKey, "Creating your Stripe checkout session...", "info");
    try {
        const responsePayload = await requestMarketingJson(resolveMarketingApiUrl("/api/site/stripe-checkout"), {
            method: "POST",
            body: JSON.stringify(payload)
        });
        if (!responsePayload?.checkoutUrl) {
            throw new Error("Stripe checkout URL was not returned.");
        }
        window.location.assign(responsePayload.checkoutUrl);
    } catch (error) {
        button.textContent = idleLabel;
        button.removeAttribute("aria-busy");
        setStripeStatus(planKey, error.message || "We could not start Stripe checkout right now.", "error");
    }
}

