package za.onpar.core

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
import java.time.Duration
import java.time.Instant

/** Patrols on the phone with no signal, and the checks at each point (brief section 6.5, scenarios 5 and 7). */
class PatrolTest {
    @TempDir lateinit var dir: File
    private lateinit var server: MockWebServer
    private lateinit var device: OnParDevice
    private val here = Fix(-26.1, 28.05, 8.0)

    private fun state() = """{"onDuty":true,"types":[
        {"id":"A","code":"A","name":"Internal","maxDurationMinutes":45,"canStart":true,"points":[
          {"id":"p1","name":"Gate","qrHash":"${PatrolActions.sha256("OP-GATE")}"},
          {"id":"p2","name":"Generator room","photoMode":"required","checks":[
             {"id":"fuel","kind":"number","label":"Fuel","unit":"litres","below":50},
             {"id":"door","kind":"ok_problem","label":"Door"}],"qrHash":"${PatrolActions.sha256("OP-GEN")}"}]},
        {"id":"B","code":"B","name":"Perimeter","canStart":true,"points":[{"id":"p9","name":"North fence","qrHash":"${PatrolActions.sha256("OP-NORTH")}"}]}
      ],"active":null}"""

    @BeforeEach fun start() {
        server = MockWebServer().apply { start() }
        server.enqueue(MockResponse().setBody("{}"))
        server.enqueue(MockResponse().setBody("""{"token":"guard-token","employee":{"id":"e1","name":"John Smith"}}"""))
        server.enqueue(MockResponse().setBody(state()))
        device = OnParDevice(dir)
        device.applySetup(DeviceSetup(server.url("/").toString().trimEnd('/'), "device-token-123456789012345"))
        device.signIn("0001", "123456")
        device.patrols.state()
        repeat(3) { server.takeRequest() }
    }

    @AfterEach fun stop() = runCatching { server.shutdown() }.let { }

    @Test
    fun `recognises a scanned point from its fingerprint, never holding the code`() {
        assertEquals("Generator room", device.patrols.pointFor("OP-GEN")!!.second.name)
        assertNull(device.patrols.pointFor("OP-FAKE"))
        assertFalse(File(dir, "patrols.json").readText().contains("OP-GEN"))
    }

    @Test
    fun `refuses a location from a fake-GPS app`() {
        assertTrue(assertThrows<IllegalArgumentException> { device.patrols.scan("OP-GATE", here.copy(mock = true)) }.message!!.contains("fake-GPS"))
    }

    @Test
    fun `with no signal the patrol starts on the phone, counts down, and scans wait to be checked`() {
        server.shutdown()
        val before = Instant.now()
        val out = device.patrols.scan("OP-GATE", here)
        assertTrue(out.waiting)
        assertNull(out.accepted)
        val p = device.patrols.active()!!
        assertEquals("Internal", p.typeName)
        assertEquals(setOf("p1"), p.done) // nothing to record at the gate
        assertTrue(Duration.between(before, p.deadline()).toMinutes() in 44..45)
        // Any order (scenario 5): the generator room next, then its checks.
        device.patrols.scan("OP-GEN", here)
        assertEquals(setOf("p1", "p2"), device.patrols.active()!!.scanned)
        assertEquals(p.id, device.outbox.pending().map { it.body.toString() }.filter { it.contains("patrolId") }.map { Regex("\"patrolId\":\"([^\"]+)\"").find(it)!!.groupValues[1] }.distinct().single())
    }

    @Test
    fun `will not start another patrol's point while one is in progress`() {
        server.shutdown()
        device.patrols.scan("OP-GATE", here)
        val out = device.patrols.scan("OP-NORTH", here)
        assertEquals(false, out.accepted)
        assertTrue(out.message.contains("belongs to another patrol"))
    }

    @Test
    fun `needs everything the point asks for, and warns of a reading out of limit (scenario 7)`() {
        server.shutdown()
        device.patrols.scan("OP-GEN", here)
        val (_, gen) = device.patrols.pointFor("OP-GEN")!!
        val id = device.patrols.active()!!.id
        val photo = File(dir, "gen.jpg").apply { writeBytes(byteArrayOf(-1, -40, -1, 0)) }
        assertEquals("Take the photo for Generator room.", assertThrows<IllegalArgumentException> { device.patrols.saveChecks(id, gen, "", null, mapOf("fuel" to 30.0), mapOf("door" to true), emptyMap()) }.message)
        assertEquals("Enter Fuel.", assertThrows<IllegalArgumentException> { device.patrols.saveChecks(id, gen, "", photo, emptyMap(), mapOf("door" to true), emptyMap()) }.message)
        assertTrue(gen.checks.first { it.id == "fuel" }.outOfLimit(30.0))
        assertFalse(gen.checks.first { it.id == "fuel" }.outOfLimit(70.0))
        assertEquals(Submitted.Queued, device.patrols.saveChecks(id, gen, "", photo, mapOf("fuel" to 30.0), mapOf("door" to true), emptyMap()))
        assertTrue("p2" in device.patrols.active()!!.done)
        val item = device.outbox.pending().last()
        assertEquals("/device/patrols/$id/points/p2", item.path)
        assertEquals(listOf("photo"), item.files.map { it.field })
    }

    @Test
    fun `ending a patrol early needs a reason and clears it from the phone`() {
        server.shutdown()
        device.patrols.scan("OP-GATE", here)
        val id = device.patrols.active()!!.id
        assertThrows<IllegalArgumentException> { device.patrols.cannotFinish(id, "") }
        assertEquals(Submitted.Queued, device.patrols.cannotFinish(id, "Generator room locked"))
        assertNull(device.patrols.active())
    }

    @Test
    fun `logging out forgets patrol data`() {
        device.signOut()
        assertTrue(device.patrols.cached().types.isEmpty())
    }
}
