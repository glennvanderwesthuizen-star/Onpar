package za.onpar.core

import com.google.zxing.BarcodeFormat
import com.google.zxing.common.BitMatrix
import com.google.zxing.oned.Code39Writer
import com.google.zxing.pdf417.PDF417Writer
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

/** Visitor management, step 2: reading documents at the gate and saving a visitor. */
class VisitorTest {
    @TempDir lateinit var dir: File
    private lateinit var server: MockWebServer
    private lateinit var device: OnParDevice

    private val discText = "%MVL1CC62%0142%4024A0B5%1%4024021NDC0F%GMV945GP%CCK435W%Hatch back / Luikrug%VOLKSWAGEN%POLO VIVO%White / Wit%AAVZZZ6SZDU012345%CLS123456%2027-05-31%"
    private val cardText = "DLAMINI|THABO JOHN|M|RSA|8001015009087|01 Jan 1980|RSA|CITIZEN|12 Mar 2019|12345|A12345678|1234567890"

    private val setup = GateSetup(
        gate = Gate("g1", "Main gate"),
        checks = mapOf("paxCount" to true, "facePhoto" to true, "expiredLicenceOk" to true),
        categories = listOf(VisitorCategory("c1", "Once-off visitor")),
        units = listOf(VisitUnit("u14", "14")),
        today = "2026-10-07",
    )
    private val driver = VisitPerson("900101 5009 086", "Dlamini", "T J", "drivers_licence", "manual")
    private val car = VisitVehicle("ca 123-456", "Toyota", "Corolla", "White", "", "2027-03-31", "scan")

    private fun photo(name: String) = File(dir, name).apply { writeBytes(byteArrayOf(-1, -40, -1, 0)) }

    private fun draft(
        type: String = "vehicle", person: VisitPerson = driver, vehicle: VisitVehicle? = car, licenceExpiry: String? = null, pax: Int? = 1,
        unitId: String? = "u14", office: Boolean = false, acknowledged: List<String> = emptyList(), face: File? = null, identityPhoto: File? = photo("licence.jpg"), discPhoto: File? = null,
    ) = VisitDraft("11111111-1111-4111-8111-111111111111", type, person, vehicle, licenceExpiry, pax, "c1", unitId, office, acknowledged, face, identityPhoto, discPhoto)

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
    fun `a licence disc gives the number plate, make, model, colour, VIN and expiry`() {
        assertEquals(Scanned.Disc("GMV945GP", "VOLKSWAGEN", "POLO VIVO", "White", "AAVZZZ6SZDU012345", "2027-05-31"), VisitorScan.read(discText))
        // A disc with no expiry date at the end is still read, counted from the front.
        val noDate = discText.replace("2027-05-31", "")
        assertEquals("GMV945GP", (VisitorScan.read(noDate) as Scanned.Disc).registration)
        assertNull(VisitorScan.disc("%MVL1CC62%0142%"))
        assertNull(VisitorScan.disc(cardText))
    }

    @Test
    fun `an ID card gives the surname, names and ID number, and an ID book the number only`() {
        assertEquals(Scanned.Identity("8001015009087", "DLAMINI", "THABO JOHN", "id_card"), VisitorScan.read(cardText))
        assertEquals(Scanned.Identity("8001015009087", "", "", "id_book"), VisitorScan.read("8001015009087"))
        // A number that fails the check digit is not an ID number.
        assertEquals(Scanned.Unknown, VisitorScan.read("8001015009088"))
        assertEquals(Scanned.Unknown, VisitorScan.read("https://example.com/qr"))
        assertTrue(SaId.valid("8001015009087"))
        assertFalse(SaId.valid("800101500908"))
    }

    @Test
    fun `a driver's licence is recognised as one that must be photographed and typed`() {
        val locked = String(CharArray(720) { (it % 90 + 33).toChar() })
        assertEquals(Scanned.DriversLicence, VisitorScan.read(locked))
    }

    /** A barcode as a camera picture: dark bars on white, with a white border. */
    private fun picture(m: BitMatrix): Triple<ByteArray, Int, Int> {
        val border = 20
        val w = m.width + 2 * border
        val h = m.height + 2 * border
        val luma = ByteArray(w * h) { -1 }
        for (y in 0 until m.height) for (x in 0 until m.width) if (m.get(x, y)) luma[(y + border) * w + x + border] = 0
        return Triple(luma, w, h)
    }

    @Test
    fun `the scanner reads a licence disc barcode upright and on its side`() {
        val (luma, w, h) = picture(PDF417Writer().encode(discText, BarcodeFormat.PDF_417, 900, 300))
        val reader = BarcodeReader()
        assertEquals(discText, reader.read(luma, w, w, h))
        // As the camera sees it when the phone is held upright: a quarter turn.
        val turned = BarcodeReader.turn(luma, w, w, h)
        assertEquals(discText, reader.read(turned, h, h, w))
        // And with rows wider than the picture, as some cameras deliver them.
        val padded = ByteArray((w + 16) * h) { -1 }
        for (y in 0 until h) System.arraycopy(luma, y * w, padded, y * (w + 16), w)
        assertEquals(discText, reader.read(padded, w + 16, w, h))
    }

    @Test
    fun `the scanner reads an ID book's barcode, and finds nothing in a blank picture`() {
        val (luma, w, h) = picture(Code39Writer().encode("8001015009087", BarcodeFormat.CODE_39, 600, 120))
        val reader = BarcodeReader()
        assertEquals(Scanned.Identity("8001015009087", "", "", "id_book"), VisitorScan.read(reader.read(luma, w, w, h).orEmpty()))
        assertNull(reader.read(ByteArray(640 * 480) { -1 }, 640, 640, 480))
    }

    @Test
    fun `dates typed from a document are understood in the usual forms`() {
        assertEquals("2027-03-31", VisitorRules.day("31/03/2027"))
        assertEquals("2027-03-31", VisitorRules.day("2027-03-31"))
        assertEquals("2027-03-05", VisitorRules.day("5-3-2027"))
        assertNull(VisitorRules.day("31/02/2027"))
        assertNull(VisitorRules.day("next year"))
    }

    @Test
    fun `the gate is told what is missing before anything is sent`() {
        assertNull(VisitorRules.problem(setup, draft()))
        assertEquals("Enter the number of passengers (0 if the driver is alone).", VisitorRules.problem(setup, draft(pax = null)))
        assertEquals("Photograph the document you typed the details from.", VisitorRules.problem(setup, draft(identityPhoto = null)))
        assertEquals("Photograph the licence disc you typed the details from.", VisitorRules.problem(setup, draft(vehicle = car.copy(method = "manual"))))
        assertEquals("Scan the licence disc, or type the vehicle's details.", VisitorRules.problem(setup, draft(vehicle = null)))
        assertEquals("Choose who the visitor is here to see.", VisitorRules.problem(setup, draft(unitId = null)))
        // "The office" can be chosen only where the site has a client.
        assertEquals("Choose who the visitor is here to see.", VisitorRules.problem(setup, draft(unitId = null, office = true)))
        assertNull(VisitorRules.problem(setup.copy(hasClient = true), draft(unitId = null, office = true)))
        val walker = VisitPerson("8001015009087", "Nkosi", "Sipho", "id_card", "scan")
        assertEquals("Take a photo of the visitor's face.", VisitorRules.problem(setup, draft(type = "pedestrian", person = walker, vehicle = null, pax = null, identityPhoto = null)))
        assertNull(VisitorRules.problem(setup, draft(type = "pedestrian", person = walker, vehicle = null, pax = null, identityPhoto = null, face = photo("face.jpg"))))
    }

    @Test
    fun `an expired licence or disc is a warning only where the site does not accept them`() {
        val strict = setup.copy(checks = setup.checks + ("expiredLicenceOk" to false))
        assertEquals(emptyList<String>(), VisitorRules.warnings(setup, "2019-01-01", "2019-01-01"))
        assertEquals(listOf("licence_expired", "disc_expired"), VisitorRules.warnings(strict, "2026-10-06", "2020-01-31"))
        assertEquals(emptyList<String>(), VisitorRules.warnings(strict, "2026-10-07", null))
        assertEquals("Enter the date the licence expires.", VisitorRules.problem(strict, draft()))
        val old = draft(licenceExpiry = "2019-06-30")
        assertEquals("Confirm that you have seen the warning.", VisitorRules.problem(strict, old))
        assertNull(VisitorRules.problem(strict, old.copy(acknowledged = listOf("licence_expired"))))
    }

    @Test
    fun `a visit is sent with its numbers tidied and only the photos that are allowed`() {
        server.enqueue(MockResponse().setBody("""{"id":"v1","status":"awaiting_approval","statusLabel":"Awaiting approval","blocked":null}"""))
        val reply = device.visitors.create(setup, draft(discPhoto = photo("disc.jpg")))
        assertEquals(VisitReply("v1", "awaiting_approval", "Awaiting approval", null), reply)
        val req = server.takeRequest()
        assertEquals("/api/device/visitors", req.path)
        assertEquals("Bearer guard-token", req.getHeader("Authorization"))
        val body = req.body.readUtf8()
        assertTrue(body.contains("\"idNumber\":\"9001015009086\"") && body.contains("\"registration\":\"CA123456\""))
        assertTrue(body.contains("name=\"identity\""))
        // The disc was scanned, so its photo is not sent.
        assertFalse(body.contains("name=\"disc\""))
        assertFalse(body.contains("name=\"face\""))
    }

    @Test
    fun `a barred visitor comes back as blocked, and nothing is sent while something is missing`() {
        assertThrows<IllegalArgumentException> { device.visitors.create(setup, draft(pax = null)) }
        assertEquals(0, server.requestCount - 2)
        server.enqueue(MockResponse().setBody("""{"id":"v2","status":"denied","statusLabel":"Denied","blocked":"This visitor is on the barred list. Do not let them in. Your supervisor has been told."}"""))
        assertEquals("denied", device.visitors.create(setup, draft()).status)
    }

    @Test
    fun `the gate's setup is kept on the phone for when there is no signal`() {
        server.enqueue(MockResponse().setBody("""{"gate":{"id":"g1","name":"Main gate"},"siteName":"Estate ABC","checks":{"paxCount":true},"categories":[{"id":"c1","name":"Once-off visitor","kind":"once_off","contractor":false,"limitMinutes":240}],"units":[{"id":"u14","name":"14"}],"hasClient":false,"today":"2026-10-07"}"""))
        val fresh = device.visitors.setup()
        assertEquals("Main gate", fresh.gate?.name)
        assertTrue(fresh.on("paxCount") && !fresh.on("facePhoto"))
        server.shutdown()
        assertEquals(fresh, device.visitors.setup())
    }

    @Test
    fun `a scan check asks about the tidy number and reads what the site knows`() {
        server.enqueue(MockResponse().setBody("""{"person":{"surname":"Dlamini","names":"T J","lastSeen":"2026-10-01T08:00:00.000Z"},"vehicle":null,"barred":[{"kind":"registration","kindLabel":"Number plate","from":"site"}]}"""))
        val c = device.visitors.check("9001015009086", "CA123456", null)
        assertEquals("Dlamini", c.person?.surname)
        assertEquals(listOf(BarredHit("registration", "Number plate", "site")), c.barred)
        val req = server.takeRequest()
        assertEquals("POST", req.method)
        assertEquals("/api/device/visitors/check", req.path)
    }

    @Test
    fun `the waiting screen reads where a visit stands and which numbers are left to phone`() {
        server.enqueue(MockResponse().setBody("""{"id":"v1","status":"awaiting_approval","statusLabel":"Awaiting approval","visitor":"Dlamini, T J","vehicle":"CA123456 White Toyota Corolla","visiting":"Unit 14","asked":2,"secondsLeft":0,"canDial":true,"dial":{"primary":{"label":"Unit 14","tried":true},"second":{"label":"Unit 14, second contact","tried":false}},"decided":null,"blocked":null}"""))
        val s = device.visitors.state("v1")
        assertTrue(s.waiting && s.canDial && !s.letIn)
        assertFalse(s.dial.allTried)
        assertEquals("Unit 14, second contact", s.dial.second?.label)
        assertEquals("/api/device/visitors/v1", server.takeRequest().path)
        assertTrue(DialOptions().allTried)
        assertTrue(DialOptions(DialOption("Unit 9", true), null).allTried)
    }

    @Test
    fun `the gate dials through the server and records how the call went`() {
        server.enqueue(MockResponse().setBody("""{"number":"082 555 0140","label":"Unit 14"}"""))
        assertEquals(DialReply("082 555 0140", "Unit 14"), device.visitors.dial("v1", "primary"))
        assertEquals("/api/device/visitors/v1/dial", server.takeRequest().path)
        assertThrows<IllegalArgumentException> { device.visitors.callOutcome("v1", "primary", "busy") }
        server.enqueue(MockResponse().setBody("""{"id":"v1","status":"on_site","statusLabel":"On site","decided":"Approved by phone"}"""))
        val done = device.visitors.callOutcome("v1", "primary", "approved")
        assertTrue(done.letIn && !done.waiting)
        val req = server.takeRequest()
        assertEquals("/api/device/visitors/v1/call-outcome", req.path)
        val body = req.body.readUtf8()
        assertTrue(body.contains("\"outcome\":\"approved\"") && body.contains("\"contact\":\"primary\"") && body.contains("eventId"))
        server.enqueue(MockResponse().setBody("""{"id":"v2","status":"denied_no_response","statusLabel":"Denied, no response","decided":"Nobody answered"}"""))
        assertEquals("Nobody answered", device.visitors.noResponse("v2").decided)
        assertEquals("/api/device/visitors/v2/no-response", server.takeRequest().path)
    }

    @Test
    fun `an expected visitor needs no kind of visitor or unit from the guard, and is sent with the pass`() {
        val expected = draft(unitId = null).copy(categoryId = "", passId = "p1", cell = "0835550177")
        assertNull(VisitorRules.problem(setup, expected))
        server.enqueue(MockResponse().setBody("""{"id":"v9","status":"on_site","statusLabel":"On site","blocked":null}"""))
        assertEquals("on_site", device.visitors.create(setup, expected).status)
        val body = server.takeRequest().body.readUtf8()
        assertTrue(body.contains("\"passId\":\"p1\"") && body.contains("\"cell\":\"0835550177\"") && body.contains("\"categoryId\":null") && body.contains("\"unitId\":null"))
    }

    @Test
    fun `a scan check says when the visitor is expected, and the gate reads who is due today`() {
        server.enqueue(MockResponse().setBody("""{"person":null,"vehicle":null,"barred":[],"expected":{"passId":"p1","visitorName":"Sipho Nkosi","visiting":"Unit 14","category":"Once-off visitor","by":"Thabo Tenant","regular":false,"namedGate":"Back gate","mismatch":["number plate"]}}"""))
        val c = device.visitors.check("P1", "GP100200", null, "0835550177")
        assertEquals("Unit 14", c.expected?.visiting)
        assertEquals(listOf("number plate"), c.expected?.mismatch)
        assertTrue(server.takeRequest().body.readUtf8().contains("\"cell\":\"0835550177\""))
        server.enqueue(MockResponse().setBody("""[{"id":"p1","visitorName":"Sipho Nkosi","visiting":"Unit 14","category":"Once-off visitor","when":"About 14:30","gateName":null,"knownBy":"plate GP100200"}]"""))
        assertEquals(listOf(ExpectedRow("p1", "Sipho Nkosi", "Unit 14", "Once-off visitor", "About 14:30", null, "plate GP100200")), device.visitors.expected())
    }

    @Test
    fun `what a visitor gives to be looked up is tried as a cell number, an ID number and a number plate`() {
        assertEquals(LookupKeys("0835550177", "0835550177", "0835550177"), VisitorRules.lookupKeys("083 555 0177"))
        assertEquals(LookupKeys("27835550177", "27835550177", "27835550177"), VisitorRules.lookupKeys("+27 83 555 0177"))
        assertEquals(LookupKeys("GP100200", "GP100200", null), VisitorRules.lookupKeys("gp 100-200"))
        assertEquals(LookupKeys("8001015009087", null, "8001015009087"), VisitorRules.lookupKeys("8001015009087"))
        assertEquals(LookupKeys(null, "CA1", null), VisitorRules.lookupKeys("CA 1"))
        assertFalse(VisitorRules.lookupKeys(" ").any)
    }

    @Test
    fun `a visitor still recorded as on site needs the guard's reason before they are let in again`() {
        server.enqueue(MockResponse().setBody("""{"person":null,"vehicle":null,"barred":[],"expected":null,"onSite":[{"what":"vehicle","visitor":"Dlamini, T J","vehicle":"CA123456 White Toyota Corolla","visiting":"Unit 14","since":"2026-10-07T06:10:00.000Z","gateName":"Main gate"}],"reasons":[{"id":"not_scanned_out","label":"Left earlier without being scanned out"},{"id":"other","label":"Other (type a note)"}]}"""))
        val c = device.visitors.check("9001015009086", "CA123456", null)
        assertEquals("Dlamini, T J", c.onSite.single().visitor)
        assertEquals(listOf("not_scanned_out", "other"), c.reasons.map { it.id })
        server.takeRequest()
        val again = draft().copy(stillOnSite = true)
        assertEquals("Say why this visitor is still recorded as on site.", VisitorRules.problem(setup, again))
        assertEquals("Say why this visitor is still recorded as on site.", VisitorRules.problem(setup, again.copy(onSiteReason = "other", onSiteNote = " ")))
        val ready = again.copy(onSiteReason = "not_scanned_out")
        assertNull(VisitorRules.problem(setup, ready))
        server.enqueue(MockResponse().setBody("""{"id":"v3","status":"awaiting_approval","statusLabel":"Awaiting approval","blocked":null}"""))
        device.visitors.create(setup, ready)
        assertTrue(server.takeRequest().body.readUtf8().contains("\"onSite\":{\"reason\":\"not_scanned_out\",\"note\":\"\"}"))
    }

    @Test
    fun `the exit scan finds the entry record, and the guard answers before the visitor is scanned out`() {
        server.enqueue(MockResponse().setBody("""{"visit":{"id":"v1","type":"vehicle","visitor":"Dlamini, T J","vehicle":"CA123456 White Toyota Corolla","visiting":"Unit 14","category":"Once-off visitor","gateName":"Main gate","enteredAt":"2026-10-07T06:10:00.000Z","paxIn":2,"hasFace":false},"askDriver":true,"askPax":true,"exceptions":[],"reasons":[]}"""))
        val found = device.visitors.exitFind(null, "ca 123-456")
        assertEquals(2, found.visit?.paxIn)
        assertTrue(found.askDriver && found.askPax)
        val find = server.takeRequest()
        assertEquals("/api/device/visitors/exit/find", find.path)
        assertEquals("""{"registration":"CA123456"}""", find.body.readUtf8())
        val d = ExitDraft("22222222-2222-4222-8222-222222222222", "v1", null, "ca 123-456", null, null)
        assertEquals("Say whether this is the same driver who came in.", VisitorRules.exitProblem(found, d))
        assertEquals("Enter the number of passengers leaving (0 if the driver is alone).", VisitorRules.exitProblem(found, d.copy(sameDriver = true)))
        val ready = d.copy(sameDriver = true, paxOut = 2)
        assertNull(VisitorRules.exitProblem(found, ready))
        server.enqueue(MockResponse().setBody("""{"status":"exited","message":"Scanned out. The visit is closed."}"""))
        val done = device.visitors.exit(ready)
        assertTrue(done.gone)
        val req = server.takeRequest()
        assertEquals("/api/device/visitors/exit", req.path)
        val body = req.body.readUtf8()
        assertTrue(body.contains("\"visitId\":\"v1\"") && body.contains("\"registration\":\"CA123456\"") && body.contains("\"sameDriver\":true") && body.contains("\"paxOut\":2"))
        assertFalse(body.contains("handling"))
    }

    @Test
    fun `an exit exception needs a reason or a note and the guard's decision, with an optional photo`() {
        server.enqueue(MockResponse().setBody("""{"visit":null,"askDriver":false,"askPax":false,"exceptions":[{"type":"no_open_visit","label":"Not recorded as on site","text":"Nobody with this ID or number plate is recorded as on site."}],"reasons":[{"id":"not_scanned_in","label":"Was not scanned in"}]}"""))
        val found = device.visitors.exitFind("X99999999", null, sameDriver = false, paxOut = 1)
        assertEquals("no_open_visit", found.exceptions.single().type)
        val sent = server.takeRequest().body.readUtf8()
        assertTrue(sent.contains("\"sameDriver\":false") && sent.contains("\"paxOut\":1"))
        assertEquals("Choose a reason or type a note before you continue.", VisitorRules.handlingProblem(null, ""))
        assertEquals("Type a note to say what happened.", VisitorRules.handlingProblem("other", " "))
        assertNull(VisitorRules.handlingProblem("not_scanned_in", ""))
        assertNull(VisitorRules.handlingProblem(null, "Says he came in on foot."))
        val d = ExitDraft("33333333-3333-4333-8333-333333333333", null, "X99999999", null, null, null, allowed = true)
        assertThrows<IllegalArgumentException> { device.visitors.exit(d) }
        server.enqueue(MockResponse().setBody("""{"status":"logged","message":"Exception recorded. Your supervisor has been told."}"""))
        val done = device.visitors.exit(d.copy(reason = "not_scanned_in", photo = photo("exception.jpg")))
        assertFalse(done.gone)
        val body = server.takeRequest().body.readUtf8()
        assertTrue(body.contains("\"handling\":{\"reason\":\"not_scanned_in\",\"note\":\"\",\"allowed\":true}") && body.contains("name=\"photo\""))
        server.enqueue(MockResponse().setBody("jpeg-bytes"))
        assertEquals("jpeg-bytes", String(device.visitors.face("v1")))
        assertEquals("/api/device/visitors/v1/face", server.takeRequest().path)
    }

    @Test
    fun `the gate reads who is on site, with overstays and what was done about them`() {
        server.enqueue(MockResponse().setBody("""{"onSite":2,"overstays":1,"visitors":[{"id":"v1","type":"vehicle","visitor":"Dlamini, T J","vehicle":"CA123456 White Toyota Corolla","pax":1,"visiting":"Unit 14","unitId":"u14","category":"Once-off visitor","gateName":"Main gate","enteredAt":"2026-10-07T06:10:00.000Z","stay":"5 h 02 min","dueAt":"2026-10-07T10:10:00.000Z","overdue":true,"overBy":"1 h 02 min","action":{"action":"dialled","label":"Dialled the customer","note":"","at":"2026-10-07T11:00:00.000Z","by":"John Smith","handoverId":null},"needsAction":true},{"id":"v2","type":"pedestrian","visitor":"Nkosi, S","vehicle":null,"pax":null,"visiting":"The office","category":"Regular visitor","gateName":"Main gate","enteredAt":"2026-10-07T09:00:00.000Z","stay":"2 h 12 min","dueAt":null,"overdue":false,"overBy":null,"action":null,"needsAction":false}]}"""))
        val list = device.visitors.onSite()
        assertEquals("/api/device/visitors/on-site", server.takeRequest().path)
        assertEquals(2, list.onSite)
        assertTrue(list.visitors[0].overdue && list.visitors[0].needsAction)
        assertEquals("dialled", list.visitors[0].action?.action)
        assertNull(list.visitors[1].vehicle)
    }

    @Test
    fun `an overstay is phoned about, confirmed with a note, or marked as left with a note`() {
        server.enqueue(MockResponse().setBody("""{"ok":true,"number":"082 555 0140","label":"Unit 14"}"""))
        assertEquals(DialReply("082 555 0140", "Unit 14"), device.visitors.overstay("v1", "dialled", "", "h1"))
        val dial = server.takeRequest()
        assertEquals("/api/device/visitors/v1/overstay", dial.path)
        val sent = dial.body.readUtf8()
        assertTrue(sent.contains("\"action\":\"dialled\"") && sent.contains("\"handoverId\":\"h1\"") && sent.contains("eventId"))
        assertThrows<IllegalArgumentException> { device.visitors.overstay("v1", "confirmed", " ", null) }
        assertThrows<IllegalArgumentException> { device.visitors.overstay("v1", "ignored", "A note.", null) }
        server.enqueue(MockResponse().setBody("""{"ok":true}"""))
        assertNull(device.visitors.overstay("v1", "left", "Tenant says she left at lunch.", null))
        assertTrue(server.takeRequest().body.readUtf8().contains("\"handoverId\":null"))
    }

    @Test
    fun `the outgoing guard hands over, and the incoming guard is given it to acknowledge`() {
        server.enqueue(MockResponse().setBody("""{"id":"h1","onSite":3,"overstays":1,"todo":1,"canSignOff":false,"visitors":[{"id":"v1","visitor":"Dlamini, T J","overdue":true,"overBy":"1 h 02 min","todo":true,"handoverAction":null}]}"""))
        val h = device.visitors.handoverStart()
        assertEquals("/api/device/visitors/handover/start", server.takeRequest().path)
        assertFalse(h.canSignOff)
        assertTrue(h.visitors.single().todo)
        server.enqueue(MockResponse().setBody("""{"ok":true,"id":"h1"}"""))
        device.visitors.handoverSignOff("h1")
        assertEquals("/api/device/visitors/handover/h1/sign-off", server.takeRequest().path)
        server.enqueue(MockResponse().setBody("""{"gate":{"id":"g1","name":"Main gate"},"counts":{"onSite":3,"overstays":1,"needAction":0},"handover":{"id":"h1","signedOffAt":"2026-10-07T16:02:00.000Z","onSite":3,"overstays":1,"unresolved":0,"from":"John Smith","notes":[{"visitor":"Dlamini, T J","vehicle":"CA123456","visiting":"Unit 14","overBy":"1 h 02 min","action":"Confirmed still on site","note":"Tenant confirmed."}]}}"""))
        val setup = device.visitors.setup()
        server.takeRequest()
        assertEquals(GateCounts(3, 1, 0), setup.counts)
        assertEquals("John Smith", setup.handover?.from)
        assertEquals("Tenant confirmed.", setup.handover?.notes?.single()?.note)
        server.enqueue(MockResponse().setBody("""{"ok":true}"""))
        device.visitors.handoverAcknowledge("h1")
        assertEquals("/api/device/visitors/handover/h1/acknowledge", server.takeRequest().path)
    }

    @Test
    fun `a registered contractor comes with the workers approved, and more than that means the customer is asked`() {
        server.enqueue(MockResponse().setBody("""{"person":null,"vehicle":null,"barred":[],"expected":{"passId":"p7","visitorName":"Fix It Plumbing","visiting":"Unit 14","category":"Contractor","by":"Thabo Tenant","regular":true,"namedGate":null,"mismatch":[],"contractor":true,"maxWorkers":2,"leaveBy":"18:00"}}"""))
        val e = device.visitors.check(null, "ND700", null).expected!!
        server.takeRequest()
        assertTrue(e.contractor)
        assertEquals("18:00", e.leaveBy)
        assertFalse(e.extraWorkers(2))
        assertTrue(e.extraWorkers(3))
        assertFalse(e.extraWorkers(null))
        assertFalse(ExpectedMatch("p1").extraWorkers(9))
    }

    @Test
    fun `staff are found by the last six digits of their cell number`() {
        assertThrows<IllegalArgumentException> { device.visitors.staffFind("0147") }
        server.enqueue(MockResponse().setBody("""{"staff":[{"id":"s1","fullName":"Grace Mokoena","visiting":"Unit 14","when":"Mon, Wed, Fri, 07:00 to 16:00","enrolled":false,"onSite":false,"dueNow":true,"notDue":null},{"id":"s2","fullName":"Sam Gardener","visiting":"Unit 20","when":"Every day, any time","enrolled":true,"onSite":false,"dueNow":false,"notDue":"They are not due at work at this time."}]}"""))
        val found = device.visitors.staffFind("55 0147")
        val req = server.takeRequest()
        assertEquals("/api/device/staff/find", req.path)
        assertEquals("""{"code":"550147"}""", req.body.readUtf8())
        assertEquals(listOf("Grace Mokoena", "Sam Gardener"), found.map { it.fullName })
        assertEquals("Mon, Wed, Fri, 07:00 to 16:00", found[0].days)
        assertFalse(found[0].enrolled)
        assertFalse(found[1].dueNow)
    }

    @Test
    fun `a staff member's first day takes their ID and the reference photo`() {
        val enrol = StaffEnrol("850101 5009 087", "Mokoena", "Grace", "id_card", "scan")
        val d = StaffEntryDraft("44444444-4444-4444-8444-444444444444", "s1", enrol, true, null)
        assertThrows<IllegalArgumentException> { device.visitors.staffEnter(d) }
        assertThrows<IllegalArgumentException> { device.visitors.staffEnter(d.copy(face = photo("face.jpg"), enrol = enrol.copy(method = "manual"))) }
        server.enqueue(MockResponse().setBody("""{"status":"on_site","visitId":"v1","message":"Registered. Let them in."}"""))
        assertEquals("Registered. Let them in.", device.visitors.staffEnter(d.copy(face = photo("face.jpg"))).message)
        val req = server.takeRequest()
        assertEquals("/api/device/staff/s1/enter", req.path)
        val body = req.body.readUtf8()
        assertTrue(body.contains("\"idNumber\":\"8501015009087\"") && body.contains("\"handling\":null") && body.contains("name=\"face\""))
    }

    @Test
    fun `on later days the snapshot is compared, and a doubt needs a note and the guard's decision`() {
        server.enqueue(MockResponse().setBody("""{"result":"no_match","text":"This may be a different person. Look carefully."}"""))
        val c = device.visitors.staffCompare("s1", photo("face.jpg"))
        assertEquals("/api/device/staff/s1/compare", server.takeRequest().path)
        assertTrue(c.doubtful)
        assertFalse(StaffCompare("match").doubtful)
        assertFalse(StaffCompare().doubtful)
        val d = StaffEntryDraft("55555555-5555-4555-8555-555555555555", "s1", null, false, photo("face.jpg"), allowed = false)
        assertThrows<IllegalArgumentException> { device.visitors.staffEnter(d) }
        server.enqueue(MockResponse().setBody("""{"status":"refused","visitId":null,"message":"Not let in. Your supervisor and the customer have been told."}"""))
        assertEquals("refused", device.visitors.staffEnter(d.copy(note = "A different woman.")).status)
        val body = server.takeRequest().body.readUtf8()
        assertTrue(body.contains("\"samePerson\":false") && body.contains("\"handling\":{\"note\":\"A different woman.\",\"allowed\":false}") && body.contains("\"enrol\":null"))
        server.enqueue(MockResponse().setBody("""{"status":"exited","message":"Scanned out."}"""))
        assertEquals("exited", device.visitors.staffLeave("s1").status)
        assertEquals("/api/device/staff/s1/leave", server.takeRequest().path)
    }
}
