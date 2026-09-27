package za.onpar.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.File
import java.util.UUID

/** Report categories, priorities, stages and follow-up outcomes (brief section 6.6; same as the server). */
val REPORT_CATEGORIES = linkedMapOf(
    "security" to "Security", "safety" to "Safety", "injury" to "Injury", "maintenance" to "Maintenance", "equipment" to "Equipment",
    "client_issue" to "Client issue", "staff_issue" to "Staff issue", "observation" to "Observation", "other" to "Other",
)
val PRIORITIES = linkedMapOf("green" to "Green", "amber" to "Amber", "red" to "Red")
val REPORT_STAGES = linkedMapOf(
    "reported" to "Reported", "assigned" to "Assigned", "actioned" to "Actioned",
    "attendance_checked" to "Attendance checked", "job_inspected" to "Job inspected", "closed" to "Closed",
)
val FOLLOW_UP_OUTCOMES = linkedMapOf(
    "not_started" to "Not started yet", "in_progress" to "Work in progress", "done_ok" to "Repair done, all OK", "not_fixed" to "Not fixed",
)

@Serializable
data class ReportItem(
    val id: String,
    val number: Int,
    val category: String,
    val priority: String,
    val description: String = "",
    val stage: String,
    /** The report's colour badge (brief section 24). */
    val colour: String? = null,
    val reportedAt: String? = null,
    val reportedBy: String? = null,
    val assigneeName: String? = null,
    val hasPhoto: Boolean = false,
    val mine: Boolean = false,
) {
    /** The same rule as the server: follow-ups start once assigned, and stop when closed. */
    val followUpRefusal: String?
        get() = when (stage) {
            "reported" -> "You can follow up once the report has been assigned."
            "closed" -> "This report is closed."
            else -> null
        }

    /** The officer on site is inspecting the finished work (brief section 6.6). */
    val awaitingInspection: Boolean get() = stage == "attendance_checked"
}

/** Reports on the phone: make one, see your own and the site's open ones, follow up. */
class ReportActions(private val device: OnParDevice, dataDir: File) {
    private val cache = File(dataDir, "reports.json")
    private val list = ListSerializer(ReportItem.serializer())

    fun list(): List<ReportItem> = try {
        val fresh = OnParJson.decodeFromJsonElement(list, device.client().get("/device/reports", device.requireGuard()))
        cache.writeText(OnParJson.encodeToString(list, fresh))
        fresh
    } catch (e: OfflineException) {
        cached()
    }

    fun cached(): List<ReportItem> = if (cache.exists()) runCatching { OnParJson.decodeFromString(list, cache.readText()) }.getOrDefault(emptyList()) else emptyList()

    /** Reports still waiting to be sent from this phone. */
    fun waiting(): List<OutboxItem> = device.outbox.pending().filter { it.path == "/device/reports" }

    /** A new report, with an optional photo sent with it. Routed automatically on the server. */
    fun create(category: String, priority: String, description: String, photo: File?): Submitted {
        require(category in REPORT_CATEGORIES) { "Choose a category." }
        require(priority in PRIORITIES) { "Choose Green, Amber or Red." }
        require(description.trim().length >= 3) { "Describe what you saw." }
        val eventId = UUID.randomUUID().toString()
        val body = buildJsonObject {
            put("eventId", eventId)
            put("category", category)
            put("priority", priority)
            put("description", description.trim())
            put("trustedAt", device.clock.now().toString())
            put("deviceClock", device.clock.deviceClock().toString())
        }
        val files = if (photo.present()) listOf(Upload("photo", photo!!, "image/jpeg")) else emptyList()
        val label = "Report: ${REPORT_CATEGORIES[category]} (${PRIORITIES[priority]})"
        return device.outbox.submit(device.client(), eventId, label, "/device/reports", body, device.requireGuard(), files)
    }

    /** A follow-up on a report: what the officer found, with an optional note and photo. */
    fun followUp(report: ReportItem, outcome: String, note: String, photo: File?): Submitted {
        report.followUpRefusal?.let { throw IllegalArgumentException(it) }
        require(outcome in FOLLOW_UP_OUTCOMES) { "Choose what you found." }
        require(outcome != "not_fixed" || note.isNotBlank()) { "Say what is still wrong." }
        val eventId = UUID.randomUUID().toString()
        val body = buildJsonObject {
            put("eventId", eventId)
            put("outcome", outcome)
            put("note", note.trim())
            put("trustedAt", device.clock.now().toString())
            put("deviceClock", device.clock.deviceClock().toString())
        }
        val files = if (photo.present()) listOf(Upload("photo", photo!!, "image/jpeg")) else emptyList()
        return device.outbox.submit(device.client(), eventId, "Follow-up on report #${report.number}", "/device/reports/${report.id}/follow-up", body, device.requireGuard(), files)
    }

    fun clear() {
        cache.delete()
    }
}

/** A replacement or supply request (brief section 6.7). */
@Serializable
data class ReorderItem(
    val id: String,
    val number: Int,
    val kind: String,
    val item: String,
    val size: String? = null,
    val assetNumber: String? = null,
    val quantity: String? = null,
    val comment: String = "",
    val stage: String,
    val requestedAt: String? = null,
    val receivedAt: String? = null,
    val assigneeName: String? = null,
    val mine: Boolean = false,
    val canConfirm: Boolean = false,
)

@Serializable
data class IssuedItem(val id: String, val item: String, val size: String? = null, val assetNumber: String? = null, val issueDate: String? = null)

val REORDER_STAGES = linkedMapOf("requested" to "Requested", "ordered" to "Ordered", "assigned" to "Assigned for delivery", "delivered" to "Delivered", "received" to "Received")

/** Re-orders on the phone: personal kit (size or asset number from the profile) or site supplies, and receipt. */
class ReorderActions(private val device: OnParDevice, dataDir: File) {
    private val cache = File(dataDir, "reorders.json")
    private val kitCache = File(dataDir, "kit.json")
    private val list = ListSerializer(ReorderItem.serializer())
    private val kitList = ListSerializer(IssuedItem.serializer())

    fun list(): List<ReorderItem> = fetch("/device/reorders", cache, list)
    fun kit(): List<IssuedItem> = fetch("/device/kit", kitCache, kitList)

    private fun <T> fetch(path: String, file: File, s: kotlinx.serialization.KSerializer<List<T>>): List<T> = try {
        val fresh = OnParJson.decodeFromJsonElement(s, device.client().get(path, device.requireGuard()))
        file.writeText(OnParJson.encodeToString(s, fresh))
        fresh
    } catch (e: OfflineException) {
        if (file.exists()) runCatching { OnParJson.decodeFromString(s, file.readText()) }.getOrDefault(emptyList()) else emptyList()
    }

    fun waiting(): List<OutboxItem> = device.outbox.pending().filter { it.path.startsWith("/device/reorders") }

    /** Replace an item issued to you. The size or asset number is filled in from your profile. */
    fun personal(item: IssuedItem, comment: String): Submitted {
        require(comment.trim().length >= 3) { "Say why it needs replacing, for example damaged while chasing a suspect." }
        return send("Re-order: ${item.item}", buildJsonObject {
            put("kind", "personal")
            put("issuedItemId", item.id)
            put("comment", comment.trim())
        })
    }

    /** Something the site needs, in the guard's own words, for example "Toilet paper, 2 packs". */
    fun site(item: String, quantity: String, comment: String): Submitted {
        require(item.trim().length >= 2) { "Say what the site needs, for example toilet paper." }
        return send("Site re-order: ${item.trim()}", buildJsonObject {
            put("kind", "site")
            put("item", item.trim())
            put("quantity", quantity.trim())
            put("comment", comment.trim())
        })
    }

    /** Confirms it arrived. A personal item's issue date becomes today. */
    fun received(r: ReorderItem, note: String): Submitted {
        require(r.canConfirm) { if (r.stage == "received") "Already received." else "This has not been ordered yet." }
        val eventId = UUID.randomUUID().toString()
        val body = buildJsonObject {
            put("eventId", eventId)
            put("note", note.trim())
            put("trustedAt", device.clock.now().toString())
            put("deviceClock", device.clock.deviceClock().toString())
        }
        return device.outbox.submit(device.client(), eventId, "Received: ${r.item}", "/device/reorders/${r.id}/received", body, device.requireGuard())
    }

    private fun send(label: String, fields: kotlinx.serialization.json.JsonObject): Submitted {
        val eventId = UUID.randomUUID().toString()
        val body = buildJsonObject {
            put("eventId", eventId)
            fields.forEach { (k, v) -> put(k, v) }
            put("trustedAt", device.clock.now().toString())
            put("deviceClock", device.clock.deviceClock().toString())
        }
        return device.outbox.submit(device.client(), eventId, label, "/device/reorders", body, device.requireGuard())
    }

    fun clear() {
        cache.delete()
        kitCache.delete()
    }
}

private fun File?.present(): Boolean = this != null && isFile && length() > 0
