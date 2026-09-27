package za.onpar.core

import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import org.junit.jupiter.api.io.TempDir
import java.io.File
import java.time.LocalTime

/** Tasks on the phone (brief sections 6.4 and 25, scenario 1). */
class TaskTest {
    @TempDir lateinit var dir: File
    private lateinit var server: MockWebServer
    private lateinit var device: OnParDevice

    private val list = """[
        {"id":"t1","date":"2026-09-27","title":"Generator check","instructions":"Check the fuel","dueTime":null,"photoRequired":true,"state":"open","anyTime":true},
        {"id":"t2","date":"2026-09-27","title":"Lock the pool gate","dueTime":"09:00","photoRequired":false,"state":"open"},
        {"id":"t3","date":"2026-09-27","title":"Inspect the work on report #1","photoRequired":false,"state":"open","reportId":"r1"}
    ]"""

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

    private val photo get() = File(dir, "p.jpg").apply { writeBytes(byteArrayOf(-1, -40, -1, 0)) }

    @Test
    fun `shows today's tasks, untimed ones as any time, and an overdue timed one`() {
        server.enqueue(MockResponse().setBody(list))
        val tasks = device.tasks.today()
        assertEquals(listOf("Generator check", "Lock the pool gate", "Inspect the work on report #1"), tasks.map { it.title })
        assertFalse(tasks[0].overdue(LocalTime.of(23, 0)))
        assertFalse(tasks[1].overdue(LocalTime.of(8, 59)))
        assertTrue(tasks[1].overdue(LocalTime.of(9, 1)))
        assertTrue(tasks[2].isInspection)
    }

    @Test
    fun `keeps the list for when there is no signal`() {
        server.enqueue(MockResponse().setBody(list))
        device.tasks.today()
        server.shutdown()
        assertEquals(3, device.tasks.today().size)
    }

    @Test
    fun `needs the photo when the task requires one, then sends the task first and the photo after`() {
        server.enqueue(MockResponse().setBody(list))
        val t1 = device.tasks.today()[0]
        assertEquals("This task needs a photo.", assertThrows<IllegalArgumentException> { device.tasks.complete(t1, "", null) }.message)
        server.enqueue(MockResponse().setBody("{}"))
        server.enqueue(MockResponse().setBody("{}"))
        assertTrue(device.tasks.complete(t1, "Fuel at 70 litres", photo) is Submitted.Sent)
        server.takeRequest()
        val done = server.takeRequest()
        assertEquals("/api/device/tasks/t1/complete", done.path)
        val body = done.body.readUtf8()
        assertTrue(body.contains("\"photoToFollow\":true") && body.contains("Fuel at 70 litres"))
        assertEquals("/api/device/tasks/t1/photo", server.takeRequest().path)
    }

    @Test
    fun `done with no signal shows as waiting, and cannot be done twice`() {
        server.enqueue(MockResponse().setBody(list))
        val t2 = device.tasks.today()[1]
        server.shutdown()
        assertEquals(Submitted.Queued, device.tasks.complete(t2, "", null))
        val after = device.tasks.today()[1]
        assertTrue(after.waiting)
        assertEquals("completed", after.state)
        assertEquals("This task has already been done.", assertThrows<IllegalArgumentException> { device.tasks.complete(after, "", null) }.message)
    }

    @Test
    fun `could not complete needs a reason, and an explanation for Other`() {
        server.enqueue(MockResponse().setBody(list))
        val t2 = device.tasks.today()[1]
        assertThrows<IllegalArgumentException> { device.tasks.cannotComplete(t2, "", "", null) }
        assertEquals("Say what happened.", assertThrows<IllegalArgumentException> { device.tasks.cannotComplete(t2, "other", " ", null) }.message)
        server.enqueue(MockResponse().setBody("{}"))
        assertTrue(device.tasks.cannotComplete(t2, "access_unavailable", "Gate padlocked", null) is Submitted.Sent)
        server.takeRequest()
        val r = server.takeRequest()
        assertEquals("/api/device/tasks/t2/cannot-complete", r.path)
        assertTrue(r.body.readUtf8().contains("\"reason\":\"access_unavailable\""))
    }

    @Test
    fun `inspection tasks are recorded on the report, not here`() {
        server.enqueue(MockResponse().setBody(list))
        val t3 = device.tasks.today()[2]
        assertTrue(assertThrows<IllegalArgumentException> { device.tasks.complete(t3, "", null) }.message!!.startsWith("Record this inspection on the report"))
    }

    @Test
    fun `a refused action clears the waiting mark`() {
        server.enqueue(MockResponse().setBody(list))
        val t2 = device.tasks.today()[1]
        server.enqueue(MockResponse().setResponseCode(409).setBody("""{"message":"Log Duty On before doing tasks."}"""))
        val r = device.tasks.complete(t2, "", null)
        assertEquals("Log Duty On before doing tasks.", (r as Submitted.Refused).message)
        server.enqueue(MockResponse().setBody(list))
        assertFalse(device.tasks.today()[1].waiting)
    }

    @Test
    fun `logging out forgets the list`() {
        server.enqueue(MockResponse().setBody(list))
        device.tasks.today()
        device.signOut()
        assertTrue(device.tasks.cached().isEmpty())
    }
}
