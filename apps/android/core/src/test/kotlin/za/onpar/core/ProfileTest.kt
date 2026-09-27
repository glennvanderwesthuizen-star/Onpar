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

/** Score with the Query button, training, and approved contacts (brief sections 6.8 to 6.10). */
class ProfileTest {
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

    private val late = ScoreEvent("ev1", "2026-09-26", "late", "Late arrival", -1.0, "17 min late for the Day shift", canQuery = true)

    @Test
    fun `shows the score and why it changed, and keeps it for when there is no signal`() {
        server.enqueue(MockResponse().setBody("""{"score":79,"position":"ON_PAR","positionLabel":"On Par","events":[
            {"id":"ev1","date":"2026-09-26","type":"late","label":"Late arrival","impact":-1,"evidence":"17 min late","canQuery":true}]}"""))
        assertEquals(79, device.profile.score()!!.score)
        server.shutdown()
        val cached = device.profile.score()!!
        assertEquals("Late arrival", cached.events.single().label)
    }

    @Test
    fun `a lost point can be queried once, with a reason`() {
        assertEquals("Say why you disagree.", assertThrows<IllegalArgumentException> { device.profile.query(late, "no") }.message)
        server.enqueue(MockResponse().setBody("""{"id":"q1","answerDue":"2026-10-01"}"""))
        assertEquals("2026-10-01", device.profile.query(late, "The gate was locked and I waited for the key"))
        assertEquals("/api/device/score/events/ev1/query", server.takeRequest().path)
        val queried = late.copy(canQuery = false, queryStatus = "open")
        assertEquals("You have already queried this.", assertThrows<IllegalArgumentException> { device.profile.query(queried, "again please") }.message)
    }

    @Test
    fun `only approved numbers can be dialled, and the list works with no signal and before login`() {
        server.enqueue(MockResponse().setBody("""[{"kind":"supervisor","label":"Supervisor","name":"Thabo","phone":"082 555 0101"},{"kind":"control_room","label":"Control room","phone":"011 555 0100"}]"""))
        device.signOut()
        assertEquals(2, device.profile.contacts().size)
        assertTrue(device.profile.isApproved("0825550101"))
        assertTrue(device.profile.isApproved("+27 82 555 0101"))
        assertFalse(device.profile.isApproved("0821234567"))
        server.shutdown()
        assertEquals(listOf("Supervisor", "Control room"), device.profile.contacts().map { it.label })
    }
}
