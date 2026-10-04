package za.onpar.core

import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File

/** TSF number and ID card sign-in (owner, 4 Oct 2026). */
class TsfNumberTest {
    @TempDir lateinit var dir: File

    @Test
    fun `reads an ID card and refuses other QR codes`() {
        assertEquals("BCD123GP", TsfNumber.fromIdCard("ONPAR-ID:BCD123GP"))
        assertEquals("BCD123KZN", TsfNumber.fromIdCard(" onpar-id:bcd123kzn "))
        assertNull(TsfNumber.fromIdCard("BCD123GP"))
        assertNull(TsfNumber.fromIdCard("ONPAR-ID:ABC123GP")) // vowels are never used
        assertNull(TsfNumber.fromIdCard("https://example.com/p/abc"))
    }

    @Test
    fun `recognises the new badge link from any address, but not a checkpoint`() {
        assertTrue(TsfNumber.isIdCard("https://13-247-19-106.sslip.io/b/Xq3_aB-9kLmNoPqRsTuVwXyZ"))
        assertTrue(TsfNumber.isIdCard("https://onpar.co.za/b/Xq3_aB-9kLmNoPqRsTuVwXyZ"))
        assertTrue(TsfNumber.isIdCard("ONPAR-ID:BCD123GP"))
        assertTrue(!TsfNumber.isIdCard("https://onpar.co.za/p/Xq3_aB-9kLmNoPqRsTuVwXyZ"))
        assertTrue(!TsfNumber.isIdCard("hello"))
    }

    @Test
    fun `accepts typing with spaces and small letters, and shows plate spacing`() {
        assertEquals("BCD123GP", TsfNumber.normalise("bcd 123-gp"))
        assertNull(TsfNumber.normalise("BCD 000 GP"))
        assertNull(TsfNumber.normalise("1001"))
        assertEquals("BCD 123 GP", TsfNumber.format("BCD123GP"))
        assertEquals(Triple("BCD", "123", "KZN"), TsfNumber.parts("BCD123KZN"))
    }

    @Test
    fun `the scanned card is sent as the TSF number, and one session is kept per guard`() {
        val server = MockWebServer()
        server.start()
        try {
            val device = OnParDevice(dir)
            server.enqueue(MockResponse().setBody("{}"))
            device.applySetup(DeviceSetup(server.url("/").toString().trimEnd('/'), "device-token-123456789012345"))
            server.takeRequest()
            // Signed in earlier by employee number (older app), then locked.
            server.enqueue(MockResponse().setBody("""{"token":"t1","employee":{"id":"e1","name":"Sipho"}}"""))
            device.signIn("1001", "1234")
            server.takeRequest()
            device.lock()
            // Now with the ID card: the server says who it is, and the old session is replaced.
            server.enqueue(MockResponse().setBody("""{"token":"t2","employee":{"id":"e1","name":"Sipho","employeeNumber":"1001","tsfNumber":"BCD123GP"}}"""))
            device.signIn("ONPAR-ID:BCD123GP", "1234")
            val body = server.takeRequest().body.readUtf8()
            assertTrue(body.contains("\"login\":\"BCD123GP\""), body)
            assertEquals("t2", device.guardToken)
            assertTrue(device.lockedGuards().isEmpty())
            device.lock()
            device.unlock("BCD123GP", "1234")
            assertEquals("t2", device.guardToken)
            // The new badge: the link is sent as it is, and the same guard keeps one session.
            server.enqueue(MockResponse().setBody("""{"token":"t3","employee":{"id":"e1","name":"Sipho","employeeNumber":"1001","tsfNumber":"BCD123GP"}}"""))
            device.signIn("https://onpar.co.za/b/Xq3_aB-9kLmNoPqRsTuVwXyZ", "1234")
            assertTrue(server.takeRequest().body.readUtf8().contains("\"login\":\"https://onpar.co.za/b/Xq3_aB-9kLmNoPqRsTuVwXyZ\""))
            assertEquals("t3", device.guardToken)
            assertTrue(device.lockedGuards().isEmpty())
        } finally {
            runCatching { server.shutdown() }
        }
    }
}
