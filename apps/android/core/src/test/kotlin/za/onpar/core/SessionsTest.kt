package za.onpar.core

import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import org.junit.jupiter.api.io.TempDir
import java.io.File

/** Several guards on one post phone; Lock and Unlock (D-33). */
class SessionsTest {
    @TempDir lateinit var dir: File
    private lateinit var server: MockWebServer
    private lateinit var device: OnParDevice

    @BeforeEach fun start() {
        server = MockWebServer()
        server.start()
        device = OnParDevice(dir)
        server.enqueue(MockResponse().setBody("{}"))
        device.applySetup(DeviceSetup(server.url("/").toString().trimEnd('/'), "device-token-123456789012345"))
        server.takeRequest()
    }

    @AfterEach fun stop() = runCatching { server.shutdown() }.let { }

    private fun login(number: String, name: String, token: String) {
        server.enqueue(MockResponse().setBody("""{"token":"$token","employee":{"id":"e-$number","name":"$name"}}"""))
        device.signIn(number, "1234")
        server.takeRequest()
    }

    @Test
    fun `lock keeps the guard signed in, only his PIN unlocks him, without signal`() {
        login("1001", "Sipho", "t-sipho")
        device.lock()
        assertNull(device.guardToken)
        assertEquals(listOf("Sipho"), device.lockedGuards().map { it.name })
        server.shutdown() // no signal
        assertThrows<IllegalArgumentException> { device.unlock("1001", "9999") }
        device.unlock("1001", "1234")
        assertEquals("t-sipho", device.guardToken)
        assertEquals("Sipho", device.guardName)
        assertTrue(device.lockedGuards().isEmpty())
    }

    @Test
    fun `a second guard can sign in while the first is locked, and each keeps his own sign-in`() {
        login("1001", "Sipho", "t-sipho")
        device.lock()
        login("2002", "Lindiwe", "t-lindiwe")
        assertEquals("t-lindiwe", device.guardToken)
        assertEquals(listOf("Sipho"), device.lockedGuards().map { it.name })
        device.lock()
        device.unlock("1001", "1234")
        assertEquals("t-sipho", device.guardToken)
        assertEquals(listOf("Lindiwe"), device.lockedGuards().map { it.name })
    }

    @Test
    fun `five wrong PINs and he must sign in again with signal`() {
        login("1001", "Sipho", "t-sipho")
        device.lock()
        repeat(4) { assertThrows<IllegalArgumentException> { device.unlock("1001", "0000") } }
        val last = assertThrows<IllegalArgumentException> { device.unlock("1001", "0000") }
        assertTrue(last.message!!.startsWith("Too many wrong PINs"))
        // Now the right PIN goes to the server.
        server.enqueue(MockResponse().setBody("""{"token":"t-new","employee":{"id":"e-1001","name":"Sipho"}}"""))
        device.unlock("1001", "1234")
        assertEquals("/api/device/login", server.takeRequest().path)
        assertEquals("t-new", device.guardToken)
    }

    @Test
    fun `sign out removes only the active guard, forget removes a locked one`() {
        login("1001", "Sipho", "t-sipho")
        device.lock()
        login("2002", "Lindiwe", "t-lindiwe")
        device.signOut()
        assertNull(device.guardToken)
        assertEquals(listOf("Sipho"), device.lockedGuards().map { it.name })
        device.forget("1001")
        assertTrue(device.lockedGuards().isEmpty())
    }

    @Test
    fun `the PIN is never kept as written`() {
        login("1001", "Sipho", "t-sipho")
        val settings = File(dir, "settings.json").readText()
        assertTrue(!settings.contains("\"1234\""))
    }

    @Test
    fun `the sign-in screen lists the guards due on duty now`() {
        server.enqueue(MockResponse().setBody("""[{"login":"BCD123GP","name":"Michael Themba","shift":"Night shift 18:00 to 06:00","startsAt":"2026-10-07T16:00:00.000Z"},{"login":"0002","name":"Abram Komapi","shift":"Night shift 18:00 to 06:00"}]"""))
        val due = device.expectedGuards()
        val req = server.takeRequest()
        assertEquals("/api/device/expected-guards", req.path)
        assertNull(req.getHeader("Authorization")) // before anyone has signed in
        assertEquals(listOf("Michael Themba", "Abram Komapi"), due.map { it.name })
        assertEquals("BCD123GP", due[0].login)
    }

    @Test
    fun `when a second guard comes on duty the phone goes back to the guard who was holding it`() {
        login("1001", "Michael", "t-michael")
        device.makeWayForAnotherGuard()
        assertNull(device.guardToken)
        assertEquals("Michael", device.returnTo?.name)
        login("2002", "Abram", "t-abram")
        assertEquals("t-abram", device.guardToken)
        // Abram's Duty On is done: no PIN is needed for the phone to return to Michael.
        assertTrue(device.handBack())
        assertEquals("t-michael", device.guardToken)
        assertEquals(listOf("Abram"), device.lockedGuards().map { it.name })
        assertNull(device.returnTo)
        assertTrue(!device.handBack()) // nothing more to hand back
        // Abram takes the phone to go on patrol: that needs his PIN.
        assertThrows<IllegalArgumentException> { device.unlock("2002", "0000") }
        device.unlock("2002", "1234")
        assertEquals("t-abram", device.guardToken)
    }

    @Test
    fun `a newcomer who is locked to this position keeps the phone, and a newcomer who gives up hands it back`() {
        login("1001", "Michael", "t-michael")
        device.makeWayForAnotherGuard()
        login("2002", "Abram", "t-abram")
        assertTrue(!device.handBack(stay = true))
        assertEquals("t-abram", device.guardToken)
        assertEquals(listOf("Michael"), device.lockedGuards().map { it.name })
        // The other way round: Abram makes way, nobody signs in, and the phone returns to him.
        device.makeWayForAnotherGuard()
        assertNull(device.guardToken)
        assertTrue(device.handBack())
        assertEquals("t-abram", device.guardToken)
    }
}
