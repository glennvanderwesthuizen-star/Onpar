package za.onpar.core

import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import org.junit.jupiter.api.io.TempDir
import java.io.File

/** Reports and re-orders on the phone (brief sections 6.6 and 6.7). */
class ReportTest {
    @TempDir lateinit var dir: File
    private lateinit var server: MockWebServer
    private lateinit var device: OnParDevice

    @BeforeEach fun start() {
        server = MockWebServer().apply { start() }
        server.enqueue(MockResponse().setBody("{}"))
        server.enqueue(MockResponse().setBody("""{"token":"guard-token","employee":{"id":"e1","name":"John Smith"}}"""))
        device = OnParDevice(dir)
        device.applySetup(DeviceSetup(server.url("/").toString().trimEnd('/'), "device-token-123456789012345"))
        device.signIn("0001", "123456")
        server.takeRequest(); server.takeRequest()
    }

    @AfterEach fun stop() = runCatching { server.shutdown() }.let { }

    private fun report(stage: String) = ReportItem("r1", 7, "maintenance", "amber", "Gate 2 motor", stage, "#db2777")

    @Test
    fun `a report needs a category, priority and description, and sends its photo with it`() {
        assertThrows<IllegalArgumentException> { device.reports.create("", "amber", "Gate", null) }
        assertEquals("Describe what you saw.", assertThrows<IllegalArgumentException> { device.reports.create("maintenance", "amber", "  ", null) }.message)
        server.enqueue(MockResponse().setBody("""{"id":"r1","number":7}"""))
        val photo = File(dir, "gate.jpg").apply { writeBytes(byteArrayOf(-1, -40, -1, 0)) }
        assertTrue(device.reports.create("maintenance", "amber", "Gate 2 motor is damaged", photo) is Submitted.Sent)
        val req = server.takeRequest()
        assertEquals("/api/device/reports", req.path)
        val body = req.body.readUtf8()
        assertTrue(body.contains("name=\"photo\"") && body.contains("Gate 2 motor is damaged"))
    }

    @Test
    fun `a report made with no signal waits and shows as waiting`() {
        server.shutdown()
        assertEquals(Submitted.Queued, device.reports.create("security", "red", "Suspicious vehicle at the gate", null))
        assertEquals(listOf("Report: Security (Red)"), device.reports.waiting().map { it.label })
    }

    @Test
    fun `follow-ups follow the same rules as the server`() {
        assertEquals("You can follow up once the report has been assigned.", assertThrows<IllegalArgumentException> { device.reports.followUp(report("reported"), "in_progress", "", null) }.message)
        assertEquals("This report is closed.", assertThrows<IllegalArgumentException> { device.reports.followUp(report("closed"), "done_ok", "", null) }.message)
        assertEquals("Say what is still wrong.", assertThrows<IllegalArgumentException> { device.reports.followUp(report("actioned"), "not_fixed", "", null) }.message)
        assertTrue(report("attendance_checked").awaitingInspection)
        server.enqueue(MockResponse().setBody("""{"stage":"job_inspected"}"""))
        assertTrue(device.reports.followUp(report("attendance_checked"), "done_ok", "Gate opens and closes", null) is Submitted.Sent)
        assertEquals("/api/device/reports/r1/follow-up", server.takeRequest().path)
    }

    @Test
    fun `personal re-orders use the issued item, site re-orders are free text, receipt only once on its way`() {
        val shirt = IssuedItem("i1", "Shirt", size = "L")
        assertTrue(assertThrows<IllegalArgumentException> { device.reorders.personal(shirt, "") }.message!!.startsWith("Say why"))
        server.enqueue(MockResponse().setBody("""{"id":"o1","number":3}"""))
        assertTrue(device.reorders.personal(shirt, "Torn on the fence") is Submitted.Sent)
        val b = server.takeRequest().body.readUtf8()
        assertTrue(b.contains("\"issuedItemId\":\"i1\"") && b.contains("\"kind\":\"personal\""))
        server.enqueue(MockResponse().setBody("""{"id":"o2","number":4}"""))
        assertTrue(device.reorders.site("Toilet paper", "2 packs", "") is Submitted.Sent)
        assertTrue(server.takeRequest().body.readUtf8().contains("\"quantity\":\"2 packs\""))
        val requested = ReorderItem("o1", 3, "personal", "Shirt", "L", stage = "requested", mine = true, canConfirm = false)
        assertEquals("This has not been ordered yet.", assertThrows<IllegalArgumentException> { device.reorders.received(requested, "") }.message)
    }

    @Test
    fun `logging out forgets reports, re-orders and kit`() {
        server.enqueue(MockResponse().setBody("""[{"id":"r1","number":7,"category":"maintenance","priority":"amber","stage":"assigned"}]"""))
        device.reports.list()
        device.signOut()
        assertTrue(device.reports.cached().isEmpty())
    }
}
