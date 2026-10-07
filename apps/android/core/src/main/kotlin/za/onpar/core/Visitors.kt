package za.onpar.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import java.io.File

@Serializable
data class Gate(val id: String, val name: String)

@Serializable
data class VisitorCategory(val id: String, val name: String, val kind: String = "once_off", val contractor: Boolean = false)

@Serializable
data class VisitUnit(val id: String, val name: String)

/** What the gate phone needs before a visitor arrives. `gate` is null on a phone that is not at a gate. */
@Serializable
data class GateSetup(
    val gate: Gate? = null,
    val message: String? = null,
    val siteName: String? = null,
    /** The site's checks, by name, on or off. */
    val checks: Map<String, Boolean> = emptyMap(),
    val categories: List<VisitorCategory> = emptyList(),
    val units: List<VisitUnit> = emptyList(),
    /** Whether "the office" (the client) can be chosen as who the visitor is here to see. */
    val hasClient: Boolean = false,
    /** Today's date in South Africa, YYYY-MM-DD. */
    val today: String? = null,
) {
    fun on(check: String): Boolean = checks[check] ?: false
}

@Serializable
data class KnownPerson(val surname: String = "", val names: String = "", val lastSeen: String? = null)

@Serializable
data class KnownVehicle(val make: String = "", val model: String = "", val colour: String = "", val lastSeen: String? = null)

@Serializable
data class BarredHit(val kind: String, val kindLabel: String = "", val from: String = "site")

/** What the site already knows about a scanned ID number or number plate. */
@Serializable
data class ScanCheck(
    val person: KnownPerson? = null,
    val vehicle: KnownVehicle? = null,
    val barred: List<BarredHit> = emptyList(),
    /** The customer told the gate this visitor is coming (or they are a regular): let in without asking. */
    val expected: ExpectedMatch? = null,
)

/** An announced visitor or a regular, found from what was scanned. */
@Serializable
data class ExpectedMatch(
    val passId: String,
    val visitorName: String = "",
    val visiting: String = "",
    val category: String = "",
    val by: String = "",
    val regular: Boolean = false,
    /** The gate the customer named, when it is not this one. The visitor is still let in. */
    val namedGate: String? = null,
    /** What did not match what the customer gave, for example "number plate". The visitor is still let in and the customer told. */
    val mismatch: List<String> = emptyList(),
)

/**
 * The announcement the guard pulled up before scanning ("Are you expected?"). It is only a
 * head start: the visitor is still scanned in full, and is let in on the announcement only if
 * what is scanned (or the cell number given) matches it.
 */
data class ExpectedHint(val passId: String, val visitorName: String, val visiting: String, val knownBy: String = "", val cell: String? = null)

/** What the guard typed to look an expected visitor up, tried as each kind it could be. */
data class LookupKeys(val idNumber: String?, val registration: String?, val cell: String?) {
    val any: Boolean get() = idNumber != null || registration != null || cell != null
}

/** One line of the gate's "Expected today" list. */
@Serializable
data class ExpectedRow(
    val id: String,
    val visitorName: String = "",
    val visiting: String = "",
    val category: String = "",
    @kotlinx.serialization.SerialName("when") val time: String = "",
    val gateName: String? = null,
    val knownBy: String = "",
)

@Serializable
data class VisitReply(val id: String, val status: String, val statusLabel: String = "", val blocked: String? = null)

@Serializable
data class VisitRow(
    val id: String,
    val type: String,
    val status: String,
    val statusLabel: String = "",
    val at: String? = null,
    val surname: String = "",
    val names: String = "",
    val registration: String? = null,
    val make: String? = null,
    val model: String? = null,
    val colour: String? = null,
    val unitName: String? = null,
    val category: String = "",
    val pax: Int? = null,
    val gateName: String = "",
)

/** One of the numbers the gate may phone. The guard sees whose it is, never the number. */
@Serializable
data class DialOption(val label: String = "", val tried: Boolean = false)

@Serializable
data class DialOptions(val primary: DialOption? = null, val second: DialOption? = null) {
    /** Every number there is has been phoned (or there are none). */
    val allTried: Boolean get() = (primary == null || primary.tried) && (second == null || second.tried)
}

/** Where a visit stands, for the gate's waiting screen: the countdown, the answer, and whether the guard may phone. */
@Serializable
data class VisitState(
    val id: String,
    val status: String,
    val statusLabel: String = "",
    val visitor: String = "",
    val vehicle: String = "",
    val visiting: String = "",
    /** How many people were asked on their phones. */
    val asked: Int = 0,
    val secondsLeft: Int = 0,
    val canDial: Boolean = false,
    val dial: DialOptions = DialOptions(),
    /** How it ended, in the guard's words. */
    val decided: String? = null,
    val blocked: String? = null,
) {
    val waiting: Boolean get() = status == "awaiting_approval"
    val letIn: Boolean get() = status == "on_site"
}

/** The number for the phone to dial. Kept out of sight: the screen shows the label. */
@Serializable
data class DialReply(val number: String, val label: String = "")

data class VisitPerson(val idNumber: String, val surname: String, val names: String, val document: String, val method: String)

data class VisitVehicle(val registration: String, val make: String, val model: String, val colour: String, val vin: String, val discExpiry: String?, val method: String)

/** A visitor as captured at the gate, ready to be saved. */
data class VisitDraft(
    /** Made when the guard starts the visitor, so sending it twice saves it once. */
    val eventId: String,
    val type: String,
    val person: VisitPerson,
    val vehicle: VisitVehicle?,
    val licenceExpiry: String?,
    val pax: Int?,
    val categoryId: String,
    /** Null with `office`: the visitor is here to see the client. */
    val unitId: String?,
    val office: Boolean,
    /** The warnings the guard saw and went on past. */
    val acknowledged: List<String>,
    val face: File?,
    val identityPhoto: File?,
    val discPhoto: File?,
    /** The pass that lets this visitor in without asking ("Expected by ..."). The kind of visitor and the unit then come from the pass. */
    val passId: String? = null,
    /** The cell number the visitor gave, when that is how the pass was found. */
    val cell: String? = null,
)

/** The gate's own rules, the same as the server's, so the guard is told before anything is sent. */
object VisitorRules {
    val WARNING_TEXT = mapOf(
        "licence_expired" to "The driver's licence has expired.",
        "disc_expired" to "The vehicle's licence disc has expired.",
    )

    private val ISO = Regex("""(\d{4})-(\d{2})-(\d{2})""")
    private val DMY = Regex("""(\d{1,2})[/.\- ](\d{1,2})[/.\- ](\d{4})""")

    /** A date as typed from a document ("31/03/2027" or "2027-03-31") as YYYY-MM-DD, or null if it is not a date. */
    fun day(text: String): String? {
        val t = text.trim()
        val (y, m, d) = ISO.matchEntire(t)?.destructured?.let { (y, m, d) -> Triple(y.toInt(), m.toInt(), d.toInt()) }
            ?: DMY.matchEntire(t)?.destructured?.let { (d, m, y) -> Triple(y.toInt(), m.toInt(), d.toInt()) }
            ?: return null
        return runCatching { java.time.LocalDate.of(y, m, d).toString() }.getOrNull()
    }

    /** What the guard must be warned about. With "Expired licence acceptable" on, nothing. */
    fun warnings(setup: GateSetup, licenceExpiry: String?, discExpiry: String?): List<String> {
        val today = setup.today ?: return emptyList()
        if (setup.on("expiredLicenceOk")) return emptyList()
        val out = mutableListOf<String>()
        if (licenceExpiry != null && licenceExpiry < today) out += "licence_expired"
        if (discExpiry != null && discExpiry < today) out += "disc_expired"
        return out
    }

    /**
     * A cell number, ID number or number plate as the visitor gave it, as every kind it could
     * be: the gate does not ask the guard which it is.
     */
    fun lookupKeys(text: String): LookupKeys {
        val tidy = VisitorScan.plate(text)
        val digits = text.filter { it.isDigit() }
        val looksLikeNumber = text.all { it.isDigit() || it in "+ -()" }
        return LookupKeys(
            idNumber = tidy.takeIf { it.length in 5..20 },
            registration = tidy.takeIf { it.length in 2..12 },
            cell = digits.takeIf { looksLikeNumber && it.length in 9..15 },
        )
    }

    /** What is still missing from a visit, in the guard's words; null when it can be sent. */
    fun problem(setup: GateSetup, d: VisitDraft): String? = when {
        d.person.surname.isBlank() -> "Enter the visitor's surname."
        VisitorScan.idNumber(d.person.idNumber).length < 5 -> "Enter the ID or passport number."
        d.type == "vehicle" && d.vehicle == null -> "Scan the licence disc, or type the vehicle's details."
        d.type == "vehicle" && VisitorScan.plate(d.vehicle!!.registration).length < 2 -> "Enter the number plate."
        d.type == "vehicle" && setup.on("paxCount") && d.pax == null -> "Enter the number of passengers (0 if the driver is alone)."
        d.type == "pedestrian" && setup.on("facePhoto") && !d.face.present() -> "Take a photo of the visitor's face."
        d.person.method == "manual" && !d.identityPhoto.present() -> "Photograph the document you typed the details from."
        d.vehicle?.method == "manual" && !d.discPhoto.present() -> "Photograph the licence disc you typed the details from."
        !setup.on("expiredLicenceOk") && d.person.document == "drivers_licence" && d.licenceExpiry == null -> "Enter the date the licence expires."
        d.passId == null && setup.categories.none { it.id == d.categoryId } -> "Choose the kind of visitor."
        d.passId == null && d.unitId == null && !(d.office && setup.hasClient) -> "Choose who the visitor is here to see."
        !d.acknowledged.containsAll(warnings(setup, d.licenceExpiry, d.vehicle?.discExpiry)) -> "Confirm that you have seen the warning."
        else -> null
    }

    private fun File?.present(): Boolean = this != null && isFile && length() > 0
}

/** Visitors on the gate phone (visitor management, step 2): scan a visitor in and ask for approval. */
class VisitorActions(private val device: OnParDevice, dataDir: File) {
    private val cache = File(dataDir, "gate.json")
    private val rows = ListSerializer(VisitRow.serializer())

    /** The gate's setup, kept on the phone so the screens still open without signal. */
    fun setup(): GateSetup = try {
        val fresh = OnParJson.decodeFromJsonElement(GateSetup.serializer(), device.client().get("/device/visitors/setup", device.requireGuard()))
        cache.writeText(OnParJson.encodeToString(GateSetup.serializer(), fresh))
        fresh
    } catch (e: OfflineException) {
        cached() ?: throw e
    }

    fun cached(): GateSetup? = if (cache.exists()) runCatching { OnParJson.decodeFromString(GateSetup.serializer(), cache.readText()) }.getOrNull() else null

    /** Announced visitors and regulars due today. */
    fun expected(): List<ExpectedRow> = OnParJson.decodeFromJsonElement(ListSerializer(ExpectedRow.serializer()), device.client().get("/device/visitors/expected", device.requireGuard()))

    /** Today's visitors at this site. */
    fun recent(): List<VisitRow> = OnParJson.decodeFromJsonElement(rows, device.client().get("/device/visitors/recent", device.requireGuard()))

    /** After a scan: a returning visitor's details, and whether the ID number or number plate is barred. */
    fun check(idNumber: String?, registration: String?, unitId: String?, cell: String? = null): ScanCheck {
        val body = buildJsonObject {
            cell?.takeIf { it.isNotBlank() }?.let { put("cell", it) }
            idNumber?.takeIf { it.isNotBlank() }?.let { put("idNumber", it) }
            registration?.takeIf { it.isNotBlank() }?.let { put("registration", it) }
            put("unitId", unitId?.let { JsonPrimitive(it) } ?: JsonNull)
        }
        return OnParJson.decodeFromJsonElement(ScanCheck.serializer(), device.client().post("/device/visitors/check", body, device.requireGuard()))
    }

    /**
     * Saves the visitor and asks for approval. Needs signal for now (working without signal is a
     * later step). A document's photo is sent only when its details were typed by hand.
     */
    fun create(setup: GateSetup, d: VisitDraft): VisitReply {
        VisitorRules.problem(setup, d)?.let { throw IllegalArgumentException(it) }
        val body = buildJsonObject {
            put("eventId", d.eventId)
            put("type", d.type)
            putJsonObject("person") {
                put("idNumber", VisitorScan.idNumber(d.person.idNumber))
                put("surname", d.person.surname.trim())
                put("names", d.person.names.trim())
                put("document", d.person.document)
                put("method", d.person.method)
            }
            val v = d.vehicle?.takeIf { d.type == "vehicle" }
            if (v == null) put("vehicle", JsonNull) else putJsonObject("vehicle") {
                put("registration", VisitorScan.plate(v.registration))
                put("make", v.make.trim())
                put("model", v.model.trim())
                put("colour", v.colour.trim())
                put("vin", v.vin.trim())
                put("discExpiry", v.discExpiry?.let { JsonPrimitive(it) } ?: JsonNull)
                put("method", v.method)
            }
            put("licenceExpiry", d.licenceExpiry?.let { JsonPrimitive(it) } ?: JsonNull)
            put("pax", if (d.type == "vehicle" && d.pax != null) JsonPrimitive(d.pax) else JsonNull)
            put("categoryId", if (d.passId == null) JsonPrimitive(d.categoryId) else JsonNull)
            put("unitId", d.unitId?.takeIf { d.passId == null }?.let { JsonPrimitive(it) } ?: JsonNull)
            if (d.passId != null) put("passId", d.passId)
            if (d.passId != null && !d.cell.isNullOrBlank()) put("cell", d.cell)
            put("acknowledged", JsonArray(d.acknowledged.map { JsonPrimitive(it) }))
            put("trustedAt", device.clock.now().toString())
            put("deviceClock", device.clock.deviceClock().toString())
        }
        val files = buildList {
            if (d.type == "pedestrian" && d.face != null) add(Upload("face", d.face, "image/jpeg"))
            if (d.person.method == "manual" && d.identityPhoto != null) add(Upload("identity", d.identityPhoto, "image/jpeg"))
            if (d.type == "vehicle" && d.vehicle?.method == "manual" && d.discPhoto != null) add(Upload("disc", d.discPhoto, "image/jpeg"))
        }
        val guard = device.requireGuard()
        val reply = if (files.isEmpty()) device.client().post("/device/visitors", body, guard) else device.client().postMultipart("/device/visitors", body, files, guard)
        return OnParJson.decodeFromJsonElement(VisitReply.serializer(), reply)
    }

    /** Where a visit stands. The waiting screen asks every few seconds. */
    fun state(id: String): VisitState = OnParJson.decodeFromJsonElement(VisitState.serializer(), device.client().get("/device/visitors/$id", device.requireGuard()))

    /** "No response. Dial the customer?" The server hands over the number only once the customer's time is up. */
    fun dial(id: String, contact: String): DialReply {
        val body = buildJsonObject { put("contact", contact) }
        return OnParJson.decodeFromJsonElement(DialReply.serializer(), device.client().post("/device/visitors/$id/dial", body, device.requireGuard()))
    }

    /** After the call: "approved", "denied" or "no_answer". */
    fun callOutcome(id: String, contact: String, outcome: String): VisitState {
        require(outcome in CALL_OUTCOMES) { "Choose how the call went." }
        val body = buildJsonObject {
            put("eventId", java.util.UUID.randomUUID().toString())
            put("contact", contact)
            put("outcome", outcome)
        }
        return OnParJson.decodeFromJsonElement(VisitState.serializer(), device.client().post("/device/visitors/$id/call-outcome", body, device.requireGuard()))
    }

    /** Nobody could be reached: the visitor is turned away. */
    fun noResponse(id: String): VisitState {
        val body = buildJsonObject { put("eventId", java.util.UUID.randomUUID().toString()) }
        return OnParJson.decodeFromJsonElement(VisitState.serializer(), device.client().post("/device/visitors/$id/no-response", body, device.requireGuard()))
    }

    fun clear() {
        cache.delete()
    }

    companion object {
        val CALL_OUTCOMES = linkedMapOf("approved" to "Approved by phone", "denied" to "Denied by phone", "no_answer" to "No answer")
    }
}
