package za.onpar.app

import android.app.Application
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import za.onpar.core.ApiException
import za.onpar.core.DeviceSetup
import za.onpar.core.DutyKind
import za.onpar.core.GuardState
import za.onpar.core.OfflineException
import za.onpar.core.PendingDeclaration
import java.io.File
import za.onpar.core.Submitted
import za.onpar.core.TaskItem
import za.onpar.core.LocalPatrol
import za.onpar.core.PatrolState
import za.onpar.app.ui.takeFix

enum class Screen { Setup, Login, Home }

/** Where the guard is within the app once logged in. */
sealed interface Page {
    data object Home : Page
    data object Tasks : Page
    data class Task(val id: String) : Page
    data object Patrols : Page
    data object PatrolScan : Page
    data class PatrolPoint(val patrolId: String, val point: za.onpar.core.PatrolPoint) : Page
}

data class UiState(
    val screen: Screen,
    val guardName: String? = null,
    val home: GuardState? = null,
    /** A Duty On or Duty From declaration still owed: shown before anything else. */
    val owed: PendingDeclaration? = null,
    val page: Page = Page.Home,
    val tasks: List<TaskItem> = emptyList(),
    val patrols: PatrolState? = null,
    val activePatrol: LocalPatrol? = null,
    /** While a scan waits for an accurate GPS reading: the accuracy so far, in metres. */
    val gpsAccuracy: Double? = null,
    val online: Boolean = true,
    val waiting: Int = 0,
    val busy: Boolean = false,
    val message: String? = null,
    val error: String? = null,
)

/** The screens' state. All server work runs off the main thread, through the core logic. */
class AppViewModel(app: Application) : AndroidViewModel(app) {
    private val device = (app as OnParApp).device
    private val version = runCatching { app.packageManager.getPackageInfo(app.packageName, 0).versionName }.getOrNull() ?: "dev"

    private val _state = MutableStateFlow(initial())
    val state: StateFlow<UiState> = _state.asStateFlow()

    init {
        // Every minute: check in, send anything waiting, refresh the home screen.
        viewModelScope.launch {
            while (isActive) {
                background()
                delay(60_000)
            }
        }
    }

    private fun initial() = UiState(
        screen = when {
            device.setup == null -> Screen.Setup
            device.guardToken == null -> Screen.Login
            else -> Screen.Home
        },
        guardName = device.guardName,
        waiting = device.outbox.pending().size,
    )

    private suspend fun background() = withContext(Dispatchers.IO) {
        if (device.setup == null) return@withContext
        val online = runCatching { device.heartbeat(version, battery(), "unlocked") }.isSuccess
        runCatching { device.sync() }
        _state.update { it.copy(online = online, waiting = device.outbox.pending().size) }
        if (online && device.guardToken != null) refreshHome()
    }

    private suspend fun refreshHome() = withContext(Dispatchers.IO) {
        try {
            val s = device.state()
            _state.update { it.copy(home = s, online = true, owed = device.owedDeclaration(s)) }
        } catch (e: ApiException) {
            if (e.unauthorised) signOut() else _state.update { it.copy(error = e.message) }
        } catch (e: OfflineException) {
            _state.update { it.copy(online = false, owed = device.owedDeclaration(null)) }
        }
    }

    private fun battery(): Int? {
        val i: Intent? = getApplication<Application>().registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val level = i?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
        val scale = i?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
        return if (level >= 0 && scale > 0) level * 100 / scale else null
    }

    /** Runs work with the busy indicator, turning failures into a message the guard can read. */
    private fun run(work: suspend () -> Unit) {
        viewModelScope.launch {
            _state.update { it.copy(busy = true, error = null, message = null) }
            try {
                withContext(Dispatchers.IO) { work() }
            } catch (e: ApiException) {
                _state.update { it.copy(error = e.message) }
            } catch (e: OfflineException) {
                _state.update { it.copy(error = "No signal. Try again when the phone has signal.", online = false) }
            } finally {
                _state.update { it.copy(busy = false, waiting = device.outbox.pending().size) }
            }
        }
    }

    fun dismiss() = _state.update { it.copy(message = null, error = null) }

    // --- Setup ---------------------------------------------------------------

    /** From the QR code on the Devices page. Returns false if the code is not an On Par setup code. */
    fun setupFromQr(text: String): Boolean {
        val s = DeviceSetup.fromQr(text) ?: return false
        run {
            device.applySetup(s)
            _state.update { it.copy(screen = Screen.Login, message = "Phone set up. Officers can now log in.") }
        }
        return true
    }

    fun setupManually(server: String, key: String) {
        val url = server.trim().trimEnd('/')
        if (!DeviceSetup.validServer(url)) {
            _state.update { it.copy(error = "Enter the server address starting with https://") }
            return
        }
        if (key.trim().length < 20) {
            _state.update { it.copy(error = "Enter the device key exactly as shown when the device was registered.") }
            return
        }
        run {
            device.applySetup(DeviceSetup(url, key.trim()))
            _state.update { it.copy(screen = Screen.Login, message = "Phone set up. Officers can now log in.") }
        }
    }

    // --- Sign in -------------------------------------------------------------

    fun signIn(employeeNumber: String, pin: String) = run {
        val e = device.signIn(employeeNumber, pin)
        _state.update { it.copy(screen = Screen.Home, guardName = e.name) }
        refreshHome()
    }

    fun signOut() {
        device.signOut()
        _state.update { it.copy(screen = Screen.Login, guardName = null, home = null, page = Page.Home, tasks = emptyList()) }
    }

    fun go(page: Page) {
        _state.update { it.copy(page = page, error = null, message = null) }
        if (page == Page.Tasks) loadTasks()
        if (page == Page.Patrols) loadPatrols()
    }

    // --- Patrols -------------------------------------------------------------

    fun loadPatrols() = run {
        val s = device.patrols.state()
        _state.update { it.copy(patrols = s, activePatrol = device.patrols.active()) }
    }

    /** A code was read: take one GPS reading now, then send the scan. */
    fun scanCode(code: String) = run {
        _state.update { it.copy(gpsAccuracy = -1.0) }
        val fix = try {
            takeFix(getApplication()) { acc -> _state.update { it.copy(gpsAccuracy = acc) } }
        } finally {
            _state.update { it.copy(gpsAccuracy = null) }
        }
        if (fix == null) {
            _state.update { it.copy(error = "No GPS reading. Turn on location, stand in the open and scan again.") }
            return@run
        }
        try {
            val out = device.patrols.scan(code, fix)
            val next = when {
                out.point != null && out.patrolId != null && out.accepted != false && !out.point!!.needsNothing -> Page.PatrolPoint(out.patrolId!!, out.point!!)
                else -> Page.Patrols
            }
            val text = if (out.accepted == true && out.point != null) "${out.point!!.name}: accepted." else out.message
            _state.update {
                it.copy(
                    page = next,
                    message = if (out.accepted != false) text else null,
                    error = if (out.accepted == false) text else null,
                    activePatrol = device.patrols.active(),
                    patrols = device.patrols.cached(),
                )
            }
        } catch (e: IllegalArgumentException) {
            _state.update { it.copy(error = e.message) }
        }
    }

    fun savePoint(patrolId: String, point: za.onpar.core.PatrolPoint, note: String, photo: File?, numbers: Map<String, Double>, oks: Map<String, Boolean>, checkPhotos: Map<String, File>) = run {
        try {
            val r = device.patrols.saveChecks(patrolId, point, note, photo, numbers, oks, checkPhotos)
            if (r !is Submitted.Refused) {
                photo?.delete()
                checkPhotos.values.forEach { it.delete() }
            }
            val done = device.patrols.active() == null
            _state.update {
                when (r) {
                    is Submitted.Refused -> it.copy(error = r.message)
                    else -> it.copy(
                        page = Page.Patrols,
                        message = when {
                            r is Submitted.Queued -> "${point.name} saved on the phone. It will be sent when there is signal."
                            done -> "Patrol complete. Well done."
                            else -> "${point.name} done. Scan the next point."
                        },
                        activePatrol = device.patrols.active(),
                    )
                }
            }
            if (r is Submitted.Sent) loadPatrols()
        } catch (e: IllegalArgumentException) {
            _state.update { it.copy(error = e.message) }
        }
    }

    fun endPatrolEarly(patrolId: String, reason: String) = run {
        try {
            when (val r = device.patrols.cannotFinish(patrolId, reason)) {
                is Submitted.Refused -> _state.update { it.copy(error = r.message) }
                else -> _state.update { it.copy(message = "Patrol ended early. Your supervisor will review it.", activePatrol = null, page = Page.Patrols) }
            }
        } catch (e: IllegalArgumentException) {
            _state.update { it.copy(error = e.message) }
        }
    }

    // --- Tasks ---------------------------------------------------------------

    fun loadTasks() = run {
        val list = device.tasks.today()
        _state.update { it.copy(tasks = list) }
    }

    private fun afterTask(r: Submitted, done: String) {
        when (r) {
            is Submitted.Refused -> _state.update { it.copy(error = r.message) }
            is Submitted.Sent -> _state.update { it.copy(message = done, page = Page.Tasks) }
            is Submitted.Queued -> _state.update { it.copy(message = "$done Saved on the phone; it will be sent when there is signal.", page = Page.Tasks) }
        }
        _state.update { it.copy(tasks = device.tasks.today()) }
    }

    fun completeTask(task: TaskItem, comment: String, photo: File?) = run {
        try {
            val r = device.tasks.complete(task, comment, photo)
            if (r !is Submitted.Refused) photo?.delete()
            afterTask(r, "Task done.")
        } catch (e: IllegalArgumentException) {
            _state.update { it.copy(error = e.message) }
        }
    }

    fun cannotCompleteTask(task: TaskItem, reason: String, comment: String, photo: File?) = run {
        try {
            val r = device.tasks.cannotComplete(task, reason, comment, photo)
            if (r !is Submitted.Refused) photo?.delete()
            afterTask(r, "Recorded. Your supervisor will review it; there is no penalty until then.")
        } catch (e: IllegalArgumentException) {
            _state.update { it.copy(error = e.message) }
        }
    }

    // --- Duty ----------------------------------------------------------------

    fun duty(kind: DutyKind, pin: String) = run {
        val (_, r) = device.duty(kind, pin)
        when (r) {
            is Submitted.Sent -> {
                _state.update { it.copy(message = "${kind.label} recorded.") }
                refreshHome()
            }
            is Submitted.Queued -> _state.update {
                it.copy(message = "${kind.label} saved on the phone. It will be sent when there is signal.", owed = device.owedDeclaration(null))
            }
            is Submitted.Refused -> _state.update { it.copy(error = r.message) }
        }
    }

    fun declare(owed: PendingDeclaration, accepted: List<Boolean>, comment: String, report: Boolean, priority: String, selfie: File) = run {
        try {
            val r = device.declare(owed, accepted, comment, report, priority, selfie)
            when (r) {
                is Submitted.Refused -> _state.update { it.copy(error = r.message) }
                else -> {
                    selfie.delete() // the outbox keeps its own copy until sent
                    _state.update {
                        it.copy(
                            owed = null,
                            message = if (r is Submitted.Sent) "Declaration saved. Thank you." else "Declaration saved on the phone. It will be sent when there is signal.",
                        )
                    }
                    refreshHome()
                }
            }
        } catch (e: IllegalArgumentException) {
            _state.update { it.copy(error = e.message) }
        }
    }

    fun refresh() = run { background() }
}
