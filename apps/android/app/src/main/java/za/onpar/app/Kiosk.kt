package za.onpar.app

import android.app.Activity
import android.app.ActivityManager
import android.app.admin.DevicePolicyManager
import android.app.role.RoleManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager

/**
 * Kiosk mode (brief section 6.10): the phone boots into On Par and the guard cannot reach
 * anything else. The phone-management system (MDM) allows On Par to lock itself; the app
 * then locks on start and becomes the home screen. Nothing here is specific to a phone brand.
 */
object Kiosk {
    /** Allowed by the phone-management system to lock itself to the screen. */
    fun permitted(context: Context): Boolean =
        (context.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager).isLockTaskPermitted(context.packageName)

    fun locked(context: Context): Boolean =
        (context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager).lockTaskModeState != ActivityManager.LOCK_TASK_MODE_NONE

    /** For the Devices page: locked, allowed but not locked yet, or not managed (a test phone). */
    fun status(context: Context): String = when {
        locked(context) -> "locked"
        permitted(context) -> "permitted"
        else -> "not_managed"
    }

    /** Locks the screen to On Par when allowed, and makes On Par the home screen on managed phones. */
    fun enter(activity: Activity) {
        if (!permitted(activity)) return
        setHome(activity, true)
        if (!locked(activity)) runCatching { activity.startLockTask() }
    }

    private fun setHome(context: Context, on: Boolean) {
        val alias = ComponentName(context, "za.onpar.app.KioskHome")
        val state = if (on) PackageManager.COMPONENT_ENABLED_STATE_ENABLED else PackageManager.COMPONENT_ENABLED_STATE_DISABLED
        if (context.packageManager.getComponentEnabledSetting(alias) != state) {
            context.packageManager.setComponentEnabledSetting(alias, state, PackageManager.DONT_KILL_APP)
        }
    }

    /** Whether On Par is the phone's calling app (needed to keep calls inside On Par). */
    fun isCallingApp(context: Context): Boolean =
        (context.getSystemService(Context.ROLE_SERVICE) as RoleManager).isRoleHeld(RoleManager.ROLE_DIALER)

    /** Asks Android to make On Par the calling app. On managed phones the MDM can do this instead. */
    fun callingAppRequest(context: Context): Intent =
        (context.getSystemService(Context.ROLE_SERVICE) as RoleManager).createRequestRoleIntent(RoleManager.ROLE_DIALER)
}
