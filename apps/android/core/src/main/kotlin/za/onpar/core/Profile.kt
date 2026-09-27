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

/** An approved number the guard may call: supervisor, site manager, control room (brief section 6.10). */
@Serializable
data class Contact(val kind: String, val label: String, val name: String = "", val phone: String)

/** The guard's own score, training, and the site's approved contacts. */
class ProfileActions(private val device: OnParDevice, dataDir: File) {
    private val scoreFile = File(dataDir, "score.json")
    private val trainingFile = File(dataDir, "training.json")
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
    fun contacts(): List<Contact> = fetch("/device/contacts", contactsFile, null)

    private fun <T> fetch(path: String, file: File, token: String?, s: kotlinx.serialization.KSerializer<List<T>>): List<T> = try {
        val fresh = OnParJson.decodeFromJsonElement(s, device.client().get(path, token))
        file.writeText(OnParJson.encodeToString(s, fresh))
        fresh
    } catch (e: OfflineException) {
        if (file.exists()) runCatching { OnParJson.decodeFromString(s, file.readText()) }.getOrDefault(emptyList()) else emptyList()
    }

    private inline fun <reified T> fetch(path: String, file: File, token: String?): List<T> = fetch(path, file, token, ListSerializer(kotlinx.serialization.serializer<T>()))

    /** The phone may dial only these numbers (compared digits-only, so spacing does not matter). */
    fun isApproved(number: String): Boolean {
        val digits = number.filter(Char::isDigit)
        val known = if (contactsFile.exists()) runCatching { OnParJson.decodeFromString(ListSerializer(Contact.serializer()), contactsFile.readText()) }.getOrDefault(emptyList()) else emptyList()
        return digits.isNotEmpty() && known.any { it.phone.filter(Char::isDigit).let { p -> p == digits || (p.length >= 9 && digits.endsWith(p.takeLast(9))) } }
    }

    fun clear() {
        scoreFile.delete()
        trainingFile.delete()
    }
}
