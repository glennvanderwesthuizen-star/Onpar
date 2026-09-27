package za.onpar.core

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.time.Instant

class TrustedClockTest {
    @Test
    fun `uses server time plus elapsed time, ignoring a changed phone clock`() {
        var elapsed = 0L
        var phone = Instant.parse("2026-01-01T00:00:00Z")
        val clock = TrustedClock({ elapsed }, { phone })
        assertFalse(clock.isSynced)
        assertEquals(phone, clock.now())
        clock.sync(Instant.parse("2026-09-27T06:00:00Z"))
        elapsed += 90_000_000_000L // 90 seconds later
        phone = Instant.parse("2030-05-05T00:00:00Z") // someone changed the phone's date
        assertTrue(clock.isSynced)
        assertEquals(Instant.parse("2026-09-27T06:01:30Z"), clock.now())
        assertEquals(phone, clock.deviceClock())
    }
}
