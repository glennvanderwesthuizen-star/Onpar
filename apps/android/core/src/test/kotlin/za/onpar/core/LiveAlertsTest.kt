package za.onpar.core

import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.Test
import java.io.File

/** Panic and BOLO against a running server. */
class LiveAlertsTest {
    @Test
    fun `a panic and a BOLO reach the website, with and without a guard signed in`() {
        assumeTrue(LiveFixture.url.isNotEmpty(), "ONPAR_API_URL not set")
        val f = LiveFixture(LiveFixture.url)
        val dir = java.nio.file.Files.createTempDirectory("onpar-alerts").toFile()
        val device = OnParDevice(dir)
        device.applySetup(f.setup)

        assertTrue(device.alerts.panic(Fix(-26.1076, 28.0567, 9.0), callStarted = true) is Submitted.Sent)
        device.signIn(f.employeeNumber, f.pin)
        assertTrue(device.alerts.panic(null, callStarted = false) is Submitted.Sent)

        val open = f.call("GET", "/panic", f.managerToken)["list"]!!.jsonArray.map { it.jsonObject }.filter { it["siteId"]?.jsonPrimitive?.content == f.siteId }
        assertTrue(open.any { it["lat"]?.jsonPrimitive?.content?.toDoubleOrNull() == -26.1076 && it["employeeName"] is JsonNull })
        assertTrue(open.any { it["employeeNumber"]?.jsonPrimitive?.content == f.employeeNumber })

        val photo = File(dir, "car.jpg").apply { writeBytes(LiveFixture.JPEG) }
        assertTrue(device.alerts.bolo("White Toyota Hilux circling the block", photo) is Submitted.Sent)
        val bolos = f.call("GET", "/bolos", f.managerToken)["list"]!!.jsonArray.map { it.jsonObject }
        val mine = bolos.first { it["note"]!!.jsonPrimitive.content == "White Toyota Hilux circling the block" && it["employeeNumber"]?.jsonPrimitive?.content == f.employeeNumber }
        assertEquals("true", mine["hasPhoto"]!!.jsonPrimitive.content)
    }
}
