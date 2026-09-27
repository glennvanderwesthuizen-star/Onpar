package za.onpar.core

import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.Test
import java.io.File
import java.time.LocalDate
import java.time.ZoneId

/** Tasks against a running server: a supervisor assigns them on the website, the guard does them on the phone. */
class LiveTasksTest {
    @Test
    fun `the guard sees the post's tasks, completes one with a photo and reports another could not be done`() {
        assumeTrue(LiveFixture.url.isNotEmpty(), "ONPAR_API_URL not set")
        val f = LiveFixture(LiveFixture.url)
        val today = LocalDate.now(ZoneId.of("Africa/Johannesburg")).toString()
        fun task(title: String, photo: Boolean) = f.call(
            "POST", "/tasks", f.managerToken,
            buildJsonObject {
                put("title", title); put("siteId", f.siteId); put("assigneeType", "post"); put("assigneeDeviceId", f.deviceId)
                put("recurrence", "once"); put("startDate", today); put("photoRequired", photo)
            },
        )
        task("Generator check", true)
        task("Check fire extinguishers", false)

        val dir = java.nio.file.Files.createTempDirectory("onpar-tasks").toFile()
        val device = OnParDevice(dir)
        device.applySetup(f.setup)
        device.signIn(f.employeeNumber, f.pin)
        val tasks = device.tasks.today()
        assertEquals(listOf("Check fire extinguishers", "Generator check"), tasks.map { it.title }.sorted())

        // Not on duty yet: refused, with the server's reason.
        val gen = tasks.first { it.title == "Generator check" }
        val early = device.tasks.complete(gen, "", File(dir, "p.jpg").apply { writeBytes(LiveFixture.JPEG) })
        assertEquals("Log Duty On before doing tasks.", (early as Submitted.Refused).message)

        assertTrue(device.duty(DutyKind.ON, f.pin).second is Submitted.Sent)
        val again = device.tasks.today().first { it.title == "Generator check" }
        assertTrue(again.isOpen)
        assertTrue(device.tasks.complete(again, "Fuel at 70 litres", File(dir, "p.jpg").apply { writeBytes(LiveFixture.JPEG) }) is Submitted.Sent)
        val ext = device.tasks.today().first { it.title == "Check fire extinguishers" }
        assertTrue(device.tasks.cannotComplete(ext, "access_unavailable", "Plant room locked", null) is Submitted.Sent)

        val after = device.tasks.today().associateBy { it.title }
        assertEquals("completed", after["Generator check"]!!.state)
        assertEquals(false, after["Generator check"]!!.photoPending, "photo arrived")
        assertEquals("could_not_complete", after["Check fire extinguishers"]!!.state)

        // The supervisor sees both on the website's task board.
        val board = f.call("GET", "/tasks/board?date=$today", f.managerToken)["rows"]!!.jsonArray.map { it.jsonObject }
        val mine = board.filter { it["title"]!!.jsonPrimitive.content in setOf("Generator check", "Check fire extinguishers") && it["doneByName"]?.jsonPrimitive?.content == "Phone Test Officer" }
        assertTrue(mine.size >= 2)
    }
}
