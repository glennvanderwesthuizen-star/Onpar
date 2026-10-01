package za.onpar.app.ui

import android.Manifest
import android.annotation.SuppressLint
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat
import android.content.Context
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Looper
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import za.onpar.core.Fix
import za.onpar.core.SCAN_ACCURACY_M
import kotlin.coroutines.resume

/**
 * One GPS reading for a scan, taken only now (brief section 9: no continuous tracking).
 * Listens until the fix is accurate to 25 m or the time runs out, reporting progress,
 * then stops listening. Uses the phone's own GPS, not Google services.
 */
@SuppressLint("MissingPermission")
suspend fun takeFix(context: Context, timeoutMs: Long = 30_000, progress: (Double?) -> Unit): Fix? {
    if (ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) return null
    val lm = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
    if (!lm.isProviderEnabled(LocationManager.GPS_PROVIDER)) return null
    var best: Location? = null
    var listener: LocationListener? = null
    val good = withTimeoutOrNull(timeoutMs) {
        suspendCancellableCoroutine<Location> { cont ->
            val l = LocationListener { loc ->
                if (best == null || loc.accuracy < best!!.accuracy) best = loc
                progress(loc.accuracy.toDouble())
                if (loc.accuracy <= SCAN_ACCURACY_M && cont.isActive) cont.resume(loc)
            }
            listener = l
            lm.requestLocationUpdates(LocationManager.GPS_PROVIDER, 0L, 0f, l, Looper.getMainLooper())
            cont.invokeOnCancellation { lm.removeUpdates(l) }
        }
    }
    listener?.let { lm.removeUpdates(it) }
    val loc = good ?: best ?: return null
    val mock = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) loc.isMock else @Suppress("DEPRECATION") loc.isFromMockProvider
    return Fix(loc.latitude, loc.longitude, loc.accuracy.toDouble(), mock)
}
