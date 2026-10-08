package za.onpar.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.util.UUID

/** One line of the shift's equipment: how many there should be, how many there are, and whether damaged. */
@Serializable
data class HandoverLine(val name: String, val expected: Int, val present: Int, val damaged: Boolean = false)

@Serializable
data class EquipmentCount(val name: String, val count: Int)

@Serializable
data class ShiftHandoverView(
    val id: String,
    val from: String = "",
    val shiftName: String? = null,
    val signedAt: String = "",
    val items: List<HandoverLine> = emptyList(),
    val note: String = "",
    val receivedAt: String? = null,
)

@Serializable
data class ShiftHandoverState(
    val onDuty: Boolean = false,
    val equipment: List<EquipmentCount> = emptyList(),
    val mine: ShiftHandoverView? = null,
    val incoming: ShiftHandoverView? = null,
)

/**
 * The shift handover (owner, 7 Oct 2026; D-45): the outgoing guard counts the equipment and
 * leaves a note; the incoming guard checks it and receives it. Needs signal: it is a meeting
 * of two people, and the server raises an equipment report for anything wrong.
 */
class HandoverActions(private val device: OnParDevice) {
    fun state(): ShiftHandoverState = OnParJson.decodeFromJsonElement(ShiftHandoverState.serializer(), device.client().get("/device/shift-handover", device.requireGuard()))

    private fun lines(items: List<HandoverLine>) = OnParJson.encodeToJsonElement(ListSerializer(HandoverLine.serializer()), items)

    fun handOver(items: List<HandoverLine>, note: String): ShiftHandoverState {
        require(items.all { it.present in 0..999 }) { "Count every item." }
        val body = buildJsonObject {
            put("eventId", UUID.randomUUID().toString())
            put("items", lines(items))
            put("note", note.trim())
        }
        return OnParJson.decodeFromJsonElement(ShiftHandoverState.serializer(), device.client().post("/device/shift-handover", body, device.requireGuard()))
    }

    fun receive(id: String, items: List<HandoverLine>, note: String): ShiftHandoverState {
        val body = buildJsonObject {
            put("items", lines(items))
            put("note", note.trim())
        }
        return OnParJson.decodeFromJsonElement(ShiftHandoverState.serializer(), device.client().post("/device/shift-handover/$id/receive", body, device.requireGuard()))
    }

    companion object {
        /** What is missing or damaged, in plain words, as the server will report it. */
        fun problems(items: List<HandoverLine>): List<String> = items.flatMap { i ->
            listOfNotNull(
                if (i.present < i.expected) "${i.name}: ${i.present} of ${i.expected}" else null,
                if (i.damaged) "${i.name}: damaged" else null,
            )
        }
    }
}
