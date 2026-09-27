package za.onpar.core

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.Base64
import kotlin.random.Random

/**
 * Prepares a running On Par server for a phone test, as a supervisor would on the
 * website: registers a device and enrols an officer. Only used when ONPAR_API_URL is set.
 */
class LiveFixture(val url: String) {
    private val http = OkHttpClient()
    private val json = "application/json".toMediaType()
    val adminToken = signIn(System.getenv("ONPAR_ADMIN_EMAIL") ?: "admin@demo.onpar.local")
    val managerToken = signIn(System.getenv("ONPAR_MANAGER_EMAIL") ?: "manager@demo.onpar.local")
    val siteId: String
    val deviceId: String
    val setup: DeviceSetup
    val employeeNumber: String
    val pin: String

    init {
        val site = call("GET", "/sites", adminToken)["list"]!!.jsonArray.first().jsonObject
        siteId = site["id"]!!.jsonPrimitive.content
        val reg = call(
            "POST", "/devices", adminToken,
            buildJsonObject { put("label", "Phone test ${Random.nextInt(1000, 9999)}"); put("serialOrImei", "TEST${System.nanoTime()}"); put("siteId", siteId); put("postName", "Gate 1") },
        )
        deviceId = reg["device"]!!.jsonObject["id"]!!.jsonPrimitive.content
        setup = DeviceSetup(url, reg["deviceToken"]!!.jsonPrimitive.content)
        val enrolled = enrol()
        employeeNumber = enrolled.first
        pin = enrolled.second
    }

    private fun signIn(email: String): String =
        call("POST", "/auth/login", null, buildJsonObject { put("email", email); put("password", System.getenv("ONPAR_ADMIN_PASSWORD") ?: "OnPar-demo-2026") })["token"]!!.jsonPrimitive.content

    /** A management call, as on the website. Lists come back under "list". */
    fun call(method: String, path: String, token: String?, body: JsonElement? = null): JsonObject {
        val req = Request.Builder().url("$url/api$path")
        if (token != null) req.header("Authorization", "Bearer $token")
        req.method(method, body?.toString()?.toRequestBody(json))
        return send(req)
    }

    private fun send(req: Request.Builder): JsonObject = http.newCall(req.build()).execute().use {
        val text = it.body!!.string()
        check(it.isSuccessful) { "${it.code}: $text" }
        OnParJson.parseToJsonElement(text).let { e -> if (e is JsonObject) e else buildJsonObject { put("list", e) } }
    }

    private fun enrol(): Pair<String, String> {
        val png = Base64.getDecoder().decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")
        val data = buildJsonObject {
            put("fullName", "Phone Test Officer")
            put("idNumber", saId())
            put("cellNumber", "082 555 0199")
            put("nextOfKinName", "Next Of Kin")
            put("nextOfKinNumber", "082 555 0198")
            put("psiraNumber", "PS${Random.nextInt(1000000, 9999999)}")
            put("psiraGrade", "C")
            put("psiraExpiry", "2029-12-31")
            put("siteId", siteId)
            put("qualifications", buildJsonArray { })
            put("issuedItems", buildJsonArray { })
            put("acknowledgeWarnings", true)
        }
        val form = MultipartBody.Builder().setType(MultipartBody.FORM).addFormDataPart("data", data.toString())
        for (k in listOf("face", "full_body", "id_document", "psira_card")) form.addFormDataPart("photo_$k", "$k.png", png.toRequestBody("image/png".toMediaType()))
        val r = send(Request.Builder().url("$url/api/officers").header("Authorization", "Bearer $adminToken").post(form.build()))
        return r["officer"]!!.jsonObject["employeeNumber"]!!.jsonPrimitive.content to r["initialPin"]!!.jsonPrimitive.content
    }

    /** A valid South African ID number (check digit included). */
    private fun saId(): String {
        val base = "900101" + (5000 + Random.nextInt(4999)).toString() + "08"
        var sum = 0
        base.reversed().forEachIndexed { i, c ->
            var d = c.digitToInt()
            if (i % 2 == 0) { d *= 2; if (d > 9) d -= 9 }
            sum += d
        }
        return base + ((10 - sum % 10) % 10)
    }

    companion object {
        val url: String = System.getenv("ONPAR_API_URL").orEmpty().trimEnd('/')
        val JPEG = byteArrayOf(-1, -40, -1, -32, 0, 16, 74, 70, 73, 70, 0, 1)
    }
}
