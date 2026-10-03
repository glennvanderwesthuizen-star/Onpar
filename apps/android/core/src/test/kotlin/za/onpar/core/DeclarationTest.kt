package za.onpar.core

import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import org.junit.jupiter.api.io.TempDir
import java.io.File

/** Duty On with no signal, then the declaration (brief sections 6.2 and 8, scenario 10). */
class DeclarationTest {
    @TempDir lateinit var dir: File

    private fun device(server: MockWebServer): OnParDevice {
        server.enqueue(MockResponse().setBody("""{"serverTime":"2026-09-27T04:00:00Z"}""")) // setup check
        server.enqueue(MockResponse().setBody("""{"token":"guard-token","employee":{"id":"e1","name":"John Smith"}}"""))
        val d = OnParDevice(dir)
        d.applySetup(DeviceSetup(server.url("/").toString().trimEnd('/'), "device-token-123456789012345"))
        d.signIn("0001", "123456")
        server.takeRequest(); server.takeRequest()
        return d
    }

    private val selfie get() = File(dir, "selfie.jpg").apply { writeBytes(byteArrayOf(-1, -40, -1, 0, 1)) }

    @Test
    fun `after Duty On with no signal, the declaration is still owed and asked for on the phone`() {
        val server = MockWebServer().apply { start() }
        val d = device(server)
        server.enqueue(MockResponse().setResponseCode(503)) // server trouble: Duty On waits
        val (dutyId, r) = d.duty(DutyKind.ON, "123456")
        assertEquals(Submitted.Queued, r)
        val owed = d.owedDeclaration(null)!!
        assertEquals("duty_on", owed.kind)
        assertEquals(dutyId, owed.dutyEventId)
        assertEquals(4, owed.wording.statements.size)
        server.shutdown()
    }

    @Test
    fun `cannot declare without ticking every statement and taking the selfie`() {
        val server = MockWebServer().apply { start() }
        val d = device(server)
        val owed = PendingDeclaration("duty_on", "d1", DeclarationText.DUTY_ON)
        assertEquals("Tick every statement to continue.", assertThrows<IllegalArgumentException> { d.declare(owed, listOf(true, false, true), "", false, "green", selfie) }.message)
        assertEquals("Take your selfie to continue.", assertThrows<IllegalArgumentException> { d.declare(owed, listOf(true, true, true, true), "", false, "green", File(dir, "none.jpg")) }.message)
        assertTrue(assertThrows<IllegalArgumentException> { d.declare(owed, listOf(true, true, true, true), " ", true, "amber", selfie) }.message!!.startsWith("Describe the problem"))
        server.shutdown()
    }

    @Test
    fun `sends the declaration text first, then the selfie, and nothing is owed afterwards`() {
        val server = MockWebServer().apply { start() }
        val d = device(server)
        server.enqueue(MockResponse().setBody("{}")) // Duty On
        val (dutyId, _) = d.duty(DutyKind.ON, "123456")
        server.takeRequest()
        server.enqueue(MockResponse().setBody("""{"id":"x"}"""))
        server.enqueue(MockResponse().setBody("{}"))
        val r = d.declare(d.owedDeclaration(null)!!, listOf(true, true, true, true), "Torch at Gate 2 does not work", true, "amber", selfie)
        assertTrue(r is Submitted.Sent)
        val text = server.takeRequest()
        assertEquals("/api/device/declarations", text.path)
        val body = text.body.readUtf8()
        assertTrue(body.contains("\"dutyEventId\":\"$dutyId\""))
        assertTrue(body.contains("\"selfieToFollow\":true"))
        assertTrue(body.contains("\"raiseEquipmentReport\":true"))
        val photo = server.takeRequest()
        assertTrue(photo.path!!.matches(Regex("/api/device/declarations/[0-9a-f-]{36}/selfie")))
        assertNull(d.owedDeclaration(null))
        assertTrue(d.outbox.pending().isEmpty())
        server.shutdown()
    }

    @Test
    fun `forgets a declaration whose Duty On was refused`() {
        val server = MockWebServer().apply { start() }
        val d = device(server)
        server.enqueue(MockResponse().setResponseCode(409).setBody("""{"message":"You are still on duty from an earlier shift."}"""))
        val (_, r) = d.duty(DutyKind.ON, "123456")
        assertTrue(r is Submitted.Refused)
        assertNull(d.owedDeclaration(null))
        server.shutdown()
    }
}
