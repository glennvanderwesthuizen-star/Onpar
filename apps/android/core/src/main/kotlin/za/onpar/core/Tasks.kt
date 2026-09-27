package za.onpar.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.File
import java.time.LocalTime
import java.time.ZoneId
import java.util.UUID

/** One of today's tasks for the guard or the post (brief section 6.4). */
@Serializable
data class TaskItem(
    val id: String,
    val date: String,
    val title: String,
    val instructions: String = "",
    val dueTime: String? = null,
    val photoRequired: Boolean = false,
    val state: String,
    val doneAt: String? = null,
    val photoPending: Boolean = false,
    /** Set for an inspection task: it is recorded on the report (Job done or Not fixed), not here. */
    val reportId: String? = null,
    /** True when this phone has done it but not yet sent it. */
    val waiting: Boolean = false,
) {
    val isInspection: Boolean get() = reportId != null
    val isOpen: Boolean get() = state == "open" && !waiting

    /** Past its due time today and still open. Untimed tasks (the default) are never overdue during the day. */
    fun overdue(now: LocalTime): Boolean = isOpen && dueTime != null && now.isAfter(LocalTime.parse(dueTime))
}

/** The reasons a guard can give for not completing a task (same list as the server). */
val COULD_NOT_COMPLETE_REASONS = linkedMapOf(
    "equipment_unavailable" to "Equipment unavailable",
    "access_unavailable" to "Access unavailable",
    "emergency" to "Emergency",
    "supervisor_instruction" to "Supervisor instruction",
    "other" to "Other",
)

/** Tasks on the phone: today's list (kept for when there is no signal) and the guard's actions. */
class TaskActions(private val device: OnParDevice, dataDir: File) {
    private val cache = File(dataDir, "tasks.json")
    private val doneHere = Store(File(dataDir, "tasks-done.json"))
    private val list = ListSerializer(TaskItem.serializer())

    /** Today's tasks from the server, or the last list seen when there is no signal. Tasks done here but not yet sent show as waiting. */
    fun today(): List<TaskItem> {
        val items = try {
            val fresh = OnParJson.decodeFromJsonElement(list, device.client().get("/device/tasks", device.requireGuard()))
            cache.writeText(OnParJson.encodeToString(list, fresh))
            settle(fresh)
            fresh
        } catch (e: OfflineException) {
            cached()
        }
        return items.map { if (doneHere[it.id] != null && it.state == "open") it.copy(waiting = true, state = doneHere[it.id]!!) else it }
    }

    fun cached(): List<TaskItem> = if (cache.exists()) runCatching { OnParJson.decodeFromString(list, cache.readText()) }.getOrDefault(emptyList()) else emptyList()

    /** Marks a task done, with its photo if it has one. The photo follows the task, so a weak signal never holds it up. */
    fun complete(task: TaskItem, comment: String, photo: File?): Submitted {
        check(task)
        require(!task.photoRequired || (photo != null && photo.length() > 0)) { "This task needs a photo." }
        return send(task, "completed", "/device/tasks/${task.id}/complete", "Task done: ${task.title}", comment, photo) { }
    }

    /** "I could not complete this task", with a reason. No penalty until a supervisor reviews it (section 6.4). */
    fun cannotComplete(task: TaskItem, reason: String, comment: String, photo: File?): Submitted {
        check(task)
        require(reason in COULD_NOT_COMPLETE_REASONS) { "Choose a reason." }
        require(reason != "other" || comment.isNotBlank()) { "Say what happened." }
        return send(task, "could_not_complete", "/device/tasks/${task.id}/cannot-complete", "Could not complete: ${task.title}", comment, photo) { put("reason", reason) }
    }

    private fun check(task: TaskItem) {
        require(!task.isInspection) { "Record this inspection on the report: Job done or Not fixed." }
        require(task.isOpen) { "This task has already been done." }
    }

    private fun send(
        task: TaskItem,
        localState: String,
        path: String,
        label: String,
        comment: String,
        photo: File?,
        extra: kotlinx.serialization.json.JsonObjectBuilder.() -> Unit,
    ): Submitted {
        val eventId = UUID.randomUUID().toString()
        val hasPhoto = photo != null && photo.length() > 0
        val body = buildJsonObject {
            put("eventId", eventId)
            put("comment", comment.trim())
            put("trustedAt", device.clock.now().toString())
            put("deviceClock", device.clock.deviceClock().toString())
            put("photoToFollow", hasPhoto)
            extra()
        }
        val token = device.requireGuard()
        device.outbox.add(eventId, label, path, body, token)
        if (hasPhoto) device.outbox.add("$eventId-photo", "Photo: ${task.title}", "/device/tasks/${task.id}/photo", buildJsonObject { }, token, listOf(Upload("photo", photo!!, "image/jpeg")))
        doneHere[task.id] = localState
        val r = device.sync()[eventId] ?: Submitted.Queued
        if (r is Submitted.Refused) doneHere[task.id] = null
        return r
    }

    /**
     * Clears a "done here" mark once the server shows the result, or once nothing for
     * that task is still waiting to be sent (it was refused, and the reason is kept in the outbox).
     */
    private fun settle(fromServer: List<TaskItem>) {
        val waiting = device.outbox.pending().map { it.path }
        for (t in fromServer) {
            if (doneHere[t.id] == null) continue
            if (t.state != "open" || waiting.none { it.startsWith("/device/tasks/${t.id}/") }) doneHere[t.id] = null
        }
    }

    /** Forgets the list when the guard logs out, so the next guard never sees someone else's tasks. */
    fun clear() {
        cache.delete()
    }

    companion object {
        val SAST: ZoneId = ZoneId.of("Africa/Johannesburg")
    }
}
