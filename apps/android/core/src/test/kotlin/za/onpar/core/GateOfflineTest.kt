package za.onpar.core

import kotlinx.serialization.json.boolean
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
import org.junit.jupiter.api.io.TempDir
import java.io.File
import java.time.LocalDateTime

/** Visitor management, step 7: the gate without signal. The same checks as the server, on the phone. */
class GateOfflineTest {
    @TempDir lateinit var dir: File
    private lateinit var server: MockWebServer
    private lateinit var device: OnParDevice

    private val once = OfflinePass(id = "p1", kind = "once", visitorName = "Sipho Nkosi", unitId = "u14", visiting = "Unit 14", by = "Thabo Tenant", visitDate = "2026-10-08", idNumber = "PASS0001")
    private val regular = OfflinePass(
        id = "p2", kind = "ongoing", visitorName = "Gardener", unitId = "u20", visiting = "Unit 20", registration = "CA12345",
        days = listOf(1, 2, 3, 4, 5), hoursFrom = "07:00", hoursTo = "17:00", startDate = "2026-10-01", endDate = "2026-10-31",
    )
    private val pack = OfflinePack(
        at = "2026-10-08T08:00:00Z", today = "2026-10-08", gateId = "g1", hasClient = true,
        office = OfflineNumbers("0115550100"),
        units = listOf(OfflineUnit("u14", "14", "0825550140", "0835550199"), OfflineUnit("u20", "20")),
        passes = listOf(regular, once),
        barred = listOf(OfflineBarred("id_number", "BAD00001"), OfflineBarred("registration", "ND999000", "u20")),
        onSite = listOf(OfflineOnSite("v9", "vehicle", 2, "8001015009087", "GP12345", "Dlamini, T J", "Unit 14")),
    )
    private fun at(s: String) = LocalDateTime.parse(s)

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

    @Test
    fun `a pass applies at the same times as on the server`() {
        assertTrue(GateOffline.applies(once, at("2026-10-08T23:59")))
        assertFalse(GateOffline.applies(once, at("2026-10-09T00:01")))
        val timed = once.copy(time = "10:00")
        assertTrue(GateOffline.applies(timed, at("2026-10-08T09:00")))
        assertTrue(GateOffline.applies(timed, at("2026-10-08T11:00")))
        assertFalse(GateOffline.applies(timed, at("2026-10-08T11:01")))
        val late = once.copy(time = "23:30")
        assertTrue(GateOffline.applies(late, at("2026-10-09T00:20")))
        assertFalse(GateOffline.applies(late, at("2026-10-09T00:31")))
        assertTrue(GateOffline.applies(regular, at("2026-10-08T07:00")))
        assertFalse(GateOffline.applies(regular, at("2026-10-08T17:01")))
        assertFalse(GateOffline.applies(regular, at("2026-10-10T09:00")))
        assertFalse(GateOffline.applies(regular, at("2026-11-02T09:00")))
    }

    @Test
    fun `finds the expected visitor, a one-visit pass first, and says what does not match`() {
        val m = GateOffline.expected(pack, "PASS0001", "XX111", null, at("2026-10-08T12:00"))!!
        assertEquals("p1", m.passId)
        assertEquals(listOf<String>(), m.mismatch)
        val r = GateOffline.expected(pack, "OTHER123", "CA 12-345", null, at("2026-10-08T12:00"))!!
        assertEquals("p2", r.passId)
        assertTrue(r.regular)
        assertNull(GateOffline.expected(pack, "OTHER123", "CA 12-345", null, at("2026-10-08T18:00")))
        assertNull(GateOffline.expected(pack, null, null, null, at("2026-10-08T12:00")))
    }

    @Test
    fun `checks the barred list for the site and for the unit visited`() {
        assertEquals("ID number", GateOffline.barred(pack, null, "BAD00001", null).single().kindLabel)
        assertTrue(GateOffline.barred(pack, "u14", null, "ND 999 000").isEmpty())
        assertEquals("unit", GateOffline.barred(pack, "u20", null, "ND 999 000").single().from)
        val c = GateOffline.check(pack, "8001015009087", null, "u14", null, at("2026-10-08T12:00"))
        assertTrue(c.offline)
        assertEquals("Dlamini, T J", c.onSite.single().visitor)
    }

    @Test
    fun `decides without a call for the barred and the expected, and calls for anyone else`() {
        val d = VisitDraft("e1", "pedestrian", VisitPerson("PASS0001", "Nkosi", "S", "passport", "manual"), null, null, null, "c1", null, false, emptyList(), null, null, null, passId = "p1")
        val expected = GateOffline.check(pack, "PASS0001", null, null, null, at("2026-10-08T12:00"))
        assertEquals("pass", GateOffline.decisionWithoutCall(expected, d))
        assertEquals("barred", GateOffline.decisionWithoutCall(GateOffline.check(pack, "BAD00001", null, "u14", null, at("2026-10-08T12:00")), d.copy(passId = null)))
        assertNull(GateOffline.decisionWithoutCall(GateOffline.check(pack, "NOBODY01", null, "u14", null, at("2026-10-08T12:00")), d.copy(passId = null)))
        assertEquals(OfflineNumbers("0825550140", "0835550199"), GateOffline.numbers(pack, "u14"))
        assertEquals("0115550100", GateOffline.numbers(pack, null).primary)
        assertFalse(GateOffline.numbers(pack, "u20").any)
    }

    @Test
    fun `scans out from the phone's list, and raises not scanned in when nobody matches`() {
        val found = GateOffline.exitFind(pack, null, "GP 12 345", paxCount = true)
        assertEquals("v9", found.visit?.id)
        assertTrue(found.askPax)
        assertTrue(found.offline)
        val none = GateOffline.exitFind(pack, "NEVERIN1", null, paxCount = true)
        assertNull(none.visit)
        assertEquals("no_open_visit", none.exceptions.single().type)
    }

    @Test
    fun `with no signal the check comes from the pack, and the visit waits on the phone with the guard's decision`() {
        server.enqueue(MockResponse().setBody(OnParJson.encodeToString(OfflinePack.serializer(), pack)))
        assertEquals("g1", device.visitors.refreshPack()?.gateId)
        server.takeRequest()
        server.shutdown()
        val c = device.visitors.check("BAD00001", null, "u14")
        assertTrue(c.offline)
        assertEquals(1, c.barred.size)
        val setup = GateSetup(gate = Gate("g1", "Main gate"), categories = listOf(VisitorCategory("c1", "Visitor")), units = listOf(VisitUnit("u14", "14")), today = "2026-10-08")
        val photo = File(dir, "id.jpg").apply { writeBytes(byteArrayOf(-1, -40, -1, 0)) }
        val d = VisitDraft("22222222-2222-4222-8222-222222222222", "pedestrian", VisitPerson("NOBODY01", "Mokoena", "L", "passport", "manual"), null, null, null, "c1", "u14", false, emptyList(), null, photo, null)
        val reply = device.visitors.createOffline(setup, d, "approved", "primary")
        assertEquals("on_site", reply.status)
        val item = device.outbox.pending().single()
        assertEquals("/device/visitors", item.path)
        val body = item.body.jsonObject
        assertTrue(body["capturedOffline"]!!.jsonPrimitive.boolean)
        assertEquals("approved", body["offline"]!!.jsonObject["decision"]!!.jsonPrimitive.content)
        assertEquals("primary", body["offline"]!!.jsonObject["contact"]!!.jsonPrimitive.content)
        assertEquals(1, item.files.size)
        // The exit with no signal also waits, and the visitor comes off the phone's list.
        val found = device.visitors.exitFind(null, "GP12345")
        assertTrue(found.offline)
        val out = device.visitors.exitOffline(ExitDraft("33333333-3333-4333-8333-333333333333", null, null, "GP12345", null, 2), found)
        assertEquals("exited", out.status)
        assertEquals(2, device.outbox.pending().size)
        assertTrue(device.visitors.pack()!!.onSite.isEmpty())
    }

    @Test
    fun `an Occurrence Book entry from the post phone waits on the phone with no signal`() {
        org.junit.jupiter.api.assertThrows<IllegalArgumentException> { device.book.write("x") }
        server.shutdown()
        device.book.write("Gate 3 light out, told the supervisor by radio.")
        val item = device.outbox.pending().single()
        assertEquals("/device/occurrence-book", item.path)
        assertEquals("Gate 3 light out, told the supervisor by radio.", item.body.jsonObject["text"]!!.jsonPrimitive.content)
    }
}
