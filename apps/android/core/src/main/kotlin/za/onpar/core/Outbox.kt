package za.onpar.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import java.io.File
import java.time.Instant

/**
 * One guard action waiting to reach the server. Each carries its own event ID, so
 * sending it twice (for example after a dropped connection) never duplicates it.
 */
@Serializable
data class OutboxItem(
    val eventId: String,
    /** Shown to the guard while it waits, for example "Duty On" or "Patrol scan". */
    val label: String,
    val path: String,
    val body: JsonElement,
    val files: List<OutboxFile> = emptyList(),
    val guardToken: String? = null,
    val createdAt: String,
    val attempts: Int = 0,
    val lastError: String? = null,
)

@Serializable
data class OutboxFile(val field: String, val path: String, val contentType: String)

/** What happened when an action was handed to the outbox. */
sealed interface Submitted {
    /** Reached the server; here is its reply. */
    data class Sent(val reply: JsonElement) : Submitted
    /** No signal (or server trouble): saved on the phone, and it will be sent later. */
    data object Queued : Submitted
    /** The server refused it; the message says why. It will not be retried. */
    data class Refused(val message: String, val errors: Map<String, String>) : Submitted
}

/**
 * The offline outbox (brief section 8). Actions are written to the phone's storage
 * first, then sent in the order they happened. Server trouble keeps them for later;
 * a refusal moves them to `failed/` with the reason, so nothing is silently lost.
 * Photos are copied in, so they survive until sent (photos are sent last, as the
 * server allows a selfie to follow its declaration).
 */
class Outbox(private val dir: File, private val clock: TrustedClock) {
    private val failedDir = File(dir, "failed")
    private val filesDir = File(dir, "files")

    init {
        dir.mkdirs()
        failedDir.mkdirs()
        filesDir.mkdirs()
    }

    @Synchronized
    fun pending(): List<OutboxItem> = itemFiles(dir).map { OnParJson.decodeFromString(OutboxItem.serializer(), it.readText()) }

    @Synchronized
    fun failed(): List<OutboxItem> = itemFiles(failedDir).map { OnParJson.decodeFromString(OutboxItem.serializer(), it.readText()) }

    /** Saves an action. Photos are copied into the outbox. An urgent one (a panic) is sent before everything else waiting. */
    @Synchronized
    fun add(eventId: String, label: String, path: String, body: JsonElement, guardToken: String?, files: List<Upload> = emptyList(), urgent: Boolean = false): OutboxItem {
        // The folders come back if the phone's storage was cleared while the app ran.
        listOf(dir, failedDir, filesDir).forEach { it.mkdirs() }
        val kept = files.map { f ->
            val copy = File(filesDir, "$eventId-${f.field}-${f.file.name}")
            f.file.copyTo(copy, overwrite = true)
            OutboxFile(f.field, copy.absolutePath, f.contentType)
        }
        val item = OutboxItem(eventId, label, path, body, kept, guardToken, Instant.now().toString())
        // A saved sequence number in the name keeps the order in which things happened, across restarts.
        // "!" sorts before any digit, so urgent items go first (in their own order).
        val name = (if (urgent) "!" else "") + "%019d-%s.json".format(nextSequence(), eventId)
        write(File(dir, name), item)
        return item
    }

    /** Saves the action and tries to send everything waiting, this one included. */
    fun submit(api: ApiClient, eventId: String, label: String, path: String, body: JsonElement, guardToken: String?, files: List<Upload> = emptyList()): Submitted {
        add(eventId, label, path, body, guardToken, files)
        val results = flush(api)
        return results[eventId] ?: Submitted.Queued
    }

    /**
     * Sends waiting actions in order. Stops at the first sign of no signal or server
     * trouble, so later actions never overtake earlier ones.
     */
    @Synchronized
    fun flush(api: ApiClient): Map<String, Submitted> {
        val out = mutableMapOf<String, Submitted>()
        for (file in itemFiles(dir)) {
            val item = OnParJson.decodeFromString(OutboxItem.serializer(), file.readText())
            try {
                val reply = if (item.files.isEmpty()) {
                    api.post(item.path, item.body, item.guardToken)
                } else {
                    api.postMultipart(item.path, item.body, item.files.map { Upload(it.field, File(it.path), it.contentType) }, item.guardToken)
                }
                file.delete()
                item.files.forEach { File(it.path).delete() }
                out[item.eventId] = Submitted.Sent(reply)
            } catch (e: OfflineException) {
                write(file, item.copy(attempts = item.attempts + 1, lastError = e.message))
                break
            } catch (e: ApiException) {
                if (e.retryable) {
                    write(file, item.copy(attempts = item.attempts + 1, lastError = e.message))
                    break
                }
                write(File(failedDir, file.name), item.copy(attempts = item.attempts + 1, lastError = e.message))
                file.delete()
                out[item.eventId] = Submitted.Refused(e.message, e.errors)
            }
        }
        return out
    }

    private fun nextSequence(): Long {
        val f = File(dir, "sequence")
        val n = (f.takeIf { it.exists() }?.readText()?.trim()?.toLongOrNull() ?: 0L) + 1
        f.writeText(n.toString())
        return n
    }

    private fun itemFiles(d: File): List<File> = d.listFiles { f -> f.isFile && f.name.endsWith(".json") }?.sortedBy { it.name } ?: emptyList()

    private fun write(f: File, item: OutboxItem) {
        val tmp = File(f.parentFile, f.name + ".tmp")
        tmp.writeText(OnParJson.encodeToString(OutboxItem.serializer(), item))
        tmp.renameTo(f)
    }
}
