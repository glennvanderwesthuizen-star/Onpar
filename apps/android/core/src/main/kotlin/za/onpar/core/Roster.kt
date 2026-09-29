package za.onpar.core

import kotlinx.serialization.Serializable
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.util.Locale

/** One day of the guard's roster, as the server works it out (brief section 40). */
@Serializable
data class RosterDay(
    val date: String,
    /** working, off, not_rostered, or unmapped (the site has no shift of that kind). */
    val status: String,
    val siteName: String? = null,
    val shiftName: String? = null,
    val kind: String? = null,
    val startTime: String? = null,
    val endTime: String? = null,
)

/** Today's real shift and the coming working days. */
@Serializable
data class GuardRoster(val rostered: Boolean = false, val today: RosterDay? = null, val comingUp: List<RosterDay> = emptyList())

private val DAY = DateTimeFormatter.ofPattern("EEE d MMM", Locale.ENGLISH)

/** "Mon 5 Oct" from 2026-10-05. */
fun rosterDate(date: String): String = runCatching { LocalDate.parse(date).format(DAY) }.getOrDefault(date)

/** The shift in words, for example "Day shift 06:00–18:00 at Estate ABC". */
fun RosterDay.shiftText(): String {
    val kindWord = if (kind == "night") "Night" else "Day"
    val name = shiftName?.takeIf { !it.equals(kindWord, ignoreCase = true) }?.let { " ($it)" } ?: ""
    return "$kindWord shift$name ${startTime ?: ""}–${endTime ?: ""}${siteName?.let { " at $it" } ?: ""}".replace("  ", " ")
}

/** The home screen line for today: the real shift, "Off today" or "Not yet rostered" (scenario 31). */
fun GuardRoster?.todayText(): String {
    val t = this?.today
    return when {
        this == null || !rostered || t == null || t.status == "not_rostered" -> "Not yet rostered"
        t.status == "off" -> "Off today"
        t.status == "working" -> "Today: ${t.shiftText()}"
        else -> "Today: ${if (t.kind == "night") "night" else "day"} shift at ${t.siteName ?: "your site"}; ask your supervisor which one"
    }
}
