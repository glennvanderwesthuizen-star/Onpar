package za.onpar.app

import android.content.Intent
import android.telecom.Call
import android.telecom.InCallService
import android.telecom.VideoProfile
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** A call as the guard sees it inside On Par (brief section 6.10: call, answer, decline, end). */
data class CallInfo(val number: String, val incoming: Boolean, val state: Int) {
    val ringing: Boolean get() = state == Call.STATE_RINGING
    val active: Boolean get() = state == Call.STATE_ACTIVE
}

/** The current call, shared between the phone system and the screens. */
object Calls {
    private var call: Call? = null
    private val _current = MutableStateFlow<CallInfo?>(null)
    val current: StateFlow<CallInfo?> = _current.asStateFlow()

    private val callback = object : Call.Callback() {
        override fun onStateChanged(c: Call, state: Int) = publish(c)
    }

    internal fun added(c: Call) {
        call = c
        c.registerCallback(callback)
        publish(c)
    }

    internal fun removed(c: Call) {
        c.unregisterCallback(callback)
        if (call == c) {
            call = null
            _current.value = null
        }
    }

    private fun publish(c: Call) {
        val number = c.details?.handle?.schemeSpecificPart.orEmpty()
        @Suppress("DEPRECATION") val state = c.state
        _current.value = CallInfo(number, c.details?.callDirection == Call.Details.DIRECTION_INCOMING, state)
    }

    fun answer() = call?.answer(VideoProfile.STATE_AUDIO_ONLY)
    fun decline() = call?.reject(false, null)
    fun end() = call?.disconnect()
}

/**
 * When On Par is the phone's calling app, Android hands every call to this service,
 * so calls are answered and ended inside On Par and never open the normal phone app
 * (which would let the guard out of kiosk mode). Needs to be proven on each phone model
 * in the hardware test (Milestone 0).
 */
class OnParInCallService : InCallService() {
    override fun onCallAdded(call: Call) {
        Calls.added(call)
        startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT))
    }

    override fun onCallRemoved(call: Call) = Calls.removed(call)
}
