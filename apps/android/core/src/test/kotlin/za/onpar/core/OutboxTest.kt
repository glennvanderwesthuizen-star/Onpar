package za.onpar.core

import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File
import java.time.Instant

class OutboxTest {
    @TempDir lateinit var dir: File
    private lateinit var server: MockWebServer
    private val clock = TrustedClock()
    private val body = buildJsonObject { put("x", 1) }

    @BeforeEach fun start() {
        server = MockWebServer()
        server.start()
    }

    @AfterEach fun stop() = runCatching { server.shutdown() }.let { }

    private fun api() = ApiClient(DeviceSetup(server.url("/").toString().trimEnd('/'), "device-token-123456789012345"), clock)

    @Test
    fun `sends at once when online, with the device key and guard token, and syncs the time`() {
        server.enqueue(MockResponse().setBody("""{"ok":true,"serverTime":"2026-09-27T06:00:00Z"}"""))
        val outbox = Outbox(dir, clock)
        val r = outbox.submit(api(), "e1", "Duty On", "/device/duty", body, "guard-token")
        assertTrue(r is Submitted.Sent)
        val req = server.takeRequest()
        assertEquals("/api/device/duty", req.path)
        assertEquals("device-token-123456789012345", req.getHeader("X-Device-Token"))
        assertEquals("Bearer guard-token", req.getHeader("Authorization"))
        assertTrue(outbox.pending().isEmpty())
        assertTrue(clock.isSynced)
    }

    @Test
    fun `keeps actions when there is no signal, in order, and sends them later without duplicates`() {
        val outbox = Outbox(dir, clock)
        val url = server.url("/").toString().trimEnd('/')
        server.shutdown() // no signal
        val offline = ApiClient(DeviceSetup(url, "device-token-123456789012345"), clock)
        assertEquals(Submitted.Queued, outbox.submit(offline, "e1", "Duty On", "/device/duty", body, "g"))
        assertEquals(Submitted.Queued, outbox.submit(offline, "e2", "Declaration", "/device/declarations", body, "g"))
        assertEquals(listOf("e1", "e2"), outbox.pending().map { it.eventId })
        assertTrue(outbox.pending().first().attempts >= 1)

        // Signal is back: a new outbox over the same folder (as after the phone restarts) sends both, oldest first.
        val back = MockWebServer()
        back.enqueue(MockResponse().setBody("{}"))
        back.enqueue(MockResponse().setBody("{}"))
        back.start()
        val online = ApiClient(DeviceSetup(back.url("/").toString().trimEnd('/'), "device-token-123456789012345"), clock)
        val sent = Outbox(dir, clock).flush(online)
        assertEquals(setOf("e1", "e2"), sent.keys)
        assertEquals("/api/device/duty", back.takeRequest().path)
        assertEquals("/api/device/declarations", back.takeRequest().path)
        assertTrue(Outbox(dir, clock).pending().isEmpty())
        back.shutdown()
    }

    @Test
    fun `stops at server trouble so later actions never overtake earlier ones`() {
        server.enqueue(MockResponse().setResponseCode(503).setBody("""{"message":"busy"}"""))
        val outbox = Outbox(dir, clock)
        outbox.add("e1", "Duty On", "/device/duty", body, "g")
        outbox.add("e2", "Scan", "/device/patrols/scan", body, "g")
        assertTrue(outbox.flush(api()).isEmpty())
        assertEquals(1, server.requestCount)
        assertEquals(listOf("e1", "e2"), outbox.pending().map { it.eventId })
        assertEquals("busy", outbox.pending().first().lastError)
    }

    @Test
    fun `moves a refused action aside with the reason, and carries on with the rest`() {
        server.enqueue(MockResponse().setResponseCode(409).setBody("""{"message":"You are still on duty from an earlier shift."}"""))
        server.enqueue(MockResponse().setBody("{}"))
        val outbox = Outbox(dir, clock)
        outbox.add("e1", "Duty On", "/device/duty", body, "g")
        outbox.add("e2", "Heartbeat", "/device/heartbeat", body, "g")
        val r = outbox.flush(api())
        assertEquals(Submitted.Refused("You are still on duty from an earlier shift.", emptyMap()), r["e1"])
        assertTrue(r["e2"] is Submitted.Sent)
        assertTrue(outbox.pending().isEmpty())
        assertEquals("You are still on duty from an earlier shift.", outbox.failed().single().lastError)
    }

    @Test
    fun `keeps its own copy of a photo until it is sent, then removes it`() {
        val photo = File(dir, "selfie.jpg").apply { writeBytes(byteArrayOf(-1, -40, -1, 1, 2, 3)) }
        val outbox = Outbox(File(dir, "outbox"), clock)
        outbox.add("e1", "Selfie", "/device/declarations", body, "g", listOf(Upload("selfie", photo, "image/jpeg")))
        photo.delete() // the camera's temporary file is gone
        val kept = File(outbox.pending().single().files.single().path)
        assertTrue(kept.exists())
        server.enqueue(MockResponse().setBody("{}"))
        outbox.flush(api())
        val req = server.takeRequest()
        assertTrue(req.getHeader("Content-Type")!!.startsWith("multipart/form-data"))
        assertTrue(req.body.readUtf8().contains("name=\"selfie\""))
        assertFalse(kept.exists())
    }

    @Test
    fun `turns server messages into ones the guard can read`() {
        server.enqueue(MockResponse().setResponseCode(400).setBody("""{"message":"Please fix the highlighted fields.","errors":{"pin":"Your PIN is 4 to 6 digits."}}"""))
        val e = runCatching { api().post("/device/login", body) }.exceptionOrNull() as ApiException
        assertEquals(400, e.status)
        assertEquals(mapOf("pin" to "Your PIN is 4 to 6 digits."), e.errors)
        assertFalse(e.retryable)
        assertEquals(Instant.EPOCH, Instant.EPOCH)
    }
}
