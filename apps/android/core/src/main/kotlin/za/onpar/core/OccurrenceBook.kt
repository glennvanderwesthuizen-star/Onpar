package za.onpar.core

import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.util.UUID

/**
 * A guard writes in the Occurrence Book from the post phone (owner, 9 Oct 2026, D-51). It waits
 * on the phone with no signal and keeps the time it was written. An entry is never changed.
 */
class OccurrenceBookActions(private val device: OnParDevice) {
    fun write(text: String): Submitted {
        val t = text.trim()
        require(t.length >= 3) { "Write what happened." }
        require(t.length <= 2000) { "Keep the entry under 2,000 characters." }
        val eventId = UUID.randomUUID().toString()
        val body = buildJsonObject {
            put("eventId", eventId)
            put("text", t)
            put("trustedAt", device.clock.now().toString())
            put("deviceClock", device.clock.deviceClock().toString())
        }
        return device.outbox.submit(device.client(), eventId, "Occurrence Book entry", "/device/occurrence-book", body, device.requireGuard())
    }
}
