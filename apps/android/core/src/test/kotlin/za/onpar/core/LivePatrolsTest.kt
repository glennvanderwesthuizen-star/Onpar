package za.onpar.core

import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.io.File
import kotlin.random.Random

/** Patrols against a running server: set up on the website, walked on the phone (scenarios 4, 5 and 7). */
class LivePatrolsTest {
    @Test
    fun `a patrol with a GPS lock, any order, checks and an automatic report`() {
        assumeTrue(LiveFixture.url.isNotEmpty(), "ONPAR_API_URL not set")
        val f = LiveFixture(LiveFixture.url)
        val m = f.managerToken
        val code = "T" + Random.nextInt(100, 999)
        val typeId = f.call("POST", "/patrols/types", m, buildJsonObject { put("siteId", f.siteId); put("code", code); put("name", "Phone test patrol $code") })["id"]!!.jsonPrimitive.content
        val setup = f.call("GET", "/patrols/setup?siteId=${f.siteId}", m)
        for (s in setup["shifts"]!!.jsonArray) {
            f.call("PUT", "/patrols/types/$typeId/rules", m, buildJsonObject { put("shiftId", s.jsonObject["id"]!!.jsonPrimitive.content); put("perShift", 1); put("minGapMinutes", 0); put("maxDurationMinutes", 60) })
        }
        f.call("POST", "/patrols/points", m, buildJsonObject { put("patrolTypeId", typeId); put("name", "Front gate"); put("lat", -26.1); put("lng", 28.05) })
        f.call(
            "POST", "/patrols/points", m,
            buildJsonObject {
                put("patrolTypeId", typeId); put("name", "Generator room"); put("lat", -26.1002); put("lng", 28.05)
                put("instruction", "Check the fuel level"); put("photoMode", "required")
                put("checks", buildJsonArray {
                    add(buildJsonObject { put("id", "fuel"); put("kind", "number"); put("label", "Fuel"); put("unit", "litres"); put("below", 50) })
                    add(buildJsonObject { put("id", "door"); put("kind", "ok_problem"); put("label", "Door") })
                })
            },
        )
        val points = f.call("GET", "/patrols/setup?siteId=${f.siteId}", m)["points"]!!.jsonArray.map { it.jsonObject }.filter { it["patrolTypeId"]?.jsonPrimitive?.content == typeId }
        val qr = points.associate { it["name"]!!.jsonPrimitive.content to it["qrCode"]!!.jsonPrimitive.content }

        val dir = java.nio.file.Files.createTempDirectory("onpar-patrols").toFile()
        val device = OnParDevice(dir)
        device.applySetup(f.setup)
        device.signIn(f.employeeNumber, f.pin)
        assertTrue(device.duty(DutyKind.ON, f.pin).second is Submitted.Sent)

        val state = device.patrols.state()
        assertTrue(state.onDuty)
        val type = state.types.single { it.id == typeId }
        assertTrue(type.canStart, type.reason ?: "")
        assertEquals("Generator room", device.patrols.pointFor(qr["Generator room"]!!)!!.second.name)

        // Scenario 4: poor GPS and a scan 480 m away are rejected (and logged on the server).
        assertEquals("Rejected: GPS not accurate enough", device.patrols.scan(qr["Front gate"]!!, Fix(-26.1, 28.05, 60.0)).message)
        assertEquals(false, device.patrols.scan(qr["Front gate"]!!, Fix(-26.1043, 28.05, 8.0)).accepted)
        assertNull(device.patrols.active())

        // Scenario 5: any order. The generator room first starts the patrol and its clock.
        val gen = device.patrols.scan(qr["Generator room"]!!, Fix(-26.1002, 28.05, 6.0))
        assertEquals(true, gen.accepted, gen.message)
        val active = device.patrols.active()!!
        assertTrue(active.deadline().isAfter(java.time.Instant.now().plusSeconds(58 * 60)))

        // Scenario 7: the photo is required; fuel of 30 litres against 50 raises an Amber report.
        val photo = File(dir, "gen.jpg").apply { writeBytes(LiveFixture.JPEG) }
        assertThrows<IllegalArgumentException> { device.patrols.saveChecks(active.id, gen.point!!, "", null, mapOf("fuel" to 30.0), mapOf("door" to true), emptyMap()) }
        assertTrue(device.patrols.saveChecks(active.id, gen.point!!, "Low on fuel", photo, mapOf("fuel" to 30.0), mapOf("door" to true), emptyMap()) is Submitted.Sent)

        val gate = device.patrols.scan(qr["Front gate"]!!, Fix(-26.1, 28.05, 5.0))
        assertEquals(true, gate.accepted, gate.message)
        assertNull(device.patrols.active(), "the patrol is complete")

        val reports = f.call("GET", "/reports", m)["rows"]!!.jsonArray.map { it.jsonObject }
        val raised = reports.firstOrNull { it["source"]?.jsonPrimitive?.content == "patrol" && (it["description"] as? JsonPrimitive)?.content?.contains("Fuel") == true }
        assertTrue(raised != null, "an automatic report from the fuel reading")
        assertEquals("amber", raised!!["priority"]!!.jsonPrimitive.content)
        val done = device.patrols.state().types.single { it.id == typeId }.done
        assertEquals(1, done)
    }
}
