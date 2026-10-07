package za.onpar.core

import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.File
import java.util.UUID

/** How long PANIC must be held, so a brush against the screen does not raise one. */
const val PANIC_HOLD_MS = 2_000L

/** How long the phone waits for a location before sending the panic without one. */
const val PANIC_FIX_TIMEOUT_MS = 8_000L

/**
 * Panic and BOLO (owner's decisions D-27, D-28). Both work with nobody signed in; when
 * a guard is signed in on this phone, the server records who it was.
 */
class AlertActions(private val device: OnParDevice) {

    /**
     * Raises a panic. The location is the one taken at this moment, or none if the phone
     * could not get one in time. It is sent straight away, ahead of anything else waiting;
     * with no signal it waits in the outbox, at the front, and is sent first when signal returns.
     */
    fun panic(fix: Fix?, callStarted: Boolean, eventId: String = UUID.randomUUID().toString()): Submitted {
        val body = buildJsonObject {
            put("eventId", eventId)
            put("trustedAt", device.clock.now().toString())
            put("deviceClock", device.clock.deviceClock().toString())
            if (fix != null) {
                put("lat", fix.lat)
                put("lng", fix.lng)
                put("accuracyM", fix.accuracyM)
                put("mock", fix.mock)
            }
            put("callStarted", callStarted)
        }
        val token = device.guardToken
        return try {
            Submitted.Sent(device.client().post("/device/panic", body, token))
        } catch (e: OfflineException) {
            device.outbox.add(eventId, "PANIC", "/device/panic", body, token, urgent = true)
            Submitted.Queued
        } catch (e: ApiException) {
            if (!e.retryable) return Submitted.Refused(e.message, e.errors)
            device.outbox.add(eventId, "PANIC", "/device/panic", body, token, urgent = true)
            Submitted.Queued
        }
    }

    /**
     * Records that the guard tapped a number on the emergency panel (the phone itself dials).
     * `kind` is the contact's kind; `panicId` is the panic it followed, if any. Works offline.
     */
    fun emergencyCall(kind: String, panicId: String?): Submitted {
        val eventId = UUID.randomUUID().toString()
        val body = buildJsonObject {
            put("eventId", eventId)
            put("kind", kind)
            if (panicId != null) put("panicId", panicId)
            put("trustedAt", device.clock.now().toString())
            put("deviceClock", device.clock.deviceClock().toString())
        }
        return device.outbox.submit(device.client(), eventId, "Emergency call", "/device/emergency-calls", body, device.guardToken)
    }

    /**
     * A BOLO: any of a photo, a short video (up to 30 seconds), a voice note and a written
     * note, sent together. Works offline through the outbox.
     */
    fun bolo(note: String, photo: File?, voice: File? = null, video: File? = null): Submitted {
        val usable = { f: File? -> f?.takeIf { it.exists() && it.length() > 0 } }
        val files = listOfNotNull(
            usable(photo)?.let { Upload("photo", it, "image/jpeg") },
            usable(voice)?.let { Upload("voice", it, "audio/mp4") },
            usable(video)?.let { Upload("video", it, "video/mp4") },
        )
        require(files.isNotEmpty() || note.trim().length >= 3) { "Add a photo, a video, a voice note or a written note." }
        val eventId = UUID.randomUUID().toString()
        val body = buildJsonObject {
            put("eventId", eventId)
            put("note", note.trim())
            put("trustedAt", device.clock.now().toString())
            put("deviceClock", device.clock.deviceClock().toString())
        }
        return device.outbox.submit(device.client(), eventId, "BOLO", "/device/bolo", body, device.guardToken, files)
    }
}
