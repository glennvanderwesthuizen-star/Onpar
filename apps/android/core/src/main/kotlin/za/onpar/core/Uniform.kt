package za.onpar.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.File
import java.util.UUID

/** One row of the guard's uniform table: what his site list entitles him to, and when it is next due (D-33). */
@Serializable
data class UniformKitItem(
    val itemId: String,
    val label: String,
    val sizes: List<String> = emptyList(),
    val entitled: Int = 1,
    val lastIssued: String? = null,
    val lastSize: String? = null,
    val nextDue: String? = null,
    val due: Boolean = true,
)

@Serializable
data class UniformOrderLine(
    val label: String,
    val size: String = "",
    val quantity: Int,
    /** company, guard or declined; null while waiting for approval. */
    val decision: String? = null,
    val decisionNote: String = "",
    val unitPriceCents: Int = 0,
)

@Serializable
data class UniformOrder(
    val id: String,
    val number: Int,
    val status: String,
    val statusLabel: String,
    val requestedAt: String? = null,
    val lines: List<UniformOrderLine> = emptyList(),
    /** What he will agree to pay for guard's-account items, in cents. */
    val guardCents: Int = 0,
    val canReceive: Boolean = false,
    val agreeStatement: String? = null,
)

@Serializable
data class UniformState(val kit: List<UniformKitItem> = emptyList(), val orders: List<UniformOrder> = emptyList())

/** What the guard ticked in his table. */
data class UniformChoice(val item: UniformKitItem, val size: String, val quantity: Int, val reason: String = "")

/** Rand amounts as South Africans write them: R1 234.50. */
fun formatRand(cents: Int): String {
    val rands = (cents / 100).toString().reversed().chunked(3).joinToString(" ").reversed()
    return "R$rands.${(cents % 100).toString().padStart(2, '0')}"
}

/** Uniform on the post phone: the kit table, ordering several items at once, and signing for a delivery. */
class UniformActions(private val device: OnParDevice, dataDir: File) {
    private val cache = File(dataDir, "uniform.json")

    /** His table and orders; the last copy is kept for when there is no signal. */
    fun state(): UniformState = try {
        val fresh = OnParJson.decodeFromJsonElement(UniformState.serializer(), device.client().get("/device/uniform", device.requireGuard()))
        cache.writeText(OnParJson.encodeToString(UniformState.serializer(), fresh))
        fresh
    } catch (e: OfflineException) {
        if (cache.exists()) runCatching { OnParJson.decodeFromString(UniformState.serializer(), cache.readText()) }.getOrDefault(UniformState()) else UniformState()
    }

    /** One order for everything ticked. Items not yet due need a reason. Works offline through the outbox. */
    fun order(choices: List<UniformChoice>): Submitted {
        require(choices.isNotEmpty()) { "Tick at least one item." }
        for (c in choices) {
            require(c.item.sizes.isEmpty() || c.size in c.item.sizes) { "Choose your size for ${c.item.label}." }
            require(c.quantity in 1..c.item.entitled) { "${c.item.label}: you may order up to ${c.item.entitled}." }
            require(c.item.due || c.reason.trim().length >= 3) { "${c.item.label} is not due until ${c.item.nextDue}: say why you need it now." }
        }
        val eventId = UUID.randomUUID().toString()
        val body = buildJsonObject {
            put("eventId", eventId)
            put("lines", JsonArray(choices.map { c ->
                buildJsonObject {
                    put("itemId", c.item.itemId)
                    put("size", c.size)
                    put("quantity", c.quantity)
                    put("reason", c.reason.trim())
                }
            }))
            put("trustedAt", device.clock.now().toString())
            put("deviceClock", device.clock.deviceClock().toString())
        }
        return device.outbox.submit(device.client(), eventId, "Uniform order", "/device/uniform/orders", body, device.requireGuard())
    }

    /**
     * Signs for a delivery with his PIN. Needs signal: the server checks the PIN. For
     * guard's-account items he must agree to the amount shown (L-08: recorded, never deducted).
     */
    fun receive(order: UniformOrder, pin: String, agreeToPay: Boolean) {
        require(order.canReceive) { "Your supervisor does not have this order yet." }
        require(order.guardCents == 0 || agreeToPay) { "Some items are on your account. Read the amount and agree to it to sign." }
        device.client().post(
            "/device/uniform/orders/${order.id}/receive",
            buildJsonObject {
                put("pin", pin)
                put("agreeToPay", agreeToPay)
                put("trustedAt", device.clock.now().toString())
                put("deviceClock", device.clock.deviceClock().toString())
            },
            device.requireGuard(),
        )
    }

    fun clear() {
        cache.delete()
    }
}
