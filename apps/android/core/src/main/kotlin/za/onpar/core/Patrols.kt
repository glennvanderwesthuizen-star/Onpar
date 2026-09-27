package za.onpar.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.File
import java.security.MessageDigest
import java.time.Duration
import java.time.Instant
import java.util.UUID

/** A check at a patrol point (brief section 6.5): a number with a unit and limits, OK/Problem, or a photo. */
@Serializable
data class PatrolCheck(
    val id: String,
    val kind: String,
    val label: String,
    val unit: String? = null,
    val below: Double? = null,
    val above: Double? = null,
) {
    /** A reading below or above its limit raises an Amber report on the server; the phone warns first. */
    fun outOfLimit(value: Double?): Boolean = value != null && ((below != null && value < below) || (above != null && value > above))
}

@Serializable
data class PatrolPoint(
    val id: String,
    val name: String,
    val instruction: String = "",
    val photoMode: String = "off",
    val noteMode: String = "off",
    val checks: List<PatrolCheck> = emptyList(),
    val lat: Double? = null,
    val lng: Double? = null,
    val radiusM: Int? = null,
    /** A fingerprint of the point's QR code, so the phone recognises it with no signal without holding the code. */
    val qrHash: String? = null,
) {
    /** Nothing to record here: scanning it is enough. */
    val needsNothing: Boolean get() = photoMode != "required" && noteMode != "required" && checks.isEmpty()
}

@Serializable
data class PatrolType(
    val id: String,
    val code: String,
    val name: String,
    val singleScan: Boolean = false,
    val perShift: Int = 0,
    val minGapMinutes: Int = 0,
    val maxDurationMinutes: Int = 60,
    val done: Int = 0,
    val canStart: Boolean = false,
    val reason: String? = null,
    val opensAt: String? = null,
    val points: List<PatrolPoint> = emptyList(),
)

@Serializable
data class PatrolVisit(val id: String, val name: String, val scannedAt: String? = null, val doneAt: String? = null)

@Serializable
data class ActivePatrol(
    val id: String,
    val state: String,
    val startedAt: String? = null,
    val deadline: String? = null,
    val maxDurationMinutes: Int = 60,
    val typeName: String = "",
    val typeCode: String = "",
    val points: List<PatrolVisit> = emptyList(),
)

@Serializable
data class PatrolState(val onDuty: Boolean = false, val types: List<PatrolType> = emptyList(), val active: ActivePatrol? = null)

/** A GPS reading taken at the moment of a scan, and only then (brief section 9: no continuous tracking). */
data class Fix(val lat: Double, val lng: Double, val accuracyM: Double, val mock: Boolean = false)

/** What the guard sees after a scan. */
data class ScanOutcome(
    val accepted: Boolean?,
    val message: String,
    /** The point, when known, so its instruction and checks can be shown. */
    val point: PatrolPoint?,
    val patrolId: String?,
    val waiting: Boolean = false,
)

/** The patrol in progress, as this phone knows it: kept so it works (and counts down) with no signal. */
@Serializable
data class LocalPatrol(
    val id: String,
    val typeId: String,
    val typeName: String,
    val startedAt: String,
    val maxDurationMinutes: Int,
    val pointIds: List<String>,
    val scanned: Set<String> = emptySet(),
    val done: Set<String> = emptySet(),
) {
    fun deadline(): Instant = Instant.parse(startedAt).plus(Duration.ofMinutes(maxDurationMinutes.toLong()))
    val complete: Boolean get() = pointIds.isNotEmpty() && pointIds.all { it in done }
}

/** The GPS accuracy a scan needs (brief section 10). The server decides; the phone waits for it first. */
const val SCAN_ACCURACY_M = 25.0

/** Patrols on the phone (brief section 6.5; scenarios 2 to 7). */
class PatrolActions(private val device: OnParDevice, dataDir: File) {
    private val cacheFile = File(dataDir, "patrols.json")
    private val activeFile = File(dataDir, "patrol-active.json")

    /** From the server when online (and kept), otherwise the last state seen. */
    fun state(): PatrolState = try {
        val s = OnParJson.decodeFromJsonElement(PatrolState.serializer(), device.client().get("/device/patrols", device.requireGuard()))
        cacheFile.writeText(OnParJson.encodeToString(PatrolState.serializer(), s))
        reconcile(s)
        s
    } catch (e: OfflineException) {
        cached()
    }

    fun cached(): PatrolState = if (cacheFile.exists()) runCatching { OnParJson.decodeFromString(PatrolState.serializer(), cacheFile.readText()) }.getOrDefault(PatrolState()) else PatrolState()

    /** The patrol in progress on this phone, with its countdown, even with no signal. */
    fun active(): LocalPatrol? = if (activeFile.exists()) runCatching { OnParJson.decodeFromString(LocalPatrol.serializer(), activeFile.readText()) }.getOrNull() else null

    private fun save(p: LocalPatrol?) {
        if (p == null) activeFile.delete() else activeFile.writeText(OnParJson.encodeToString(LocalPatrol.serializer(), p))
    }

    /** The server's view wins once it has caught up (nothing about the patrol still waiting to be sent). */
    private fun reconcile(s: PatrolState) {
        val local = active()
        val waiting = device.outbox.pending().any { it.path.startsWith("/device/patrols/") }
        if (waiting) return
        val a = s.active
        if (a == null) {
            save(null)
            return
        }
        val type = s.types.firstOrNull { it.code == a.typeCode && it.name == a.typeName }
        save(
            LocalPatrol(
                id = a.id,
                typeId = type?.id ?: local?.typeId ?: "",
                typeName = a.typeName,
                startedAt = a.startedAt ?: Instant.now().toString(),
                maxDurationMinutes = a.maxDurationMinutes,
                pointIds = a.points.map { it.id },
                scanned = a.points.filter { it.scannedAt != null }.map { it.id }.toSet(),
                done = a.points.filter { it.doneAt != null }.map { it.id }.toSet(),
            ),
        )
    }

    /** The point a scanned code belongs to, recognised from its fingerprint. */
    fun pointFor(code: String, s: PatrolState = cached()): Pair<PatrolType, PatrolPoint>? {
        val h = sha256(code.trim())
        for (t in s.types) for (p in t.points) if (p.qrHash == h) return t to p
        return null
    }

    /**
     * A scan with the location taken at that moment. The first accepted scan of a
     * patrol starts it. With no signal it waits and is checked when sent.
     */
    fun scan(code: String, fix: Fix): ScanOutcome {
        require(!fix.mock) { "The location came from a fake-GPS app. Scans need the phone's real GPS." }
        val s = cached()
        val known = pointFor(code, s)
        val local = active()
        // Scanning a point of another patrol while one is in progress is refused by the server; say so first.
        if (local != null && known != null && known.first.id != local.typeId && local.typeId.isNotEmpty()) {
            return ScanOutcome(false, "That point belongs to another patrol. Finish ${local.typeName} first.", null, local.id)
        }
        val patrolId = local?.id ?: UUID.randomUUID().toString()
        val eventId = UUID.randomUUID().toString()
        val body = buildJsonObject {
            put("eventId", eventId)
            put("patrolId", patrolId)
            put("qrCode", code.trim())
            put("lat", fix.lat)
            put("lng", fix.lng)
            put("accuracyM", fix.accuracyM)
            put("trustedAt", device.clock.now().toString())
            put("deviceClock", device.clock.deviceClock().toString())
        }
        val label = "Patrol scan${known?.let { ": ${it.second.name}" } ?: ""}"
        return when (val r = device.outbox.submit(device.client(), eventId, label, "/device/patrols/scan", body, device.requireGuard())) {
            is Submitted.Sent -> fromReply(r.reply as JsonObject, known, patrolId)
            is Submitted.Refused -> ScanOutcome(false, r.message, null, local?.id)
            Submitted.Queued -> {
                // No signal: carry on with the patrol on the phone; the server checks the scan when it arrives.
                if (known != null) {
                    val (t, p) = known
                    val started = local ?: LocalPatrol(patrolId, t.id, t.name, device.clock.now().toString(), t.maxDurationMinutes, t.points.map { it.id })
                    save(started.copy(scanned = started.scanned + p.id, done = if (p.needsNothing) started.done + p.id else started.done))
                }
                ScanOutcome(null, "Saved on the phone. The scan will be checked when there is signal.", known?.second, patrolId, waiting = true)
            }
        }
    }

    private fun fromReply(r: JsonObject, known: Pair<PatrolType, PatrolPoint>?, patrolId: String): ScanOutcome {
        val accepted = (r["accepted"] as? JsonPrimitive)?.content == "true"
        val message = (r["message"] as? JsonPrimitive)?.content ?: if (accepted) "Accepted" else "Rejected"
        val patrol = (r["patrol"] as? JsonObject)?.let { OnParJson.decodeFromJsonElement(ActivePatrol.serializer(), it) }
        if (patrol != null && patrol.state == "active") {
            val t = known?.first ?: cached().types.firstOrNull { it.code == patrol.typeCode }
            save(
                LocalPatrol(
                    patrol.id, t?.id ?: "", patrol.typeName, patrol.startedAt ?: device.clock.now().toString(), patrol.maxDurationMinutes,
                    patrol.points.map { it.id },
                    patrol.points.filter { it.scannedAt != null }.map { it.id }.toSet(),
                    patrol.points.filter { it.doneAt != null }.map { it.id }.toSet(),
                ),
            )
        } else if (patrol != null) {
            save(null) // completed (a single-scan patrol, for example)
        }
        val opens = (r["opensAt"] as? JsonPrimitive)?.content
        val point = known?.second ?: (r["point"] as? JsonObject)?.let { OnParJson.decodeFromJsonElement(PatrolPoint.serializer(), it) }
        return ScanOutcome(accepted, if (opens != null && !accepted) "$message" else message, if (accepted) point else null, patrol?.id ?: patrolId)
    }

    /**
     * What was found at a point: note, photo, readings and photo checks. Everything the
     * point requires must be there. An out-of-limit reading or a Problem raises a report.
     */
    fun saveChecks(patrolId: String, point: PatrolPoint, note: String, photo: File?, numbers: Map<String, Double>, oks: Map<String, Boolean>, checkPhotos: Map<String, File>): Submitted {
        require(point.photoMode != "required" || photo.exists()) { "Take the photo for ${point.name}." }
        require(point.noteMode != "required" || note.isNotBlank()) { "Add the note for ${point.name}." }
        for (c in point.checks) when (c.kind) {
            "number" -> require(numbers[c.id] != null) { "Enter ${c.label}." }
            "ok_problem" -> require(oks[c.id] != null) { "Say whether ${c.label} is OK." }
            "photo" -> require(checkPhotos[c.id].exists()) { "Take the photo: ${c.label}." }
        }
        val eventId = UUID.randomUUID().toString()
        val readings = point.checks.filter { it.kind != "photo" }.map { c ->
            buildJsonObject {
                put("checkId", c.id)
                numbers[c.id]?.let { put("value", it) }
                oks[c.id]?.let { put("ok", it) }
            }
        }
        val body = buildJsonObject {
            put("eventId", eventId)
            put("note", note.trim())
            put("readings", JsonArray(readings))
            put("trustedAt", device.clock.now().toString())
            put("deviceClock", device.clock.deviceClock().toString())
        }
        val files = buildList {
            if (photo.exists()) add(Upload("photo", photo!!, "image/jpeg"))
            for ((id, f) in checkPhotos) if (f.exists()) add(Upload("check_$id", f, "image/jpeg"))
        }
        device.outbox.add(eventId, "Patrol point: ${point.name}", "/device/patrols/$patrolId/points/${point.id}", body, device.requireGuard(), files)
        active()?.takeIf { it.id == patrolId }?.let { save(it.copy(done = it.done + point.id)) }
        val r = device.sync()[eventId] ?: Submitted.Queued
        when (r) {
            is Submitted.Refused -> active()?.takeIf { it.id == patrolId }?.let { save(it.copy(done = it.done - point.id)) }
            is Submitted.Sent -> (r.reply as? JsonObject)?.let { reply ->
                val state = (reply["state"] as? JsonPrimitive)?.content
                if (state != null && state != "active") save(null)
            }
            Submitted.Queued -> Unit
        }
        if (active()?.complete == true && device.outbox.pending().isEmpty()) save(null)
        return r
    }

    /** The guard cannot finish: "ended early" with a reason. No penalty until a supervisor reviews it. */
    fun cannotFinish(patrolId: String, reason: String): Submitted {
        require(reason.trim().length >= 3) { "Say why the patrol could not be finished." }
        val eventId = UUID.randomUUID().toString()
        val body = buildJsonObject {
            put("reason", reason.trim())
            put("trustedAt", device.clock.now().toString())
            put("deviceClock", device.clock.deviceClock().toString())
        }
        val r = device.outbox.submit(device.client(), eventId, "Patrol ended early", "/device/patrols/$patrolId/cannot-finish", body, device.requireGuard())
        if (r !is Submitted.Refused) save(null)
        return r
    }

    /** Forgets patrol data when the guard logs out. */
    fun clear() {
        cacheFile.delete()
        activeFile.delete()
    }

    private fun File?.exists(): Boolean = this != null && this.isFile && this.length() > 0

    companion object {
        fun sha256(s: String): String = MessageDigest.getInstance("SHA-256").digest(s.toByteArray()).joinToString("") { "%02x".format(it) }
    }
}
