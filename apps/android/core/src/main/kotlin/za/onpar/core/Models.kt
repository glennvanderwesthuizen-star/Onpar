package za.onpar.core

import kotlinx.serialization.Serializable

@Serializable
data class Employee(val id: String, val name: String, val employeeNumber: String? = null)

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
)
