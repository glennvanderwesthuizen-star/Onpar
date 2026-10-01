package za.onpar.core

import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import org.junit.jupiter.api.io.TempDir
import java.io.File

/** Panic and BOLO on the phone (decisions D-27, D-28). */
class AlertsTest {
    @TempDir lateinit var dir: File
    private lateinit var server: MockWebServer
    private lateinit var device: OnParDevice

    @BeforeEach fun start() {
        server = MockWebServer()
        server.start()
        device = OnParDevice(dir)
        server.enqueue(MockResponse().setBody("{}"))
        device.applySetup(DeviceSetup(server.url("/").toString().trimEnd('/'), "device-token-123456789012345"))
        server.takeRequest()
    }

    @AfterEach fun stop() = runCatching { server.shutdown() }.let { }

    @Test
    fun `a panic with nobody signed in is sent at once with the location taken at that moment`() {
        server.enqueue(MockResponse().setBody("""{"id":"x"}"""))
        val r = device.alerts.panic(Fix(-26.1076, 28.0567, 9.0), callStarted = true)
        assertTrue(r is Submitted.Sent)
        val req = server.takeRequest()
        assertEquals("/api/device/panic", req.path)
        assertNull(req.getHeader("Authorization"))
        val body = OnParJson.parseToJsonElement(req.body.readUtf8()).jsonObject
        assertEquals(-26.1076, body["lat"]!!.jsonPrimitive.content.toDouble())
        assertEquals("true", body["callStarted"]!!.jsonPrimitive.content)
        assertEquals("false", body["mock"]!!.jsonPrimitive.content)
    }

    @Test
    fun `a panic without a location is still sent`() {
        server.enqueue(MockResponse().setBody("{}"))
        assertTrue(device.alerts.panic(null, callStarted = false) is Submitted.Sent)
        val body = OnParJson.parseToJsonElement(server.takeRequest().body.readUtf8()).jsonObject
        assertFalse(body.containsKey("lat"))
    }

    @Test
    fun `a panic goes ahead of anything already waiting`() {
        device.outbox.add("waiting-1", "Patrol scan", "/device/patrols/scan", buildJsonObject { }, "guard-token")
        server.enqueue(MockResponse().setBody("{}"))
        assertTrue(device.alerts.panic(null, callStarted = true) is Submitted.Sent)
        assertEquals("/api/device/panic", server.takeRequest().path)
        assertEquals(1, device.outbox.pending().size)
    }

    @Test
    fun `with no signal a panic waits in the outbox and is sent when signal returns`() {
        val url = server.url("/")
        server.shutdown()
        assertEquals(Submitted.Queued, device.alerts.panic(Fix(-26.0, 28.0, 30.0), callStarted = true))
        val waiting = device.outbox.pending().single()
        assertEquals("PANIC", waiting.label)
        server = MockWebServer()
        server.start(url.port)
        server.enqueue(MockResponse().setBody("{}"))
        val sent = device.sync()
        assertTrue(sent[waiting.eventId] is Submitted.Sent)
        assertEquals("/api/device/panic", server.takeRequest().path)
    }

    @Test
    fun `a panic saved with no signal goes to the front of the outbox`() {
        device.outbox.add("waiting-1", "Patrol scan", "/device/patrols/scan", buildJsonObject { }, "guard-token")
        server.shutdown()
        assertEquals(Submitted.Queued, device.alerts.panic(null, callStarted = true))
        device.outbox.add("waiting-2", "Task", "/device/tasks/x/complete", buildJsonObject { }, "guard-token")
        assertEquals(listOf("PANIC", "Patrol scan", "Task"), device.outbox.pending().map { it.label })
    }

    @Test
    fun `server trouble keeps the panic for later, a refusal does not`() {
        server.enqueue(MockResponse().setResponseCode(503))
        assertEquals(Submitted.Queued, device.alerts.panic(null, callStarted = true))
        assertEquals(1, device.outbox.pending().size)
        server.enqueue(MockResponse().setResponseCode(401).setBody("""{"message":"Unknown device"}"""))
        assertTrue(device.alerts.panic(null, callStarted = true) is Submitted.Refused)
        assertEquals(1, device.outbox.pending().size)
    }

    @Test
    fun `a BOLO sends the note and photo, and needs a note`() {
        assertThrows<IllegalArgumentException> { device.alerts.bolo(" a ", null) }
        val photo = File(dir, "car.jpg").apply { writeBytes(byteArrayOf(-1, -40, -1, -32)) }
        server.enqueue(MockResponse().setBody("{}"))
        assertTrue(device.alerts.bolo("White Hilux circling", photo) is Submitted.Sent)
        val req = server.takeRequest()
        assertEquals("/api/device/bolo", req.path)
        val text = req.body.readUtf8()
        assertTrue(text.contains("White Hilux circling"))
        assertTrue(text.contains("name=\"photo\""))
    }

    @Test
    fun `a BOLO without a photo is plain`() {
        server.enqueue(MockResponse().setBody("{}"))
        assertTrue(device.alerts.bolo("Man in red jacket", null) is Submitted.Sent)
        assertTrue(server.takeRequest().getHeader("Content-Type")!!.startsWith("application/json"))
    }
}
