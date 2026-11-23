package com.wms365.app

import org.junit.Assert.*
import org.junit.Test

class AppUrlPolicyTest {
    private val policy = AppUrlPolicy("https://app.wms365.co")

    @Test fun exactOriginOnly() {
        listOf("https://app.wms365.co/mobile/warehouse", "https://APP.WMS365.CO:443/login", "https://app.wms365.co/api/state").forEach { assertTrue(it, policy.allows(it)) }
        listOf("http://app.wms365.co/mobile", "https://wms365.co/mobile", "https://app.wms365.co.evil.test/mobile", "https://evil.test/?next=https://app.wms365.co", "https://user@app.wms365.co/mobile", "https://app.wms365.co:444/mobile", "javascript:alert(1)", "file:///mobile", "data:text/html,test", "https://app.wms365.co\\@evil.test", "bad url").forEach { assertFalse(it, policy.allows(it)) }
    }

    @Test fun deepLinksAreMobileRoutesOnly() {
        listOf("/mobile", "/mobile/", "/mobile/warehouse", "/mobile-pick", "/mobile-count.html").forEach { assertTrue(policy.allowsDeepLink("https://app.wms365.co$it?orderId=42")) }
        listOf("/desktop", "/portal.html", "/mobile-other", "/mobile/../desktop", "/%6dobile", "/api/state").forEach { assertFalse(policy.allowsDeepLink("https://app.wms365.co$it")) }
        assertFalse(policy.allowsDeepLink("https://evil.test/mobile"))
    }

    @Test fun configuredOriginDoesNotAlsoTrustProduction() {
        val staging = AppUrlPolicy("https://staging.example.test")
        assertTrue(staging.allows("https://staging.example.test/mobile"))
        assertFalse(staging.allows("https://app.wms365.co/mobile"))
    }

    @Test fun customerPortalModeIsPortalOnly() {
        val portal = AppUrlPolicy("https://app.wms365.co", "customer_portal")
        listOf("/portal", "/portal/", "/portal.html", "/api/portal/orders").forEach {
            assertTrue(it, portal.allows("https://app.wms365.co$it"))
            assertTrue(it, portal.allowsDeepLink("https://app.wms365.co$it"))
        }
        listOf("/mobile", "/warehouse-actions", "/login.html", "/api/orders", "/portal-other").forEach {
            assertFalse(it, portal.allows("https://app.wms365.co$it"))
            assertFalse(it, portal.allowsDeepLink("https://app.wms365.co$it"))
        }
    }

    @Test fun invalidBuildOriginsFailClosed() {
        listOf("http://app.wms365.co", "https://app.wms365.co:444", "https://user@app.wms365.co", "https://app.wms365.co/path", "https://app.wms365.co?key=secret").forEach {
            try { AppUrlPolicy(it); fail(it) } catch (_: IllegalArgumentException) { }
        }
    }
}
