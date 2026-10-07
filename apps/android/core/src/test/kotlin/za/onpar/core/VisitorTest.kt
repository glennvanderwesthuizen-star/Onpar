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
}
