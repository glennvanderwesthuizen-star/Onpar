package za.onpar.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.File

/** One reason the score changed (brief section 6.8: the guard sees why). */
@Serializable
data class ScoreEvent(
    val id: String,
    val date: String,
    val type: String,
    val label: String,
    val impact: Double,
    val evidence: String = "",
    val siteName: String? = null,
    val createdBy: String? = null,
    val reversedBy: String? = null,
    val queryStatus: String? = null,
    val queryText: String? = null,
    val queryAnswer: String? = null,
    val queryAnswerDue: String? = null,
    val queryUntil: String? = null,
    val canQuery: Boolean = false,
)

@Serializable
data class Score(
    val score: Int,
    val position: String,
    val positionLabel: String,
    val events: List<ScoreEvent> = emptyList(),
)

/** A qualification and whether it is current (brief section 6.9). */
@Serializable
data class Qualification(val name: String, val type: String? = null, val expiryDate: String? = null, val status: String)

/**
 * An approved number the guard may call: supervisor, site manager, control room (brief section 6.10),
 * and the emergency panel's numbers (owner, 7 Oct 2026). For those, `emergency` is the service
 * ("police", "fire", "ambulance", "armed_response"), `national` says it is a national number, and
 * `logo` (armed response only) changes whenever the company's logo does.
 */
@Serializable
data class Contact(val kind: String, val label: String, val name: String = "", val phone: String, val emergency: String? = null, val national: Boolean = false, val logo: String? = null)

/** One button of the emergency panel: a service and the numbers behind it (police can have two). */
data class EmergencyButton(val service: String, val title: String, val options: List<Contact>)

private val EMERGENCY_ORDER = listOf("police" to "POLICE", "fire" to "FIRE BRIGADE", "ambulance" to "AMBULANCE", "armed_response" to "ARMED RESPONSE")

/**
 * The emergency panel's buttons, in a fixed order. A service with no number has no button.
 * After PANIC the site's control room comes first (PANIC no longer phones it by itself: owner, 7 Oct 2026).
 */
fun List<Contact>.emergencyButtons(withControlRoom: Boolean = false): List<EmergencyButton> =
    listOfNotNull(firstOrNull { it.kind == "control_room" }?.takeIf { withControlRoom }?.let { EmergencyButton("control_room", "CONTROL ROOM", listOf(it)) }) +
        EMERGENCY_ORDER.mapNotNull { (service, title) -> filter { it.emergency == service }.takeIf { it.isNotEmpty() }?.let { EmergencyButton(service, title, it) } }

/** My Wire (owner's rule book, 8 Oct 2026): only what he earned and what is still open to him. */
@Serializable
data class WireSource(val rule: String, val label: String, val barbs: Int)

@Serializable
data class WireMonthTotal(val total: Int = 0, val bySource: List<WireSource> = emptyList())

@Serializable
data class WireNext(val name: String, val toGo: Int, val months: Int? = null)

@Serializable
data class WireMonth(val month: String, val barbs: Int, val award: String? = null)

@Serializable
data class WireRecent(val date: String, val label: String, val barbs: Int)

@Serializable
data class MyWire(
    val insignia: String,
    val insigniaLabel: String,
    val wireTotal: Int,
    val available: Int,
    val barbsDrawn: Int = 0,
    val thisMonth: WireMonthTotal = WireMonthTotal(),
    val streak: Int = 0,
    val next: WireNext,
    val months: List<WireMonth> = emptyList(),
    val perShift: Int = 3,
    val readyLeadMinutes: Int = 15,
    val recent: List<WireRecent> = emptyList(),
)

/** The guard's own score, training, and the site's approved contacts. */
class ProfileActions(private val device: OnParDevice, dataDir: File) {
    private val scoreFile = File(dataDir, "score.json")
    private val trainingFile = File(dataDir, "training.json")
    private val rosterFile = File(dataDir, "roster.json")
    private val wireFile = File(dataDir, "wire.json")

    /** My Wire. The last copy is kept for when there is no signal. */
    fun wire(): MyWire? = try {
        val w = OnParJson.decodeFromJsonElement(MyWire.serializer(), device.client().get("/device/wire", device.requireGuard()))
        wireFile.writeText(OnParJson.encodeToString(MyWire.serializer(), w))
        w
    } catch (e: OfflineException) {
        if (wireFile.exists()) runCatching { OnParJson.decodeFromString(MyWire.serializer(), wireFile.readText()) }.getOrNull() else null
    }
    /** My roster: today and the working days of the next four weeks. The last copy is kept for when there is no signal. */
    fun roster(): GuardRoster? = try {
        val r = OnParJson.decodeFromJsonElement(GuardRoster.serializer(), device.client().get("/device/roster", device.requireGuard()))
        rosterFile.writeText(OnParJson.encodeToString(GuardRoster.serializer(), r))
        r
    } catch (e: OfflineException) {
        if (rosterFile.exists()) runCatching { OnParJson.decodeFromString(GuardRoster.serializer(), rosterFile.readText()) }.getOrNull() else null
    }

    /** Kept at device level, not per guard: calls must work with no data and before anyone logs in. */
    private val contactsFile = File(dataDir, "contacts.json")

    fun score(): Score? = try {
        val s = OnParJson.decodeFromJsonElement(Score.serializer(), device.client().get("/device/score", device.requireGuard()))
        scoreFile.writeText(OnParJson.encodeToString(Score.serializer(), s))
        s
    } catch (e: OfflineException) {
        if (scoreFile.exists()) runCatching { OnParJson.decodeFromString(Score.serializer(), scoreFile.readText()) }.getOrNull() else null
    }

    /**
     * Queries a lost point (within 7 days by default). Needs signal: the guard sees the
     * answer deadline straight away, and a supervisor answers within 3 working days.
     */
    fun query(event: ScoreEvent, text: String): String {
        require(event.canQuery) { if (event.queryStatus != null) "You have already queried this." else "This can no longer be queried." }
        require(text.trim().length >= 5) { "Say why you disagree." }
        val r = device.client().post("/device/score/events/${event.id}/query", buildJsonObject { put("text", text.trim()) }, device.requireGuard())
        return r.str("answerDue") ?: ""
    }

    fun training(): List<Qualification> = fetch("/device/qualifications", trainingFile, device.requireGuard())

    /** The approved contacts, kept on the phone so calls work with no data. */
    fun contacts(): List<Contact> = fetch<Contact>("/device/contacts", contactsFile, null).also { runCatching { syncArmedLogo(it) } }

    private val logoFile = File(dataDir, "armed-logo.img")
    private val logoTagFile = File(dataDir, "armed-logo.tag")

    /** Keeps the armed response company's logo on the phone, so the button shows it with no data. Fetched only when it has changed. */
    private fun syncArmedLogo(list: List<Contact>) {
        val tag = list.firstOrNull { it.emergency == "armed_response" }?.logo
        val have = if (logoTagFile.exists() && logoFile.exists()) logoTagFile.readText() else null
        if (tag == null) {
            // Only forget the logo when the server really says there is none (not when reading the kept copy with no signal).
            if (list.any { it.emergency != null } && have != null) { logoFile.delete(); logoTagFile.delete() }
            return
        }
        if (tag == have) return
        logoFile.writeBytes(device.client().getBytes("/device/armed-response-logo"))
        logoTagFile.writeText(tag)
    }

    /** The armed response logo kept on the phone, if any. */
    fun armedLogo(): ByteArray? = if (logoFile.exists() && logoTagFile.exists()) runCatching { logoFile.readBytes() }.getOrNull() else null

    private fun <T> fetch(path: String, file: File, token: String?, s: kotlinx.serialization.KSerializer<List<T>>): List<T> = try {
        val fresh = OnParJson.decodeFromJsonElement(s, device.client().get(path, token))
        file.writeText(OnParJson.encodeToString(s, fresh))
        fresh
    } catch (e: OfflineException) {
        if (file.exists()) runCatching { OnParJson.decodeFromString(s, file.readText()) }.getOrDefault(emptyList()) else emptyList()
    }

    private inline fun <reified T> fetch(path: String, file: File, token: String?): List<T> = fetch(path, file, token, ListSerializer(kotlinx.serialization.serializer<T>()))

    /** The contacts last fetched, read from the phone only. */
    fun cachedContacts(): List<Contact> =
        if (contactsFile.exists()) runCatching { OnParJson.decodeFromString(ListSerializer(Contact.serializer()), contactsFile.readText()) }.getOrDefault(emptyList()) else emptyList()

    /** The phone may dial only these numbers (compared digits-only, so spacing does not matter). */
    fun isApproved(number: String): Boolean {
        val digits = number.filter(Char::isDigit)
        val known = if (contactsFile.exists()) runCatching { OnParJson.decodeFromString(ListSerializer(Contact.serializer()), contactsFile.readText()) }.getOrDefault(emptyList()) else emptyList()
        return digits.isNotEmpty() && known.any { it.phone.filter(Char::isDigit).let { p -> p == digits || (p.length >= 9 && digits.endsWith(p.takeLast(9))) } }
    }

    fun clear() {
        scoreFile.delete()
        trainingFile.delete()
        rosterFile.delete()
        wireFile.delete()
    }
}
