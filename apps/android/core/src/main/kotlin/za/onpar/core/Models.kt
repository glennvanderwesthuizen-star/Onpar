package za.onpar.core

import kotlinx.serialization.Serializable

@Serializable
data class Employee(val id: String, val name: String, val employeeNumber: String? = null, val tsfNumber: String? = null)

@Serializable
data class LoginReply(val token: String, val employee: Employee)

@Serializable
data class Declarations(val duty_on: Boolean = false, val duty_from: Boolean = false)

/** The current shift, as the server sees it. */
@Serializable
data class Attendance(
    val id: String,
    val shiftName: String? = null,
    val scheduledStart: String? = null,
    val scheduledEnd: String? = null,
    val dutyOnAt: String,
    val dutyFromAt: String? = null,
    val arrivalStatus: String,
    val lateMinutes: Int = 0,
    val siteName: String? = null,
    /** Whether he may log Duty From yet (D-33). */
    val relief: Relief? = null,
    /** On a gate phone: the visitors on site must be handed over before Duty From. */
    val visitorHandoverOwed: Boolean = false,
)

/** Relief at shift change, as the server sees it (D-33). */
@Serializable
data class Relief(
    val canLeave: Boolean = true,
    /** no_rule, relieved, no_relief or wait. */
    val outcome: String = "no_rule",
    val message: String = "",
    val unlocksAt: String? = null,
    val canGiveTurn: Boolean = false,
    val reliever: String? = null,
)

@Serializable
data class DeclarationWording(val version: Int, val statements: List<String>)

@Serializable
data class PendingDeclaration(val kind: String, val dutyEventId: String, val wording: DeclarationWording)

/** What the home screen shows: who is signed in, the open shift, and any declaration still owed. */
@Serializable
data class GuardState(
    val employee: Employee,
    val serverTime: String,
    val attendance: Attendance? = null,
    val pendingDeclaration: PendingDeclaration? = null,
    /** The guard's real shift today and the coming working days (brief section 40). */
    val roster: GuardRoster? = null,
    /** The position he is locked to at this site; null when he roams. */
    val posting: Posting? = null,
)

/** A guard locked to a position: its name, and whether this phone is that position's. */
@Serializable
data class Posting(val postName: String = "", val here: Boolean = true)

/** A guard due on duty at this phone's site about now, for the sign-in screen. `login` is what signs him in with his PIN. */
@Serializable
data class ExpectedGuard(val login: String, val name: String = "", val shift: String = "")
