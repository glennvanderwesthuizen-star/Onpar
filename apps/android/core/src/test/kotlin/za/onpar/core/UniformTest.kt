package za.onpar.core

import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
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

/** Uniform on the phone (D-33). */
class UniformTest {
    @TempDir lateinit var dir: File
    private lateinit var server: MockWebServer
    private lateinit var device: OnParDevice
    private val shirt = UniformKitItem("i-shirt", "Shirt (Short sleeve)", listOf("S", "M", "L"), entitled = 3, lastIssued = "2025-09-01", lastSize = "L", nextDue = "2026-09-01", due = true)
    private val boots = UniformKitItem("i-boots", "Boots", listOf("8", "9"), entitled = 1, lastIssued = "2026-09-01", lastSize = "9", nextDue = "2027-09-01", due = false)

    @BeforeEach fun start() {
        server = MockWebServer()
        server.start()
        device = OnParDevice(dir)
        server.enqueue(MockResponse().setBody("{}"))
        device.applySetup(DeviceSetup(server.url("/").toString().trimEnd('/'), "device-token-123456789012345"))
        server.takeRequest()
        server.enqueue(MockResponse().setBody("""{"token":"t","employee":{"id":"e","name":"Michael"}}"""))
        device.signIn("1001", "1234")
        server.takeRequest()
    }

    @AfterEach fun stop() = runCatching { server.shutdown() }.let { }

    @Test
    fun `several ticked items go as one order, with sizes and reasons`() {
        server.enqueue(MockResponse().setBody("""{"id":"o1","number":7}"""))
        val r = device.uniform.order(listOf(UniformChoice(shirt, "L", 3), UniformChoice(boots, "9", 1, "Sole came off")))
        assertTrue(r is Submitted.Sent)
        val body = OnParJson.parseToJsonElement(server.takeRequest().body.readUtf8()).jsonObject
        val lines = body["lines"]!!.jsonArray
        assertEquals(2, lines.size)
        assertEquals("Sole came off", lines[1].jsonObject["reason"]!!.jsonPrimitive.content)
    }

    @Test
    fun `checks on the phone before sending`() {
        assertThrows<IllegalArgumentException> { device.uniform.order(emptyList()) }
        assertTrue(assertThrows<IllegalArgumentException> { device.uniform.order(listOf(UniformChoice(boots, "9", 1))) }.message!!.contains("not due until 2027-09-01"))
        assertThrows<IllegalArgumentException> { device.uniform.order(listOf(UniformChoice(shirt, "XXL", 1))) }
        assertThrows<IllegalArgumentException> { device.uniform.order(listOf(UniformChoice(shirt, "L", 4))) }
    }

    @Test
    fun `signing for guard-account items needs his agreement to the amount`() {
        val o = UniformOrder("o1", 7, "with_supervisor", "With the supervisor", guardCents = 65000, canReceive = true, agreeStatement = "I agree to pay R650.00")
        assertThrows<IllegalArgumentException> { device.uniform.receive(o, "1234", agreeToPay = false) }
        server.enqueue(MockResponse().setBody("""{"ok":true}"""))
        device.uniform.receive(o, "1234", agreeToPay = true)
        val req = server.takeRequest()
        assertEquals("/api/device/uniform/orders/o1/receive", req.path)
        assertTrue(req.body.readUtf8().contains("\"agreeToPay\":true"))
    }

    @Test
    fun `writes Rand amounts the South African way`() {
        assertEquals("R1 234.50", formatRand(123450))
        assertEquals("R0.05", formatRand(5))
        assertEquals("R650.00", formatRand(65000))
    }
}
