package com.wms365.app

import java.net.URI
import java.util.Locale

internal class AppUrlPolicy(baseUrl: String, private val appMode: String = "warehouse") {
    private val origin = URI(baseUrl)

    init {
        require(origin.scheme == "https" && !origin.host.isNullOrBlank() && origin.rawUserInfo == null)
        require(origin.port == -1 || origin.port == 443)
        require(origin.rawPath.isNullOrEmpty() || origin.rawPath == "/")
        require(origin.rawQuery == null && origin.rawFragment == null)
    }

    fun allows(value: String): Boolean = runCatching {
        val uri = URI(value)
        val trustedOrigin = uri.scheme?.lowercase(Locale.ROOT) == "https" &&
            uri.host?.lowercase(Locale.ROOT) == origin.host.lowercase(Locale.ROOT) &&
            (uri.port == -1 || uri.port == 443) && uri.rawUserInfo == null &&
            !value.contains('\\')
        trustedOrigin && (appMode != "customer_portal" || isCustomerPortalPath(uri.rawPath))
    }.getOrDefault(false)

    fun allowsDeepLink(value: String): Boolean {
        if (!allows(value)) return false
        return runCatching {
            val path = URI(value).rawPath
            if (appMode == "customer_portal") isCustomerPortalPath(path)
            else path in setOf("/mobile", "/mobile/", "/mobile/warehouse", "/mobile-count", "/mobile-count.html", "/mobile-pick", "/mobile-pick.html")
        }.getOrDefault(false)
    }

    private fun isCustomerPortalPath(path: String?): Boolean {
        return path == "/portal" || path == "/portal/" || path == "/portal.html" ||
            path?.startsWith("/api/portal/") == true
    }
}
