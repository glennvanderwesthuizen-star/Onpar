package za.onpar.core

import kotlinx.serialization.Serializable
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.temporal.ChronoUnit

/** The numbers the gate phone may dial for a unit (or the office). Dialled hidden: the guard never sees them. */
@Serializable
data class OfflineNumbers(val primary: String? = null, val second: String? = null) {
    val any: Boolean get() = primary != null || second != null
}

@Serializable
data class OfflineUnit(val id: String, val name: String = "", val primary: String? = null, val second: String? = null) {
    val numbers: OfflineNumbers get() = OfflineNumbers(primary, second)
}

/** A pass as the gate phone keeps it, with what it needs to match and time it with no signal. */
@Serializable
data class OfflinePass(
    val id: String,
    val kind: String = "once",
    val visitorName: String = "",
    val unitId: String? = null,
    val visiting: String = "",
    val category: String = "",
    val by: String = "",
    val gateId: String? = null,
    val gateName: String? = null,
    val idNumber: String? = null,
    val registration: String? = null,
    val cell: String? = null,
    val visitDate: String? = null,
    val time: String? = null,
    val days: List<Int>? = null,
    val hoursFrom: String? = null,
    val hoursTo: String? = null,
    val startDate: String? = null,
    val endDate: String? = null,
    val contractor: Boolean = false,
    val maxWorkers: Int? = null,
    val leaveBy: String? = null,
)

@Serializable
data class OfflineBarred(val kind: String, val value: String, val unitId: String? = null)

/** A visitor recorded as on site when the phone last had signal. */
@Serializable
data class OfflineOnSite(
    val id: String,
    val type: String = "vehicle",
    val paxIn: Int? = null,
    val idNumber: String? = null,
    val registration: String? = null,
    val visitor: String = "",
    val visiting: String = "",
)

/**
 * What the gate phone keeps for when the signal drops (visitor specification, offline): the
 * passes, the barred list, who is on site and the numbers to phone. Fetched every few minutes.
 */
@Serializable
data class OfflinePack(
    val at: String = "",
    val today: String = "",
    val gateId: String = "",
    val hasClient: Boolean = false,
    val secondContact: Boolean = false,
    val office: OfflineNumbers = OfflineNumbers(),
    val units: List<OfflineUnit> = emptyList(),
    val passes: List<OfflinePass> = emptyList(),
    val barred: List<OfflineBarred> = emptyList(),
    val onSite: List<OfflineOnSite> = emptyList(),
)

/**
 * The gate's checks done on the phone when there is no signal. The same tests as the server's,
 * so the guard gets the same answer either way.
 */
object GateOffline {
    /** What the guard decided, as the server records it. */
    val DECISIONS = setOf("pass", "approved", "denied", "no_answer", "barred")

    private val BARRED_LABELS = mapOf("id_number" to "ID number", "registration" to "Number plate")

    private fun minutes(hhmm: String): Int = hhmm.substring(0, 2).toInt() * 60 + hhmm.substring(3, 5).toInt()

    /** Whether a pass applies at this moment in South Africa: with a time, one hour either side; a regular on his days, hours and dates. */
    fun applies(p: OfflinePass, at: LocalDateTime): Boolean {
        val date = at.toLocalDate()
        val now = at.hour * 60 + at.minute
        if (p.kind == "once") {
            val day = p.visitDate?.let(LocalDate::parse) ?: return false
            if (p.time == null) return day == date
            val diff = ChronoUnit.DAYS.between(day, date) * 1440 + now - minutes(p.time)
            return kotlin.math.abs(diff) <= 60
        }
        val iso = date.toString()
        if (p.startDate != null && p.startDate > iso) return false
        if (p.endDate != null && p.endDate < iso) return false
        if (!p.days.isNullOrEmpty() && at.dayOfWeek.value !in p.days) return false
        if (p.hoursFrom != null && p.hoursTo != null && (now < minutes(p.hoursFrom) || now > minutes(p.hoursTo))) return false
        return true
    }

    /** The pass that lets this visitor in now. A one-visit pass is preferred to a regular's, as on the server. */
    fun expected(pack: OfflinePack, idNumber: String?, registration: String?, cell: String?, at: LocalDateTime): ExpectedMatch? {
        val id = idNumber?.let(VisitorScan::idNumber)?.takeIf { it.isNotBlank() }
        val plate = registration?.let(VisitorScan::plate)?.takeIf { it.isNotBlank() }
        val phone = cell?.filter { it.isDigit() }?.takeIf { it.isNotBlank() }
        if (id == null && plate == null && phone == null) return null
        val fits = pack.passes.filter { p ->
            applies(p, at) && ((p.idNumber != null && p.idNumber == id) || (p.registration != null && p.registration == plate) || (p.cell != null && p.cell.filter { it.isDigit() } == phone))
        }
        val p = fits.firstOrNull { it.kind == "once" } ?: fits.firstOrNull() ?: return null
        val mismatch = buildList {
            if (p.registration != null && plate != null && p.registration != plate) add("number plate")
            if (p.idNumber != null && id != null && p.idNumber != id) add("ID number")
        }
        return ExpectedMatch(
            passId = p.id,
            visitorName = p.visitorName,
            visiting = p.visiting,
            category = p.category,
            by = p.by,
            regular = p.kind == "ongoing",
            namedGate = if (p.gateId != null && p.gateId != pack.gateId) p.gateName else null,
            mismatch = mismatch,
            contractor = p.contractor,
            maxWorkers = p.maxWorkers,
            leaveBy = if (p.contractor) p.leaveBy else null,
        )
    }

    /** Barred entries that match, for the whole site or for the unit being visited. */
    fun barred(pack: OfflinePack, unitId: String?, idNumber: String?, registration: String?): List<BarredHit> {
        val id = idNumber?.let(VisitorScan::idNumber)
        val plate = registration?.let(VisitorScan::plate)
        return pack.barred
            .filter { (it.unitId == null || it.unitId == unitId) && ((it.kind == "id_number" && it.value == id) || (it.kind == "registration" && it.value == plate)) }
            .map { BarredHit(it.kind, BARRED_LABELS[it.kind] ?: it.kind, if (it.unitId == null) "site" else "unit") }
    }

    /** Visits still recorded as on site for this person or vehicle. */
    fun onSite(pack: OfflinePack, idNumber: String?, registration: String?): List<OfflineOnSite> {
        val id = idNumber?.let(VisitorScan::idNumber)?.takeIf { it.isNotBlank() }
        val plate = registration?.let(VisitorScan::plate)?.takeIf { it.isNotBlank() }
        return pack.onSite.filter { (id != null && it.idNumber == id) || (plate != null && it.registration == plate) }
    }

    /** The scan check as the server would answer it, from the phone's pack. */
    fun check(pack: OfflinePack, idNumber: String?, registration: String?, unitId: String?, cell: String?, at: LocalDateTime): ScanCheck {
        val pass = expected(pack, idNumber, registration, cell, at)
        return ScanCheck(
            barred = barred(pack, pass?.unitId(pack) ?: unitId, idNumber, registration),
            expected = pass,
            onSite = onSite(pack, idNumber, registration).map {
                OnSiteHit(if (it.registration != null && it.registration == registration?.let(VisitorScan::plate)) "vehicle" else "person", it.visitor, it.registration, it.visiting, null, "")
            },
            reasons = listOf(ReasonOption("not_scanned_out", "Left earlier without being scanned out"), ReasonOption("other", "Other")),
            offline = true,
            packAt = pack.at,
        )
    }

    private fun ExpectedMatch.unitId(pack: OfflinePack): String? = pack.passes.firstOrNull { it.id == passId }?.unitId

    /** The numbers to phone for a unit, or for the office when `unitId` is null. */
    fun numbers(pack: OfflinePack, unitId: String?): OfflineNumbers =
        if (unitId == null) pack.office else pack.units.firstOrNull { it.id == unitId }?.numbers ?: OfflineNumbers()

    /**
     * What the guard decides without phoning: "barred" or "pass". Null when the customer must be
     * phoned (an unannounced visitor, or more workers than the customer approved).
     */
    fun decisionWithoutCall(check: ScanCheck?, d: VisitDraft): String? = when {
        check?.barred?.isNotEmpty() == true -> "barred"
        d.passId != null && check?.expected?.extraWorkers(d.pax) != true -> "pass"
        else -> null
    }

    /** How a visit the guard decided with no signal ends, for the screen. */
    fun reply(eventId: String, decision: String): VisitReply = when (decision) {
        "pass", "approved" -> VisitReply(eventId, "on_site", "On site")
        "no_answer" -> VisitReply(eventId, "denied_no_response", "Turned away: nobody answered")
        "barred" -> VisitReply(eventId, "denied", "Turned away", "This visitor is on the barred list. Do not let them in. Your supervisor is told when the phone has signal.")
        else -> VisitReply(eventId, "denied", "Turned away")
    }

    /** The exit scan from the phone's list of who is on site. Nothing found raises "not scanned in". */
    fun exitFind(pack: OfflinePack, idNumber: String?, registration: String?, paxCount: Boolean): ExitFound {
        val v = onSite(pack, idNumber, registration).firstOrNull()
        return if (v != null) {
            ExitFound(
                visit = ExitVisit(id = v.id, type = v.type, visitor = v.visitor, vehicle = v.registration, visiting = v.visiting, paxIn = v.paxIn),
                askPax = paxCount && v.type == "vehicle" && registration != null,
                offline = true,
            )
        } else {
            ExitFound(
                exceptions = listOf(ExitException("no_open_visit", "Not on the list", "Nobody on the phone's list of visitors on site matches. The list is from when the phone last had signal.")),
                reasons = listOf(ReasonOption("not_scanned_in", "Was not scanned in"), ReasonOption("other", "Other")),
                offline = true,
            )
        }
    }

    /** South African time now, from the phone's trusted clock. */
    fun localNow(clock: TrustedClock): LocalDateTime = clock.now().atZone(TaskActions.SAST).toLocalDateTime()
}
