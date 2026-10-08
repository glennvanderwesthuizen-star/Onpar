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

    @Test
    fun `the emergency panel has police with two numbers, keeps the armed response logo on the phone, and records a tapped call`() {
        val list = """[{"kind":"control_room","label":"Control room","phone":"011 555 0100"},
          {"kind":"police_national","label":"Police 10111","name":"National emergency number","phone":"10111","emergency":"police","national":true},
          {"kind":"police_station","label":"Local police station","name":"Sandton SAPS","phone":"011 555 0001","emergency":"police"},
          {"kind":"fire_national","label":"Fire brigade 10177","phone":"10177","emergency":"fire","national":true},
          {"kind":"ambulance","label":"Ambulance","name":"Private ambulance","phone":"011 555 0003","emergency":"ambulance"},
          {"kind":"armed_response","label":"Armed response","name":"Fast Response","phone":"011 555 0004","emergency":"armed_response","logo":"abc.png"}]"""
        server.enqueue(MockResponse().setBody(list))
        server.enqueue(MockResponse().setBody("LOGO"))
        val buttons = device.profile.contacts().emergencyButtons()
        assertEquals(listOf("police", "fire", "ambulance", "armed_response"), buttons.map { it.service })
        assertEquals(listOf("10111", "011 555 0001"), buttons[0].options.map { it.phone })
        assertEquals(1, buttons[1].options.size)
        // After PANIC the control room is the first of five.
        assertEquals(listOf("control_room", "police", "fire", "ambulance", "armed_response"), device.profile.cachedContacts().emergencyButtons(withControlRoom = true).map { it.service })
        assertEquals("LOGO", device.profile.armedLogo()?.decodeToString())
        assertTrue(device.profile.isApproved("10111"))
        assertTrue(device.profile.isApproved("10177"))
        assertFalse(device.profile.isApproved("10112"))
        server.takeRequest(); assertEquals("/api/device/armed-response-logo", server.takeRequest().path)
        // The same logo is not fetched again.
        server.enqueue(MockResponse().setBody(list))
        device.profile.contacts()
        assertEquals(5, server.requestCount)
        // A tapped number is recorded against the panic.
        server.enqueue(MockResponse().setBody("""{"id":"x"}"""))
        assertTrue(device.alerts.emergencyCall("police_station", "11111111-1111-1111-1111-111111111111") is Submitted.Sent)
        server.takeRequest(); server.takeRequest().let { r -> assertEquals("/api/device/emergency-calls", r.path); assertTrue(r.body.readUtf8().contains("police_station")) }
        // With no signal the logo and the numbers are still there.
        server.shutdown()
        assertEquals(4, device.profile.contacts().emergencyButtons().size)
        assertEquals("LOGO", device.profile.armedLogo()?.decodeToString())
    }

    @Test
    fun `My Wire shows what he earned and is kept for when there is no signal`() {
        server.enqueue(MockResponse().setBody("""{"insignia":"black","insigniaLabel":"Black barb","wireTotal":261,"available":261,"barbsDrawn":2,
          "thisMonth":{"total":9,"bySource":[{"rule":"ready_for_duty","label":"Ready for duty","barbs":3}]},"streak":3,
          "next":{"name":"Silver barb","toGo":739,"months":9},"months":[{"month":"2026-09","barbs":92,"award":"standard"}],"perShift":3,"readyLeadMinutes":15,
          "recent":[{"date":"2026-10-05","label":"Ready for duty","barbs":1}]}"""))
        val w = device.profile.wire()!!
        assertEquals(261, w.wireTotal)
        assertEquals("Silver barb", w.next.name)
        assertEquals("/api/device/wire", server.takeRequest().path)
        server.shutdown()
        assertEquals(3, device.profile.wire()!!.streak)
    }

    @Test
    fun `a Thuthuka note needs its three answers and goes to the server`() {
        assertEquals("Say what you noticed.", assertThrows<IllegalArgumentException> { device.profile.sendNote("", "Put it on a timer", "Safety", null) }.message)
        server.enqueue(MockResponse().setBody("""{"id":"x","barbs":2}"""))
        assertTrue(device.profile.sendNote("Gate 3 light is off", "Put it on a timer", "Safety", null) is Submitted.Sent)
        val r = server.takeRequest()
        assertEquals("/api/device/wire/notes", r.path)
        assertTrue(r.body.readUtf8().contains("Put it on a timer"))
        server.enqueue(MockResponse().setBody("""[{"id":"x","date":"2026-10-08","suggestion":"Put it on a timer","status":"adopted","statusLabel":"Adopted","reason":"Done"}]"""))
        assertEquals("Adopted", device.profile.wireNotes().single().statusLabel)
    }
}
