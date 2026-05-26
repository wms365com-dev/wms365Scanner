package com.wms365.nativeapp.network

import android.os.Build
import com.wms365.nativeapp.BuildConfig
import com.wms365.nativeapp.data.AppSession
import com.wms365.nativeapp.data.OutboxItem
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets

class WmsApiClient(private val baseUrl: String = BuildConfig.WMS365_BASE_URL.trimEnd('/')) {
    fun login(email: String, password: String, deviceId: String): AppSession {
        val result = request(
            path = "/api/app/login",
            method = "POST",
            body = JSONObject()
                .put("email", email)
                .put("password", password)
                .apply {
                    mergeDevicePayload(this, deviceId, "")
                },
            cookieHeader = ""
        )
        val cookie = result.cookieHeader.ifBlank { throw ApiException(401, "Login succeeded but no session cookie was returned.") }
        return AppSession(email = email, cookieHeader = cookie, company = "", warehouseId = "", deviceId = deviceId)
    }

    fun checkIn(session: AppSession) {
        request(
            path = "/api/app/device-checkin",
            method = "POST",
            body = JSONObject().apply {
                mergeDevicePayload(this, session.deviceId, session.company)
            },
            cookieHeader = session.cookieHeader
        )
    }

    fun fetchPickOrders(session: AppSession): JSONArray {
        val query = if (session.company.isNotBlank()) "?accountName=${urlEncode(session.company)}" else ""
        val result = request("/api/mobile/pick-orders$query", "GET", null, session.cookieHeader)
        return result.json.optJSONArray("orders") ?: JSONArray()
    }

    fun fetchState(session: AppSession): JSONObject {
        return request("/api/state", "GET", null, session.cookieHeader).json
    }

    fun fetchCompanies(session: AppSession): List<String> {
        val result = request("/api/app/companies", "GET", null, session.cookieHeader)
        val companies = result.json.optJSONArray("companies") ?: JSONArray()
        val rows = mutableListOf<String>()
        for (i in 0 until companies.length()) {
            val company = companies.optString(i).trim()
            if (company.isNotBlank()) rows += company
        }
        return rows.distinct().sorted()
    }

    fun submitOutbox(session: AppSession, item: OutboxItem) {
        request(item.type.apiPath, "POST", JSONObject(item.payload), session.cookieHeader)
    }

    fun request(path: String, method: String, body: JSONObject?, cookieHeader: String): ApiResult {
        val connection = (URL("$baseUrl$path").openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 15_000
            readTimeout = 90_000
            setRequestProperty("Accept", "application/json")
            setRequestProperty("Content-Type", "application/json")
            setRequestProperty("X-WMS365-Mobile-Source", "android_app")
            if (cookieHeader.isNotBlank()) setRequestProperty("Cookie", cookieHeader)
            if (body != null) {
                doOutput = true
                outputStream.use { it.write(body.toString().toByteArray(StandardCharsets.UTF_8)) }
            }
        }

        val status = connection.responseCode
        val stream = if (status in 200..299) connection.inputStream else connection.errorStream
        val text = stream?.use { input ->
            BufferedReader(InputStreamReader(input, StandardCharsets.UTF_8)).readText()
        }.orEmpty()
        val setCookie = connection.headerFields["Set-Cookie"].orEmpty()
            .mapNotNull { it.substringBefore(";").takeIf(String::isNotBlank) }
            .joinToString("; ")
        val json = if (text.isBlank()) JSONObject() else runCatching { JSONObject(text) }.getOrElse { JSONObject().put("raw", text) }

        if (status !in 200..299) {
            throw ApiException(status, json.optString("error").ifBlank { json.optString("message").ifBlank { "WMS365 request failed: HTTP $status" } })
        }
        return ApiResult(status, json, setCookie)
    }

    private fun urlEncode(value: String): String = java.net.URLEncoder.encode(value, "UTF-8")

    private fun mergeDevicePayload(body: JSONObject, deviceId: String, company: String) {
        body
            .put("source", "android_app")
            .put("appSource", "android_app")
            .put("appName", "WMS365 Scanner")
            .put("packageName", BuildConfig.APPLICATION_ID)
            .put("platform", "android")
            .put("deviceId", deviceId)
            .put("manufacturer", Build.MANUFACTURER.orEmpty())
            .put("model", Build.MODEL.orEmpty())
            .put("osVersion", Build.VERSION.RELEASE.orEmpty())
            .put("sdkVersion", Build.VERSION.SDK_INT.toString())
            .put("appVersion", BuildConfig.VERSION_NAME)
            .put("appVersionCode", BuildConfig.VERSION_CODE.toString())
            .put("scannerType", "Native Android scanner / camera fallback")
            .put("accountName", company)
    }
}

data class ApiResult(val status: Int, val json: JSONObject, val cookieHeader: String)

class ApiException(val statusCode: Int, message: String) : Exception(message)
