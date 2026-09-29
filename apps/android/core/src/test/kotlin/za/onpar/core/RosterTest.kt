package za.onpar.core

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

/** The guard's real shift on the home screen (brief section 40, scenario 31). */
class RosterTest {
    private val json = """
        {"employee":{"id":"e1","name":"John Smith"},"serverTime":"2026-10-01T06:00:00Z",
         "roster":{"rostered":true,
           "today":{"date":"2026-10-01","status":"working","siteName":"Estate ABC","shiftName":"Day","kind":"day","startTime":"06:00","endTime":"18:00"},
           "comingUp":[{"date":"2026-10-04","status":"working","siteName":"Office Park","shiftName":"Graveyard","kind":"night","startTime":"19:00","endTime":"07:00"}]}}
    """.trimIndent()

    @Test
    fun `shows today's real shift and what is coming up`() {
        val s = OnParJson.decodeFromString(GuardState.serializer(), json)
        assertEquals("Today: Day shift 06:00–18:00 at Estate ABC", s.roster.todayText())
        assertEquals("Night shift (Graveyard) 19:00–07:00 at Office Park", s.roster!!.comingUp[0].shiftText())
        assertEquals("Sun 4 Oct", rosterDate(s.roster!!.comingUp[0].date))
    }

    @Test
    fun `says Off today or Not yet rostered, never a made-up shift`() {
        assertEquals("Off today", GuardRoster(true, RosterDay("2026-10-01", "off", "Estate ABC")).todayText())
        assertEquals("Not yet rostered", GuardRoster(false, RosterDay("2026-10-01", "not_rostered")).todayText())
        assertEquals("Not yet rostered", (null as GuardRoster?).todayText())
        // An older server that sends no roster at all.
        val old = OnParJson.decodeFromString(GuardState.serializer(), """{"employee":{"id":"e1","name":"J"},"serverTime":"x"}""")
        assertEquals("Not yet rostered", old.roster.todayText())
    }
}
