package za.onpar.core

import java.time.Duration
import java.time.Instant

/**
 * Time the guard cannot change (brief section 8): the last time the server told us,
 * plus the time elapsed since on the phone's monotonic clock (which does not move
 * when someone changes the phone's date). Until the first contact it falls back to
 * the phone's clock, and the server flags any drift.
 */
class TrustedClock(
    private val elapsedNanos: () -> Long = System::nanoTime,
    private val wallClock: () -> Instant = Instant::now,
) {
    private var anchor: Pair<Instant, Long>? = null

    /** Called with the server time from every reply that carries one. */
    @Synchronized
    fun sync(serverTime: Instant) {
        anchor = serverTime to elapsedNanos()
    }

    @get:Synchronized
    val isSynced: Boolean get() = anchor != null

    @Synchronized
    fun now(): Instant {
        val a = anchor ?: return wallClock()
        return a.first.plus(Duration.ofNanos(elapsedNanos() - a.second))
    }

    /** The phone's own clock, sent alongside so the server can spot a wrong phone clock. */
    fun deviceClock(): Instant = wallClock()
}
