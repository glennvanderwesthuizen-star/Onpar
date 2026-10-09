package za.onpar.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.buildJsonObject

/** One HR notice in the guard's list (owner, 9 Oct 2026, D-52). */
@Serializable
data class NoticeSummary(
    val id: String,
    val typeLabel: String = "",
    val subject: String = "",
    val issuedAt: String? = null,
    val acknowledged: String? = null,
    val status: String = "",
    val statusLabel: String = "",
)

@Serializable
data class NoticeList(val ackText: String = "", val notices: List<NoticeSummary> = emptyList())

/** A notice opened: its full text, and what acknowledging means. */
@Serializable
data class NoticeOpen(
    val id: String,
    val typeLabel: String = "",
    val subject: String = "",
    val body: String = "",
    /** Sent with it: the rights documents with a notice to appear (D-53). */
    val documents: List<NoticeDocument> = emptyList(),
    val issuedAt: String? = null,
    val acknowledged: String? = null,
    val ackText: String = "",
)

@Serializable
data class NoticeDocument(val title: String = "", val body: String = "")

/**
 * The guard's own HR notices on the post phone: only for the guard signed in with his own PIN
 * and holding the phone. Needs signal; nothing is kept on the phone.
 */
class NoticeActions(private val device: OnParDevice) {
    fun list(): NoticeList = OnParJson.decodeFromJsonElement(NoticeList.serializer(), device.client().get("/device/notices", device.requireGuard()))

    fun open(id: String): NoticeOpen = OnParJson.decodeFromJsonElement(NoticeOpen.serializer(), device.client().get("/device/notices/$id", device.requireGuard()))

    /** "I acknowledge receipt." It does not mean he agrees. */
    fun acknowledge(id: String): NoticeSummary =
        OnParJson.decodeFromJsonElement(NoticeSummary.serializer(), device.client().post("/device/notices/$id/acknowledge", buildJsonObject { }, device.requireGuard()))
}
