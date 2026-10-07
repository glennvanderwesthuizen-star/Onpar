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
import za.onpar.core.ReportItem
import za.onpar.core.ReorderItem
import za.onpar.core.IssuedItem
import za.onpar.core.Score
import za.onpar.core.ScoreEvent
import za.onpar.core.Qualification
import za.onpar.core.Contact
import za.onpar.core.LocalPatrol
import za.onpar.core.PatrolState
import za.onpar.app.ui.takeFix
import za.onpar.core.PANIC_FIX_TIMEOUT_MS

enum class Screen { Setup, Login, Home }

/** Where the guard is within the app once logged in. */
sealed interface Page {
    data object Home : Page
    data object Tasks : Page
    data class Task(val id: String) : Page
    data object Patrols : Page
    data object PatrolScan : Page
    data class PatrolPoint(val patrolId: String, val point: za.onpar.core.PatrolPoint) : Page
    data object Reports : Page
    data object NewReport : Page
    data class Report(val id: String) : Page
    data object Reorders : Page
    data object NewReorder : Page
    data object Score : Page
    data object Training : Page
    data object Roster : Page
    /** The gate's visitors (visitor management). Only on a phone set up as a gate phone. */
    data object Visitors : Page
    data object NewVisitor : Page
    /** "Are you expected?": look an announced visitor up before scanning them in. */
    data object ExpectedVisitor : Page
    /** One visitor: waiting for the customer's answer, the phone call, and how it ended. */
    data class Visit(val id: String) : Page
    /** A visitor leaving: the exit scan, the entry record, and any exception. */
    data object VisitorExit : Page
    /** Everyone on site now, overstays first. */
    data object OnSite : Page
    /** The outgoing gate guard hands the visitors on site over to the next shift. */
    data object Handover : Page
    data object Uniform : Page
    data object Call : Page
    /** ID card (TSF number) and PIN, from the front screen. */
    data object SignIn : Page
    data object Bolo : Page
    /** What happened after PANIC was held. */
    data object PanicSent : Page
}

enum class PanicStage { Sending, Sent, Saved, Refused }

/** The panic just raised on this phone, as shown to the guard. */
data class PanicStatus(
    val stage: PanicStage,
    /** Why the phone could not call the control room, if it could not. */
    val callProblem: String? = null,
    val located: Boolean = false,
    val refusal: String? = null,
    val controlRoom: Contact? = null,
)

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
    val reports: List<ReportItem> = emptyList(),
    val reorders: List<ReorderItem> = emptyList(),
    val kit: List<IssuedItem> = emptyList(),
    /** Actions waiting on the phone to be sent, by label. */
    val waitingLabels: List<String> = emptyList(),
    val score: Score? = null,
    val training: List<Qualification> = emptyList(),
    val roster: za.onpar.core.GuardRoster? = null,
    val uniform: za.onpar.core.UniformState? = null,
    val contacts: List<Contact> = emptyList(),
    /** The gate this phone stands at and what it needs to scan visitors in; its `gate` is null on an ordinary post phone. */
    val gate: za.onpar.core.GateSetup? = null,
    val visits: List<za.onpar.core.VisitRow> = emptyList(),
    /** The announcement the guard pulled up before scanning this visitor in, if he did. */
    val expectedHint: za.onpar.core.ExpectedHint? = null,
    /** The guard looked someone up and nobody due today matched. */
    val expectedNotFound: Boolean = false,
    /** Announced visitors and regulars due today. */
    val expected: List<za.onpar.core.ExpectedRow> = emptyList(),
    /** What the site already knows about the visitor being scanned in. */
    val scanCheck: za.onpar.core.ScanCheck? = null,
    /** The visitor on the waiting screen, as the server last reported it. */
    val visit: za.onpar.core.VisitState? = null,
    /** The number just phoned for that visitor ("primary" or "second"): the guard must say how the call went. */
    val calledContact: String? = null,
    /** What the exit scan found for the visitor who is leaving. */
    val exitFound: za.onpar.core.ExitFound? = null,
    /** The guard has answered (same driver, passengers) and the server has said what the exit raises. */
    val exitChecked: Boolean = false,
    /** The entry face photo of a visitor on foot who is leaving. */
    val exitFace: PhotoBytes? = null,
    /** How the scan-out ended. */
    val exitDone: za.onpar.core.ExitReply? = null,
    /** Everyone on site now. */
    val onSite: za.onpar.core.OnSiteList? = null,
    /** The outgoing guard's handover while he works through it, and whether he has signed it off. */
    val handover: za.onpar.core.HandoverView? = null,
    val handoverDone: Boolean = false,
    /** Goes up each time a new overstay needs the guard, so the phone sounds once for it. */
    val overstayAlarm: Int = 0,
    val panic: PanicStatus? = null,
    /** Guards on duty on this phone but locked (D-33): shown on the front screen, unlocked with their PIN. */
    val lockedGuards: List<za.onpar.core.GuardSession> = emptyList(),
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
        lockedGuards = device.lockedGuards(),
    )

    private suspend fun background() = withContext(Dispatchers.IO) {
        if (device.setup == null) return@withContext
        val online = runCatching { device.heartbeat(version, battery(), Kiosk.status(getApplication())) }.isSuccess
        runCatching { device.profile.contacts() }.getOrNull()?.let { list -> _state.update { it.copy(contacts = list) } }
        runCatching { device.sync() }
        // A locked guard whose shift has ended (for example a supervisor released him) is forgotten.
        if (online) {
            for (g in device.lockedGuards()) {
                val off = try {
                    val st = device.stateOf(g)
                    st.attendance == null && st.pendingDeclaration == null
                } catch (e: ApiException) {
                    e.unauthorised
                } catch (e: OfflineException) {
                    false
                }
                if (off) device.forget(g.number)
            }
        }
        _state.update { it.copy(online = online, waiting = device.outbox.pending().size, lockedGuards = device.lockedGuards()) }
        if (online && device.guardToken != null) refreshHome()
    }

    private suspend fun refreshHome() = withContext(Dispatchers.IO) {
        try {
            val s = device.state()
            _state.update { it.copy(home = s, online = true, owed = device.owedDeclaration(s)) }
            // Whether this phone stands at a gate, so the home screen can show Visitors.
            runCatching { device.visitors.setup() }.getOrNull()?.let { g ->
                _state.update {
                    // A visitor has newly gone past their time: the phone sounds, once.
                    val more = g.counts.needAction > (it.gate?.counts?.needAction ?: 0)
                    it.copy(gate = g, overstayAlarm = if (more) it.overstayAlarm + 1 else it.overstayAlarm)
                }
            }
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
        _state.update { it.copy(screen = Screen.Home, guardName = e.name, page = Page.Home, lockedGuards = device.lockedGuards()) }
        refreshHome()
    }

    fun signOut() {
        device.signOut()
        _state.update { it.copy(screen = Screen.Login, guardName = null, home = null, owed = null, page = Page.Home, tasks = emptyList(), lockedGuards = device.lockedGuards()) }
    }

    /** Lock: the guard stays on duty; the phone goes back to the front screen (D-33). */
    fun lock() {
        device.lock()
        _state.update { it.copy(screen = Screen.Login, guardName = null, home = null, owed = null, page = Page.Home, tasks = emptyList(), lockedGuards = device.lockedGuards()) }
    }

    /** Unlocks a locked guard with his PIN (works without signal). */
    fun unlock(number: String, pin: String) = run {
        try {
            device.unlock(number, pin)
            _state.update { it.copy(screen = Screen.Home, guardName = device.guardName, page = Page.Home, lockedGuards = device.lockedGuards()) }
            refreshHome()
        } catch (e: IllegalArgumentException) {
            _state.update { it.copy(error = e.message, lockedGuards = device.lockedGuards()) }
        }
    }

    /** "Let my partner go first" at shift change (D-33). */
    fun giveTurn(pin: String) = run {
        device.giveTurn(pin)
        _state.update { it.copy(message = "Your partner may go first. You go when the next relief arrives.") }
        refreshHome()
    }

    fun go(page: Page) {
        _state.update { it.copy(page = page, error = null, message = null) }
        if (page == Page.Tasks) loadTasks()
        if (page == Page.Patrols) loadPatrols()
        if (page == Page.Reports || page is Page.Report) loadReports()
        if (page == Page.Reorders || page == Page.NewReorder) loadReorders()
        if (page == Page.Score) loadScore()
        if (page == Page.Training) loadTraining()
        if (page == Page.Roster) loadRoster()
        if (page == Page.Uniform) loadUniform()
        if (page == Page.Call) loadContacts()
        if (page == Page.Visitors) {
            _state.update { it.copy(expectedHint = null, expectedNotFound = false) }
            loadVisitors()
        }
        if (page == Page.ExpectedVisitor) {
            _state.update { it.copy(expectedHint = null, expectedNotFound = false) }
            loadVisitors()
        }
        if (page == Page.NewVisitor) _state.update { it.copy(scanCheck = null) }
        if (page == Page.VisitorExit) _state.update { it.copy(exitFound = null, exitChecked = false, exitFace = null, exitDone = null) }
        if (page == Page.OnSite) loadOnSite()
        if (page == Page.Handover) startHandover()
        if (page is Page.Visit) {
            _state.update { it.copy(visit = it.visit?.takeIf { v -> v.id == page.id }, calledContact = null) }
            watchVisit(page.id)
        }
    }

    // --- Visitors at the gate ------------------------------------------------

    fun loadVisitors() = run {
        val setup = device.visitors.setup()
        val list = if (setup.gate != null) device.visitors.recent() else emptyList()
        val due = if (setup.gate != null) runCatching { device.visitors.expected() }.getOrDefault(emptyList()) else emptyList()
        _state.update { it.copy(gate = setup, visits = list, expected = due) }
    }

    /** Starts scanning a visitor in: from "New visitor" (no announcement), or from one the guard pulled up first. */
    fun startVisitor(hint: za.onpar.core.ExpectedHint?) {
        _state.update { it.copy(expectedHint = hint, expectedNotFound = false) }
        go(Page.NewVisitor)
    }

    /** "Are you expected?" Looks up what the visitor gave: a cell number, an ID number or a number plate. */
    fun findExpected(text: String) = run {
        val keys = za.onpar.core.VisitorRules.lookupKeys(text)
        if (!keys.any) {
            _state.update { it.copy(error = "Type the visitor's cell number, ID number or number plate.") }
            return@run
        }
        val found = device.visitors.check(keys.idNumber, keys.registration, null, keys.cell).expected
        _state.update {
            if (found == null) it.copy(expectedHint = null, expectedNotFound = true)
            else it.copy(expectedNotFound = false, expectedHint = za.onpar.core.ExpectedHint(found.passId, found.visitorName, found.visiting, "what the visitor gave: $text", keys.cell))
        }
    }

    /** After a scan: a returning visitor's details and whether they are barred. Quiet: it must not hide what the guard is doing. */
    fun checkVisitor(idNumber: String, registration: String?, unitId: String?, cell: String? = null) {
        viewModelScope.launch {
            val found = withContext(Dispatchers.IO) { runCatching { device.visitors.check(idNumber, registration, unitId, cell) }.getOrNull() }
            _state.update { it.copy(scanCheck = found) }
        }
    }

    @Volatile private var visitWatch: kotlinx.coroutines.Job? = null

    /** Keeps the waiting screen up to date: asks every three seconds until the visit is decided or the guard leaves the screen. */
    private fun watchVisit(id: String) {
        visitWatch?.cancel()
        visitWatch = viewModelScope.launch {
            while (isActive && (_state.value.page as? Page.Visit)?.id == id) {
                val s = withContext(Dispatchers.IO) { runCatching { device.visitors.state(id) }.getOrNull() }
                if (s != null) _state.update { if ((it.page as? Page.Visit)?.id == id) it.copy(visit = s) else it }
                if (s != null && !s.waiting) break
                delay(3000)
            }
        }
    }

    /** "No response. Dial the customer?" The number comes from the server and is never shown. */
    fun dialCustomer(id: String, contact: String) = run {
        val d = device.visitors.dial(id, contact)
        if (Calls.placeHidden(getApplication(), d.number, d.label)) _state.update { it.copy(calledContact = contact) }
        else _state.update { it.copy(error = "The phone could not start the call.") }
    }

    fun callOutcome(id: String, contact: String, outcome: String) = run {
        val s = device.visitors.callOutcome(id, contact, outcome)
        _state.update { it.copy(visit = s, calledContact = null) }
    }

    /** Nobody could be reached: the visitor is turned away. */
    fun noResponse(id: String) = run {
        val s = device.visitors.noResponse(id)
        _state.update { it.copy(visit = s, calledContact = null) }
    }

    /** The exit scan: finds the visitor's open visit, and the entry face photo of a visitor on foot. */
    fun findExit(idNumber: String?, registration: String?) = run {
        val found = device.visitors.exitFind(idNumber, registration)
        val face = found.visit?.takeIf { it.hasFace }?.let { v -> runCatching { PhotoBytes(device.visitors.face(v.id)) }.getOrNull() }
        _state.update { it.copy(exitFound = found, exitChecked = false, exitFace = face, exitDone = null) }
    }

    /**
     * Scans the visitor out. Before the guard has decided anything, the server is first asked what
     * the exit would raise: if something does not match, the guard is shown it and must give a
     * reason and decide.
     */
    fun leave(draft: za.onpar.core.ExitDraft) = run {
        try {
            val raised = if (draft.allowed == null) device.visitors.exitFind(draft.idNumber, draft.registration, draft.sameDriver, draft.paxOut) else null
            if (raised != null && raised.exceptions.isNotEmpty()) {
                _state.update { it.copy(exitFound = raised, exitChecked = true) }
            } else {
                val done = device.visitors.exit(draft)
                draft.photo?.delete()
                _state.update { it.copy(exitDone = done) }
            }
        } catch (e: IllegalArgumentException) {
            _state.update { it.copy(error = e.message) }
        }
    }

    fun loadOnSite() = run {
        val list = device.visitors.onSite()
        _state.update { it.copy(onSite = list) }
    }

    /** "Hand over shift": opens the guard's handover, or the one he already started. */
    fun startHandover() = run {
        _state.update { it.copy(handoverDone = false) }
        val h = device.visitors.handoverStart()
        _state.update { it.copy(handover = h) }
    }

    /**
     * What the guard does about a visitor on site: "dialled" phones the customer (the number is
     * never shown), "confirmed" and "left" take a note. In a handover it counts towards the handover.
     */
    fun overstayAction(visitId: String, action: String, note: String, inHandover: Boolean) = run {
        try {
            val handoverId = if (inHandover) _state.value.handover?.id else null
            val dial = device.visitors.overstay(visitId, action, note, handoverId)
            if (dial != null && !Calls.placeHidden(getApplication(), dial.number, dial.label)) _state.update { it.copy(error = "The phone could not start the call.") }
            if (inHandover) {
                val h = device.visitors.handoverStart()
                _state.update { it.copy(handover = h) }
            } else {
                val list = device.visitors.onSite()
                _state.update { it.copy(onSite = list) }
            }
            runCatching { device.visitors.setup() }.getOrNull()?.let { g -> _state.update { it.copy(gate = g) } }
        } catch (e: IllegalArgumentException) {
            _state.update { it.copy(error = e.message) }
        }
    }

    /** The outgoing guard signs the handover off. After this he can log Duty From. */
    fun signOffHandover() = run {
        val h = _state.value.handover
        if (h != null) {
            device.visitors.handoverSignOff(h.id)
            _state.update { it.copy(handover = null, handoverDone = true) }
            refreshHome()
        }
    }

    /** The incoming guard has read the handover. */
    fun acknowledgeHandover(id: String) = run {
        device.visitors.handoverAcknowledge(id)
        val setup = device.visitors.setup()
        _state.update { it.copy(gate = setup) }
    }

    fun saveVisit(draft: za.onpar.core.VisitDraft) = run {
        try {
            val setup = _state.value.gate ?: device.visitors.setup()
            val reply = device.visitors.create(setup, draft)
            listOfNotNull(draft.face, draft.identityPhoto, draft.discPhoto).forEach { it.delete() }
            _state.update { it.copy(scanCheck = null) }
            go(Page.Visit(reply.id))
        } catch (e: IllegalArgumentException) {
            _state.update { it.copy(error = e.message) }
        }
    }

    // --- Score, training, calls ----------------------------------------------

    fun loadScore() = run {
        val s = device.profile.score()
        _state.update { it.copy(score = s) }
    }

    fun query(event: ScoreEvent, text: String) = run {
        try {
            val due = device.profile.query(event, text)
            val s = device.profile.score()
            _state.update { it.copy(score = s, message = "Query sent. Your supervisor must answer by ${due.ifEmpty { "the due date" }}.") }
        } catch (e: IllegalArgumentException) {
            _state.update { it.copy(error = e.message) }
        }
    }

    fun loadRoster() = run {
        val r = device.profile.roster()
        _state.update { it.copy(roster = r) }
    }

    fun loadTraining() = run {
        val t = device.profile.training()
        _state.update { it.copy(training = t) }
    }

    fun loadContacts() = run {
        val c = device.profile.contacts()
        _state.update { it.copy(contacts = c) }
    }

    /** Only approved contacts can be called (brief section 6.10). */
    fun canCall(number: String) = device.profile.isApproved(number)

    // --- Reports -------------------------------------------------------------

    fun loadReports() = run {
        val list = device.reports.list()
        _state.update { it.copy(reports = list, waitingLabels = device.reports.waiting().map { w -> w.label }) }
    }

    private fun done(r: Submitted, sent: String, back: Page) {
        _state.update {
            when (r) {
                is Submitted.Refused -> it.copy(error = r.message)
                is Submitted.Sent -> it.copy(message = sent, page = back)
                Submitted.Queued -> it.copy(message = "$sent Saved on the phone; it will be sent when there is signal.", page = back)
            }
        }
    }

    fun createReport(category: String, priority: String, description: String, photo: File?) = run {
        try {
            val r = device.reports.create(category, priority, description, photo)
            if (r !is Submitted.Refused) photo?.delete()
            done(r, "Report sent. It goes to your supervisor automatically.", Page.Reports)
            val list = device.reports.list()
            val waiting = device.reports.waiting().map { w -> w.label }
            _state.update { it.copy(reports = list, waitingLabels = waiting) }
        } catch (e: IllegalArgumentException) {
            _state.update { it.copy(error = e.message) }
        }
    }

    fun followUp(report: ReportItem, outcome: String, note: String, photo: File?) = run {
        try {
            val r = device.reports.followUp(report, outcome, note, photo)
            if (r !is Submitted.Refused) photo?.delete()
            done(r, "Follow-up recorded on report #${report.number}.", Page.Reports)
            val list = device.reports.list()
            _state.update { it.copy(reports = list) }
        } catch (e: IllegalArgumentException) {
            _state.update { it.copy(error = e.message) }
        }
    }

    // --- Re-orders -----------------------------------------------------------

    // --- Uniform (D-33) --------------------------------------------------------

    fun loadUniform() = run {
        _state.update { it.copy(uniform = device.uniform.state()) }
    }

    fun orderUniform(choices: List<za.onpar.core.UniformChoice>) = run {
        try {
            val r = device.uniform.order(choices)
            done(r, "Uniform order sent. A manager will approve it.", Page.Uniform)
            _state.update { it.copy(uniform = device.uniform.state()) }
        } catch (e: IllegalArgumentException) {
            _state.update { it.copy(error = e.message) }
        }
    }

    /** Signs for a delivery with his PIN (and agrees to pay for guard's-account items). */
    fun receiveUniform(order: za.onpar.core.UniformOrder, pin: String, agree: Boolean) = run {
        try {
            device.uniform.receive(order, pin, agree)
            _state.update { it.copy(message = "Signed for. Your uniform is recorded as received today.", uniform = device.uniform.state()) }
        } catch (e: IllegalArgumentException) {
            _state.update { it.copy(error = e.message) }
        }
    }

    fun loadReorders() = run {
        val list = device.reorders.list()
        val kit = device.reorders.kit()
        _state.update { it.copy(reorders = list, kit = kit, waitingLabels = device.reorders.waiting().map { w -> w.label }) }
    }

    fun reorderPersonal(item: IssuedItem, comment: String) = run {
        try {
            done(device.reorders.personal(item, comment), "Re-order sent: ${item.item}.", Page.Reorders)
            val list = device.reorders.list()
            _state.update { it.copy(reorders = list) }
        } catch (e: IllegalArgumentException) {
            _state.update { it.copy(error = e.message) }
        }
    }

    fun reorderSite(item: String, quantity: String, comment: String) = run {
        try {
            done(device.reorders.site(item, quantity, comment), "Site re-order sent.", Page.Reorders)
            val list = device.reorders.list()
            _state.update { it.copy(reorders = list) }
        } catch (e: IllegalArgumentException) {
            _state.update { it.copy(error = e.message) }
        }
    }

    fun received(r: ReorderItem) = run {
        try {
            done(device.reorders.received(r, ""), "Receipt confirmed: ${r.item}.", Page.Reorders)
            val list = device.reorders.list()
            val kit = device.reorders.kit()
            _state.update { it.copy(reorders = list, kit = kit) }
        } catch (e: IllegalArgumentException) {
            _state.update { it.copy(error = e.message) }
        }
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
            val active = device.patrols.active()
            val cached = device.patrols.cached()
            val text = if (out.accepted == true && out.point != null) "${out.point!!.name}: accepted." else out.message
            _state.update {
                it.copy(
                    page = next,
                    message = if (out.accepted != false) text else null,
                    error = if (out.accepted == false) text else null,
                    activePatrol = active,
                    patrols = cached,
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
        val list = device.tasks.today()
        _state.update { it.copy(tasks = list) }
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

    fun declare(owed: PendingDeclaration, accepted: List<Boolean>, comment: String, report: Boolean, priority: String, selfie: File, liveness: String? = null) = run {
        try {
            val r = device.declare(owed, accepted, comment, report, priority, selfie, liveness)
            when (r) {
                is Submitted.Refused -> _state.update { it.copy(error = r.message) }
                else -> {
                    selfie.delete() // the outbox keeps its own copy until sent
                    if (owed.kind == "duty_from") {
                        // The shift is over: sign the guard out so the post phone is ready for the next person.
                        // Anything still waiting to send keeps its own sign-in and is sent later.
                        signOut()
                        _state.update {
                            it.copy(
                                owed = null,
                                message = if (r is Submitted.Sent) "Duty From complete. Thank you. The phone is ready for the next guard."
                                else "Duty From saved on the phone and will be sent when there is signal. The phone is ready for the next guard.",
                            )
                        }
                        return@run
                    }
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

    // --- Panic and BOLO (decisions D-27, D-28) --------------------------------

    /**
     * PANIC, after the button was held for two seconds. In this order: call the site's
     * control room at once, take one location reading (a few seconds at most), then send
     * the alert to the website. Works with nobody signed in, and with no data (the call
     * uses the mobile network; the alert waits on the phone and goes first when signal returns).
     */
    fun panic() {
        if (_state.value.panic?.stage == PanicStage.Sending) return
        val app = getApplication<Application>()
        val control = (_state.value.contacts.ifEmpty { device.profile.cachedContacts() }).firstOrNull { it.kind == "control_room" }
        val callProblem = when {
            control == null -> "No control room number is set up for this site, so the phone could not call. Phone for help another way."
            !Calls.place(app, control.phone) -> "The phone could not start the call to the control room (On Par may not make calls). Phone for help another way."
            else -> null
        }
        _state.update { it.copy(page = Page.PanicSent, panic = PanicStatus(PanicStage.Sending, callProblem, controlRoom = control), error = null, message = null) }
        viewModelScope.launch {
            val fix = runCatching { za.onpar.app.ui.takePanicFix(app, PANIC_FIX_TIMEOUT_MS) }.getOrNull()
            val r = withContext(Dispatchers.IO) {
                runCatching { device.alerts.panic(fix, callStarted = callProblem == null) }.getOrElse { Submitted.Refused(it.message ?: "The panic could not be sent.", emptyMap()) }
            }
            val stage = when (r) {
                is Submitted.Sent -> PanicStage.Sent
                Submitted.Queued -> PanicStage.Saved
                is Submitted.Refused -> PanicStage.Refused
            }
            _state.update {
                it.copy(
                    panic = it.panic?.copy(stage = stage, located = fix != null, refusal = (r as? Submitted.Refused)?.message),
                    waiting = device.outbox.pending().size,
                    online = r !is Submitted.Queued,
                )
            }
        }
    }

    /** Calls the control room again from the panic screen. */
    fun callControlRoom() {
        val c = _state.value.panic?.controlRoom ?: return
        if (!Calls.place(getApplication(), c.phone)) _state.update { it.copy(error = "The phone could not start the call.") }
    }

    fun panicDone() = _state.update { it.copy(panic = null, page = Page.Home) }

    /** A BOLO: what to look out for, with a photo if taken. Works offline. */
    fun bolo(note: String, photo: File?, voice: File? = null, video: File? = null) = run {
        try {
            val r = device.alerts.bolo(note, photo, voice, video)
            // The outbox keeps its own copies of the files.
            if (r !is Submitted.Refused) listOfNotNull(photo, voice, video).forEach { it.delete() }
            done(r, "BOLO sent.", Page.Home)
        } catch (e: IllegalArgumentException) {
            _state.update { it.copy(error = e.message) }
        }
    }
}

/** A photo fetched from the server, held only while its screen is open. */
class PhotoBytes(val bytes: ByteArray)
