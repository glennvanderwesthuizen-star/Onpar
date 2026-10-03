package za.onpar.core

import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.MethodOrderer
import org.junit.jupiter.api.Order
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestInstance
import org.junit.jupiter.api.TestMethodOrder
import java.io.File

/**
 * The phone's logic against a real, running On Par server (the same code the app
 * runs). Skipped unless ONPAR_API_URL is set, for example:
 *   ONPAR_API_URL=http://localhost:4000 ./gradlew :core:test
 * It signs in as the demo administrator, registers a device and enrols a test officer.
 */
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
@TestMethodOrder(MethodOrderer.OrderAnnotation::class)
class LiveServerTest {
    private val url = LiveFixture.url
    private val dir: File = java.nio.file.Files.createTempDirectory("onpar-live").toFile()
    private lateinit var device: OnParDevice
    private lateinit var setup: DeviceSetup
    private lateinit var employeeNumber: String
    private lateinit var pin: String

    @Test @Order(1)
    fun `a supervisor registers the phone and enrols an officer (test preparation)`() {
        assumeTrue(url.isNotEmpty(), "ONPAR_API_URL not set")
        val f = LiveFixture(url)
        setup = f.setup
        employeeNumber = f.employeeNumber
        pin = f.pin
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
        assertEquals(4, s.pendingDeclaration?.wording?.statements?.size)
    }

    @Test @Order(5)
    fun `the phone shows the server's exact declaration wording, and the declaration with selfie is accepted`() {
        assumeTrue(url.isNotEmpty())
        val owed = device.owedDeclaration(device.state())!!
        assertEquals(DeclarationText.DUTY_ON, owed.wording)
        assertEquals(DeclarationText.DUTY_FROM, DeclarationText.forKind("duty_from"))
        val jpeg = File(dir, "selfie.jpg").apply { writeBytes(byteArrayOf(-1, -40, -1, -32, 0, 16, 74, 70, 73, 70, 0, 1)) }
        val r = device.declare(owed, listOf(true, true, true, true), "Torch at Gate 2 does not work", true, "amber", jpeg)
        assertTrue(r is Submitted.Sent, "$r")
        assertTrue(device.outbox.pending().isEmpty(), "selfie sent too")
        assertEquals(null, device.owedDeclaration(device.state()))
    }

    @Test @Order(6)
    fun `Duty From is refused until the relief arrives, and the refusal is not queued to retry (D-33)`() {
        assumeTrue(url.isNotEmpty())
        val (_, r) = device.duty(DutyKind.FROM, pin)
        assertTrue(r is Submitted.Refused && r.message.contains("relief"), "$r")
        assertTrue(device.outbox.pending().isEmpty())
        assertTrue(device.state().attendance!!.relief!!.canLeave.not())
    }

    @Test @Order(7)
    fun `the same action sent twice (a retry after lost signal) is recorded once`() {
        assumeTrue(url.isNotEmpty())
        val eventId = java.util.UUID.randomUUID().toString()
        device.outbox.add(eventId, "BOLO", "/device/bolo", boloBody(eventId), device.guardToken)
        val first = device.sync()[eventId]
        assertTrue(first is Submitted.Sent, "$first")
        // The phone lost the reply and sends the same event again.
        device.outbox.add(eventId, "BOLO (retry)", "/device/bolo", boloBody(eventId), device.guardToken)
        val again = device.sync()[eventId]
        assertTrue(again is Submitted.Sent, "$again")
        assertTrue(device.outbox.failed().none { it.eventId == eventId })
        val f = LiveFixture(url)
        val list = f.call("GET", "/bolos", f.managerToken)["list"]!!.jsonArray
        assertEquals(1, list.count { it.jsonObject["id"]!!.jsonPrimitive.content == eventId })
    }

    private fun boloBody(eventId: String) = buildJsonObject {
        put("eventId", eventId)
        put("note", "Grey Polo parked at the gate")
        put("trustedAt", device.clock.now().toString())
        put("deviceClock", device.clock.deviceClock().toString())
    }

    @Test @Order(8)
    fun `signing out keeps nothing of the guard on the phone`() {
        assumeTrue(url.isNotEmpty())
        device.signOut()
        assertEquals(null, OnParDevice(dir).guardToken)
        assertTrue(runCatching { device.state() }.exceptionOrNull() is ApiException)
    }
}
