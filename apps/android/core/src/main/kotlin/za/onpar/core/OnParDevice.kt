package za.onpar.core

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.File
import java.util.UUID

/**
 * Everything the phone app does, without any Android screens: set up, sign in,
 * heartbeat, and guard actions through the outbox. The Android app shows this;
 * tests drive it directly.
 */
class OnParDevice(dataDir: File, val clock: TrustedClock = TrustedClock(), private val http: okhttp3.OkHttpClient = ApiClient.defaultHttp()) {
    private val store = Store(File(dataDir, "settings.json"))
    val outbox = Outbox(File(dataDir, "outbox"), clock)
    val tasks = TaskActions(this, dataDir)
    val patrols = PatrolActions(this, dataDir)
    val reports = ReportActions(this, dataDir)
    val reorders = ReorderActions(this, dataDir)

    val setup: DeviceSetup?
        get() {
            val server = store["serverUrl"] ?: return null
            val token = store["deviceToken"] ?: return null
            return DeviceSetup(server, token)
        }

    private val api: ApiClient
        get() = ApiClient(setup ?: error("This phone is not set up yet."), clock, http)

    /** Saves the setup from the Devices page QR code, after checking the server accepts the key. */
    fun applySetup(s: DeviceSetup) {
        ApiClient(s, clock, http).post("/device/heartbeat", buildJsonObject { })
        store["serverUrl"] = s.serverUrl
        store["deviceToken"] = s.deviceToken
    }

    /** Forgets the setup (for example when the phone moves to another company). */
    fun clearSetup() {
        signOut()
        store["serverUrl"] = null
        store["deviceToken"] = null
    }

    /** Tells the server the phone is alive: battery, app version and whether the kiosk lock is on. Also syncs the time. */
    fun heartbeat(appVersion: String, batteryPct: Int?, kioskStatus: String) {
        api.post(
            "/device/heartbeat",
            buildJsonObject {
                put("appVersion", appVersion)
                batteryPct?.let { put("batteryPct", it) }
                put("kioskStatus", kioskStatus)
            },
        )
    }

    // --- The signed-in guard -------------------------------------------------

    val guardToken: String? get() = store["guardToken"]
    val guardName: String? get() = store["guardName"]

    /** Employee number and PIN. Needs signal: the server checks the PIN and locks after five wrong tries. */
    fun signIn(employeeNumber: String, pin: String): Employee {
        val reply = api.post("/device/login", buildJsonObject {
            put("employeeNumber", employeeNumber.trim())
            put("pin", pin)
        })
        val r = OnParJson.decodeFromJsonElement(LoginReply.serializer(), reply)
        store["guardToken"] = r.token
        store["guardName"] = r.employee.name
        return r.employee
    }

    /** Signs the guard out on this phone. Anything still waiting in the outbox is kept and sent later. */
    fun signOut() {
        store["guardToken"] = null
        store["guardName"] = null
        tasks.clear()
        patrols.clear()
        reports.clear()
        reorders.clear()
    }

    fun state(): GuardState = OnParJson.decodeFromJsonElement(GuardState.serializer(), api.get("/device/me", requireGuard()))

    /** Duty On or Duty From, with the PIN again (brief section 6.1). Works offline: it waits in the outbox. */
    fun duty(kind: DutyKind, pin: String): Pair<String, Submitted> {
        val eventId = UUID.randomUUID().toString()
        val body = buildJsonObject {
            put("eventId", eventId)
            put("kind", kind.wire)
            put("pin", pin)
            put("trustedAt", clock.now().toString())
            put("deviceClock", clock.deviceClock().toString())
        }
        val result = outbox.submit(api, eventId, kind.label, "/device/duty", body, requireGuard())
        // The declaration is owed at once, even with no signal to ask the server.
        if (result !is Submitted.Refused) store["owedDeclaration"] = "${kind.wire}|$eventId"
        return eventId to result
    }

    /**
     * The declaration still owed, if any: from the server when online, otherwise the one
     * this phone knows it owes after a Duty On or Duty From made without signal.
     */
    fun owedDeclaration(fromServer: GuardState?): PendingDeclaration? {
        fromServer?.pendingDeclaration?.let { return it }
        val (kind, dutyEventId) = store["owedDeclaration"]?.split('|')?.takeIf { it.size == 2 } ?: return null
        // The server has answered and owes nothing, and the duty event is no longer waiting to be sent:
        // it was either declared or refused, so nothing is owed.
        if (fromServer != null && outbox.pending().none { it.eventId == dutyEventId }) {
            store["owedDeclaration"] = null
            return null
        }
        return PendingDeclaration(kind, dutyEventId, DeclarationText.forKind(kind))
    }

    /**
     * The declaration after Duty On or Duty From (brief section 6.2): every statement
     * accepted and a selfie, with an optional comment that can be raised as an
     * equipment report. The text is sent first and the photo after, so a weak signal
     * never holds up the declaration itself.
     */
    fun declare(
        owed: PendingDeclaration,
        accepted: List<Boolean>,
        comment: String,
        raiseEquipmentReport: Boolean,
        reportPriority: String,
        selfie: File,
    ): Submitted {
        require(accepted.size == owed.wording.statements.size && accepted.all { it }) { "Tick every statement to continue." }
        require(selfie.exists() && selfie.length() > 0) { "Take your selfie to continue." }
        require(!raiseEquipmentReport || comment.isNotBlank()) { "Describe the problem in the comment to raise it as an equipment report." }
        val eventId = UUID.randomUUID().toString()
        val body = buildJsonObject {
            put("eventId", eventId)
            put("dutyEventId", owed.dutyEventId)
            put("accepted", kotlinx.serialization.json.JsonArray(accepted.map { kotlinx.serialization.json.JsonPrimitive(it) }))
            put("comment", comment.trim())
            put("raiseEquipmentReport", raiseEquipmentReport)
            put("equipmentReportPriority", reportPriority)
            put("trustedAt", clock.now().toString())
            put("deviceClock", clock.deviceClock().toString())
            put("selfieToFollow", true)
        }
        val token = requireGuard()
        val label = if (owed.kind == "duty_from") "Duty From declaration" else "Duty On declaration"
        outbox.add(eventId, label, "/device/declarations", body, token)
        outbox.add("$eventId-selfie", "Selfie", "/device/declarations/$eventId/selfie", buildJsonObject { }, token, listOf(Upload("selfie", selfie, "image/jpeg")))
        store["owedDeclaration"] = null
        val results = runCatching { outbox.flush(api) }.getOrDefault(emptyMap())
        return results[eventId] ?: Submitted.Queued
    }

    /** Sends anything waiting. Call when the phone gets signal and every minute or so. */
    fun sync(): Map<String, Submitted> = if (setup == null) emptyMap() else outbox.flush(api)

    internal fun requireGuard(): String = guardToken ?: throw ApiException(401, "Please log in with your employee number and PIN.")

    internal fun client(): ApiClient = api
}

enum class DutyKind(val wire: String, val label: String) {
    ON("duty_on", "Duty On"),
    FROM("duty_from", "Duty From"),
}

/** A reply that is a JSON object, or an empty one. */
internal fun Submitted.replyObject(): JsonObject? = (this as? Submitted.Sent)?.reply as? JsonObject
