package za.onpar.core

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
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.MethodOrderer
import org.junit.jupiter.api.Order
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestInstance
import org.junit.jupiter.api.TestMethodOrder
import java.io.File
import java.util.Base64
import kotlin.random.Random

/**
 * The phone's logic against a real, running On Par server (the same code the app
 * runs). Skipped unless ONPAR_API_URL is set, for example:
 *   ONPAR_API_URL=http://localhost:4000 ./gradlew :core:test
 * It signs in as the demo administrator, registers a device and enrols a test officer.
 */
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
@TestMethodOrder(MethodOrderer.OrderAnnotation::class)
class LiveServerTest {
    private val url = System.getenv("ONPAR_API_URL").orEmpty().trimEnd('/')
    private val admin = System.getenv("ONPAR_ADMIN_EMAIL") ?: "admin@demo.onpar.local"
    private val password = System.getenv("ONPAR_ADMIN_PASSWORD") ?: "OnPar-demo-2026"
    private val http = OkHttpClient()
    private val json = "application/json".toMediaType()

    private val dir: File = java.nio.file.Files.createTempDirectory("onpar-live").toFile()
    private lateinit var device: OnParDevice
    private lateinit var setup: DeviceSetup
    private lateinit var employeeNumber: String
    private lateinit var pin: String

    private fun call(req: Request.Builder, token: String? = null): JsonObject {
        if (token != null) req.header("Authorization", "Bearer $token")
        http.newCall(req.build()).execute().use {
            val text = it.body!!.string()
            check(it.isSuccessful) { "${it.code}: $text" }
            return OnParJson.parseToJsonElement(text).let { e -> if (e is JsonObject) e else buildJsonObject { put("list", e) } }
        }
    }

    /** A valid South African ID number for a test officer (check digit included). */
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

    @Test @Order(1)
    fun `a supervisor registers the phone and enrols an officer (test preparation)`() {
        assumeTrue(url.isNotEmpty(), "ONPAR_API_URL not set")
        val token = call(Request.Builder().url("$url/api/auth/login").post(buildJsonObject { put("email", admin); put("password", password) }.toString().toRequestBody(json)))["token"]!!.jsonPrimitive.content
        val site = call(Request.Builder().url("$url/api/sites"), token)["list"]!!.jsonArray.first().jsonObject
        val siteId = site["id"]!!.jsonPrimitive.content
        val reg = call(
            Request.Builder().url("$url/api/devices").post(
                buildJsonObject { put("label", "Phone test ${Random.nextInt(1000, 9999)}"); put("serialOrImei", "TEST${System.nanoTime()}"); put("siteId", siteId); put("postName", "Gate 1") }
                    .toString().toRequestBody(json),
            ),
            token,
        )
        setup = DeviceSetup(url, reg["deviceToken"]!!.jsonPrimitive.content)
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
        val enrolled = call(Request.Builder().url("$url/api/officers").post(form.build()), token)
        employeeNumber = enrolled["officer"]!!.jsonObject["employeeNumber"]!!.jsonPrimitive.content
        pin = enrolled["initialPin"]!!.jsonPrimitive.content
    }

    @Test @Order(2)
    fun `the phone is set up from the code, checks in and gets the server time`() {
        assumeTrue(url.isNotEmpty())
        device = OnParDevice(dir)
        device.applySetup(setup)
        assertEquals(setup, OnParDevice(dir).setup) // kept after a restart
        device.heartbeat("test", 87, "unlocked")
        assertTrue(device.clock.isSynced)
    }

    @Test @Order(3)
    fun `a wrong PIN is refused and the right one signs the guard in`() {
        assumeTrue(url.isNotEmpty())
        val wrong = runCatching { device.signIn(employeeNumber, if (pin == "000000") "111111" else "000000") }.exceptionOrNull() as ApiException
        assertTrue(wrong.status in 400..499)
        val e = device.signIn(employeeNumber, pin)
        assertEquals("Phone Test Officer", e.name)
        val s = device.state()
        assertEquals(null, s.attendance)
    }

    @Test @Order(4)
    fun `Duty On reaches the server and the declaration is then owed`() {
        assumeTrue(url.isNotEmpty())
        val (_, r) = device.duty(DutyKind.ON, pin)
        assertTrue(r is Submitted.Sent, "$r")
        val s = device.state()
        assertTrue(s.attendance != null)
        assertEquals("duty_on", s.pendingDeclaration?.kind)
        assertEquals(3, s.pendingDeclaration?.wording?.statements?.size)
    }

    @Test @Order(5)
    fun `the phone shows the server's exact declaration wording, and the declaration with selfie is accepted`() {
        assumeTrue(url.isNotEmpty())
        val owed = device.owedDeclaration(device.state())!!
        assertEquals(DeclarationText.DUTY_ON, owed.wording)
        assertEquals(DeclarationText.DUTY_FROM, DeclarationText.forKind("duty_from"))
        val jpeg = File(dir, "selfie.jpg").apply { writeBytes(byteArrayOf(-1, -40, -1, -32, 0, 16, 74, 70, 73, 70, 0, 1)) }
        val r = device.declare(owed, listOf(true, true, true), "Torch at Gate 2 does not work", true, "amber", jpeg)
        assertTrue(r is Submitted.Sent, "$r")
        assertTrue(device.outbox.pending().isEmpty(), "selfie sent too")
        assertEquals(null, device.owedDeclaration(device.state()))
    }

    @Test @Order(6)
    fun `the same action sent twice (a retry after lost signal) is recorded once`() {
        assumeTrue(url.isNotEmpty())
        val before = device.state().attendance!!.id
        val (eventId, r) = device.duty(DutyKind.FROM, pin)
        assertTrue(r is Submitted.Sent, "$r")
        // The phone lost the reply and sends the same event again.
        device.outbox.add(eventId, "Duty From (retry)", "/device/duty", lastBody(eventId), device.guardToken)
        val again = device.sync()[eventId]
        assertTrue(again is Submitted.Sent, "$again")
        assertTrue(device.outbox.failed().isEmpty())
        assertEquals(before, (again as Submitted.Sent).reply.jsonObject["attendance"]!!.jsonObject["id"]!!.jsonPrimitive.content)
    }

    private fun lastBody(eventId: String) = buildJsonObject {
        put("eventId", eventId)
        put("kind", "duty_from")
        put("pin", pin)
        put("trustedAt", device.clock.now().toString())
        put("deviceClock", device.clock.deviceClock().toString())
    }

    @Test @Order(7)
    fun `signing out keeps nothing of the guard on the phone`() {
        assumeTrue(url.isNotEmpty())
        device.signOut()
        assertEquals(null, OnParDevice(dir).guardToken)
        assertTrue(runCatching { device.state() }.exceptionOrNull() is ApiException)
    }
}
