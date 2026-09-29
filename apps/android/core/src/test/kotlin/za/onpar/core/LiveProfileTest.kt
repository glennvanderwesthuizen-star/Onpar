package za.onpar.core

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.Test

/** Score, training and approved contacts from a running server. */
class LiveProfileTest {
    @Test
    fun `the guard sees their score, training and the site's contacts`() {
        assumeTrue(LiveFixture.url.isNotEmpty(), "ONPAR_API_URL not set")
        val f = LiveFixture(LiveFixture.url)
        val device = OnParDevice(java.nio.file.Files.createTempDirectory("onpar-profile").toFile())
        device.applySetup(f.setup)
        // Contacts need no login: the control room can always be called.
        val contacts = device.profile.contacts()
        assertTrue(contacts.any { it.kind == "control_room" }, "$contacts")
        assertTrue(device.profile.isApproved(contacts.first().phone))

        device.signIn(f.employeeNumber, f.pin)
        val s = device.profile.score()!!
        assertEquals(80, s.score)
        assertEquals("On Par", s.positionLabel)
        val training = device.profile.training()
        assertTrue(training.any { it.name.startsWith("PSIRA registration") && it.status == "COMPLIANT" }, "$training")
        // The fixture guard has no roster yet, so both the home screen and My roster say so.
        assertEquals("Not yet rostered", device.state().roster.todayText())
        assertEquals(false, device.profile.roster()!!.rostered)
    }
}
