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
data class WireRecent(val date: String, val label: String, val barbs: Int, val note: String = "")

/** One step to a goal: done, or what is still to come. */
@Serializable
data class GoalStep(val label: String, val done: Boolean, val toGo: String? = null)

@Serializable
data class WireGoal(val id: String, val itemId: String? = null, val name: String, val ownWords: Boolean = false, val steps: List<GoalStep> = emptyList(), val ready: Boolean = false, val monthsToGo: Int? = null)

/** A row of the owner's goals and store table, as it stands for this guard. Barbs only. */
@Serializable
data class WireItemView(
    val id: String,
    val name: String,
    val category: String,
    val categoryLabel: String,
    val barbs: Int,
    val inStore: Boolean,
    val steps: List<GoalStep> = emptyList(),
    val ready: Boolean = false,
    val monthsToGo: Int? = null,
    val canHandIn: Boolean = false,
)

@Serializable
data class WireHandIn(val id: String, val itemName: String, val barbs: Int, val status: String, val date: String, val cancelReason: String? = null)

@Serializable
data class WireStoreView(
    val storeOpen: Boolean,
    val available: Int,
    val wireTotal: Int,
    val goal: WireGoal? = null,
    val items: List<WireItemView> = emptyList(),
    val handins: List<WireHandIn> = emptyList(),
)

/** The recognition board: most improved guards and Wire milestones. Never a ranking. */
@Serializable
data class BoardImproved(val display: String, val improvedBy: Double)

@Serializable
data class BoardMilestone(val display: String, val label: String, val date: String)

@Serializable
data class WireBoard(
    val month: String? = null,
    val improved: List<BoardImproved> = emptyList(),
    val milestones: List<BoardMilestone> = emptyList(),
    val ownLine: String? = null,
    val showMyName: Boolean = false,
)

/** A Thuthuka note he sent, with what became of it and why. */
@Serializable
data class WireNote(val id: String, val date: String, val suggestion: String, val status: String, val statusLabel: String, val reason: String = "")

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
    val mentor: String? = null,
    val mentees: List<String> = emptyList(),
    val standardBearer: StandardBearer? = null,
)

@Serializable
data class StandardBearer(val name: String, val year: Int)

/** The guard's own score, training, and the site's approved contacts. */
class ProfileActions(private val device: OnParDevice, dataDir: File) {
    private val scoreFile = File(dataDir, "score.json")
    private val trainingFile = File(dataDir, "training.json")
    private val rosterFile = File(dataDir, "roster.json")
    private val wireFile = File(dataDir, "wire.json")

    private val notesFile = File(dataDir, "wire-notes.json")

    /** His Thuthuka notes. The last copy is kept for when there is no signal. */
    fun wireNotes(): List<WireNote> = fetch("/device/wire/notes", notesFile, device.requireGuard())

    /**
     * Sends a Thuthuka note: what he noticed, what he suggests, what it improves, and a photo if
     * he took one. With no signal it waits on the phone and goes when signal returns.
     */
    fun sendNote(noticed: String, suggestion: String, improves: String, photo: File?): Submitted {
        require(noticed.trim().length >= 5) { "Say what you noticed." }
        require(suggestion.trim().length >= 5) { "Say what you suggest." }
        require(improves.trim().length >= 3) { "Say what it would make better." }
        val eventId = java.util.UUID.randomUUID().toString()
        val body = buildJsonObject {
            put("eventId", eventId)
            put("noticed", noticed.trim())
            put("suggestion", suggestion.trim())
            put("improves", improves.trim())
        }
        val files = if (photo != null && photo.exists() && photo.length() > 0) listOf(Upload("photo", photo, "image/jpeg")) else emptyList()
        return device.outbox.submit(device.client(), eventId, "Thuthuka note", "/device/wire/notes", body, device.requireGuard(), files)
    }

    private val storeFile = File(dataDir, "wire-store.json")

    /** His goal and the goals and store table. The last copy is kept for when there is no signal. */
    fun wireStore(): WireStoreView? = try {
        val v = OnParJson.decodeFromJsonElement(WireStoreView.serializer(), device.client().get("/device/wire/store", device.requireGuard()))
        storeFile.writeText(OnParJson.encodeToString(WireStoreView.serializer(), v))
        v
    } catch (e: OfflineException) {
        if (storeFile.exists()) runCatching { OnParJson.decodeFromString(WireStoreView.serializer(), storeFile.readText()) }.getOrNull() else null
    }

    private fun storeReply(r: kotlinx.serialization.json.JsonElement): WireStoreView {
        val v = OnParJson.decodeFromJsonElement(WireStoreView.serializer(), r)
        storeFile.writeText(OnParJson.encodeToString(WireStoreView.serializer(), v))
        return v
    }

    /** Sets his goal: a row of the table, or his own words. Needs signal. */
    fun setGoal(itemId: String? = null, ownWords: String? = null): WireStoreView {
        val body = buildJsonObject {
            when {
                itemId != null -> put("itemId", itemId)
                ownWords != null -> {
                    require(ownWords.trim().length >= 3) { "Say what your goal is." }
                    put("ownWords", ownWords.trim())
                }
                else -> put("clear", true)
            }
        }
        return storeReply(device.client().post("/device/wire/goal", body, device.requireGuard()))
    }

    /** Hands in barbs for something in the store. Needs signal: barbs are only spent with the server's say-so. */
    fun handIn(itemId: String): WireStoreView {
        val body = buildJsonObject {
            put("eventId", java.util.UUID.randomUUID().toString())
            put("itemId", itemId)
        }
        return storeReply(device.client().post("/device/wire/handin", body, device.requireGuard()))
    }

    private val boardFile = File(dataDir, "wire-board.json")

    fun wireBoard(): WireBoard? = try {
        val b = OnParJson.decodeFromJsonElement(WireBoard.serializer(), device.client().get("/device/wire/board", device.requireGuard()))
        boardFile.writeText(OnParJson.encodeToString(WireBoard.serializer(), b))
        b
    } catch (e: OfflineException) {
        if (boardFile.exists()) runCatching { OnParJson.decodeFromString(WireBoard.serializer(), boardFile.readText()) }.getOrNull() else null
    }

    /** His choice whether his name shows on the board. */
    fun showMyName(show: Boolean) {
        device.client().post("/device/wire/show-name", buildJsonObject { put("show", show) }, device.requireGuard())
    }

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
        notesFile.delete()
        storeFile.delete()
        boardFile.delete()
    }
}
