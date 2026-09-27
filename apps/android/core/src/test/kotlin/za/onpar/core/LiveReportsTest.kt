package za.onpar.core

import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.io.File
import java.time.LocalDate
import java.time.ZoneId

/** Reports and re-orders against a running server (scenarios 1, 8 and 12). */
class LiveReportsTest {
    @Test
    fun `a damaged gate is reported, followed up, inspected on the phone, and a shirt is re-ordered and received`() {
        assumeTrue(LiveFixture.url.isNotEmpty(), "ONPAR_API_URL not set")
        val f = LiveFixture(LiveFixture.url)
        val m = f.managerToken
        val dir = java.nio.file.Files.createTempDirectory("onpar-reports").toFile()
        val device = OnParDevice(dir)
        device.applySetup(f.setup)
        device.signIn(f.employeeNumber, f.pin)
        assertTrue(device.duty(DutyKind.ON, f.pin).second is Submitted.Sent)

        // Scenario 1: the guard reports the damaged gate with a photo.
        val photo = File(dir, "gate.jpg").apply { writeBytes(LiveFixture.JPEG) }
        assertTrue(device.reports.create("maintenance", "amber", "Gate 2 motor is damaged", photo) is Submitted.Sent)
        val mine = device.reports.list().first { it.mine && it.description == "Gate 2 motor is damaged" }
        assertEquals("reported", mine.stage)
        assertNotNull(mine.colour)
        assertTrue(mine.hasPhoto)
        assertThrows<IllegalArgumentException> { device.reports.followUp(mine, "in_progress", "", null) }

        // The supervisor assigns a plumber; the guard follows up.
        val person = f.call("POST", "/people", m, buildJsonObject { put("name", "Sipho Plumbing"); put("role", "Plumber"); put("phone", "082 555 0111"); put("kind", "contractor") })["id"]!!.jsonPrimitive.content
        f.call("POST", "/reports/${mine.id}/assign", m, buildJsonObject { put("assigneePersonId", person); put("note", "Plumber booked") })
        val assigned = device.reports.list().first { it.id == mine.id }
        assertEquals("Sipho Plumbing", assigned.assigneeName)
        assertTrue(device.reports.followUp(assigned, "in_progress", "Plumber arrived", null) is Submitted.Sent)

        // Scenario 8: the work is done and attended; the officer is sent the inspection task and records it on the phone.
        f.call("POST", "/reports/${mine.id}/actioned", m, buildJsonObject { put("note", "Motor replaced") })
        f.call("POST", "/reports/${mine.id}/attendance_checked", m, buildJsonObject { put("note", "Plumber signed in") })
        val inspection = device.tasks.today().firstOrNull { it.reportId == mine.id }
        assertNotNull(inspection, "the inspection task reaches the phone")
        val toInspect = device.reports.list().first { it.id == mine.id }
        assertTrue(toInspect.awaitingInspection)
        assertTrue(device.reports.followUp(toInspect, "done_ok", "Gate opens and closes", null) is Submitted.Sent)
        assertEquals("job_inspected", device.reports.list().first { it.id == mine.id }.stage)

        // Scenario 12: a personal shirt re-order takes the size from the profile, and receipt updates the issue date.
        val shirt = device.reorders.kit().first { it.item == "Shirt" }
        assertEquals("L", shirt.size)
        assertTrue(device.reorders.personal(shirt, "Torn on the fence") is Submitted.Sent)
        val order = device.reorders.list().first { it.mine && it.item == "Shirt" && it.stage == "requested" }
        assertEquals("L", order.size)
        assertThrows<IllegalArgumentException> { device.reorders.received(order, "") }
        f.call("POST", "/reorders/${order.id}/ordered", m, buildJsonObject { put("note", "Ordered from supplier") })
        val onItsWay = device.reorders.list().first { it.id == order.id }
        assertTrue(onItsWay.canConfirm)
        assertTrue(device.reorders.received(onItsWay, "Fits") is Submitted.Sent)
        assertEquals("received", device.reorders.list().first { it.id == order.id }.stage)
        assertEquals(LocalDate.now(ZoneId.of("Africa/Johannesburg")).toString(), device.reorders.kit().first { it.item == "Shirt" }.issueDate)

        assertTrue(device.reorders.site("Toilet paper", "2 packs", "") is Submitted.Sent)
        assertTrue(device.reorders.list().any { it.kind == "site" && it.item == "Toilet paper" })
    }
}
