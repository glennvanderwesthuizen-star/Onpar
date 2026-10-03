package za.onpar.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.Checkbox
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import za.onpar.app.AppViewModel
import za.onpar.app.Page
import za.onpar.app.UiState
import za.onpar.core.UniformChoice
import za.onpar.core.UniformKitItem
import za.onpar.core.UniformOrder
import za.onpar.core.formatRand
import za.onpar.core.rosterDate

private val AmberText = Color(0xFFB86E00)

/** What the guard has ticked, with his size, quantity and reason. */
private class Pick(size: String, quantity: Int) {
    var size by mutableStateOf(size)
    var quantity by mutableStateOf(quantity)
    var reason by mutableStateOf("")
}

/**
 * The guard's uniform (D-33): a table of what his site list entitles him to, when each was
 * last issued and is next due; tick several items to order them together; and his orders,
 * with "Sign for it" when his supervisor brings them.
 */
@Composable
fun UniformScreen(vm: AppViewModel, state: UiState) {
    val u = state.uniform
    val picks = remember { mutableStateMapOf<String, Pick>() }
    var signing by remember { mutableStateOf<UniformOrder?>(null) }
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text("My uniform", style = MaterialTheme.typography.headlineSmall, modifier = Modifier.weight(1f))
        OutlinedButton(onClick = { vm.go(Page.Home) }) { Text("Back") }
    }
    if (u == null) {
        Text(if (state.busy) "Loading…" else "No uniform information yet.", color = Color.Gray)
        return
    }

    // Orders first: anything waiting for him to sign comes to the top.
    u.orders.sortedByDescending { it.canReceive }.forEach { o ->
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.background(if (o.canReceive) Color(0xFFDFF3E7) else Color.Transparent).padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("Order #${o.number}: ${o.statusLabel}", fontWeight = FontWeight.Bold)
                o.lines.forEach { l ->
                    val what = when (l.decision) {
                        "declined" -> "not issued" + if (l.decisionNote.isNotBlank()) " (${l.decisionNote})" else ""
                        "guard" -> "your account, ${formatRand(l.unitPriceCents * l.quantity)}"
                        else -> ""
                    }
                    Text("${l.quantity} × ${l.label} ${l.size}" + if (what.isNotEmpty()) " · $what" else "", fontSize = 14.sp, color = if (l.decision == "declined") Color.Gray else Color.Unspecified)
                }
                if (o.canReceive) {
                    Button(onClick = { signing = o }, modifier = Modifier.fillMaxWidth(), colors = ButtonDefaults.buttonColors(containerColor = Green)) { Text("Sign for it") }
                }
            }
        }
    }

    Text("Order uniform", fontWeight = FontWeight.Bold, fontSize = 18.sp, modifier = Modifier.padding(top = 8.dp))
    if (u.kit.isEmpty()) Text("Your site has no uniform list yet. Ask your supervisor.", color = Color.Gray)
    Text("Tick what you need. Items not yet due need a reason.", color = Color.Gray, fontSize = 13.sp)
    u.kit.forEach { k -> KitRow(k, picks) }
    val chosen = u.kit.filter { picks.containsKey(it.itemId) }
    BigButton(if (state.busy) "Sending…" else "Send order (${chosen.size} item${if (chosen.size == 1) "" else "s"})", enabled = !state.busy && chosen.isNotEmpty()) {
        vm.orderUniform(chosen.map { k -> picks[k.itemId]!!.let { p -> UniformChoice(k, p.size, p.quantity, p.reason) } })
        picks.clear()
    }

    signing?.let { o -> SignDialog(o, onCancel = { signing = null }) { pin, agree -> signing = null; vm.receiveUniform(o, pin, agree) } }
}

@Composable
private fun KitRow(k: UniformKitItem, picks: MutableMap<String, Pick>) {
    val pick = picks[k.itemId]
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Checkbox(checked = pick != null, onCheckedChange = { on ->
                    if (on) picks[k.itemId] = Pick(k.lastSize?.takeIf { it in k.sizes } ?: k.sizes.firstOrNull().orEmpty(), k.entitled) else picks.remove(k.itemId)
                })
                Column(Modifier.weight(1f)) {
                    Text(k.label, fontWeight = FontWeight.Bold)
                    Text(
                        (if (k.lastIssued != null) "Last issued ${rosterDate(k.lastIssued!!)}${k.lastSize?.let { " · size $it" } ?: ""} · " else "Never issued · ") +
                            "up to ${k.entitled}",
                        fontSize = 13.sp, color = Color.Gray,
                    )
                }
                Text(if (k.due) "Due now" else "Due ${k.nextDue?.let { rosterDate(it) } ?: ""}", color = if (k.due) Green else AmberText, fontSize = 13.sp, fontWeight = FontWeight.Bold)
            }
            if (pick != null) {
                if (k.sizes.isNotEmpty()) {
                    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        k.sizes.forEach { s -> FilterChip(selected = pick.size == s, onClick = { pick.size = s }, label = { Text(s) }) }
                    }
                }
                if (k.entitled > 1) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text("How many:")
                        OutlinedButton(onClick = { if (pick.quantity > 1) pick.quantity-- }) { Text("−") }
                        Text("${pick.quantity}", fontWeight = FontWeight.Bold, fontSize = 18.sp)
                        OutlinedButton(onClick = { if (pick.quantity < k.entitled) pick.quantity++ }) { Text("+") }
                    }
                }
                if (!k.due) {
                    OutlinedTextField(pick.reason, { pick.reason = it.take(500) }, label = { Text("Why do you need it now?") }, modifier = Modifier.fillMaxWidth())
                }
            }
        }
    }
}

/** Sign for a delivery: the items, any amount on his account to agree to, then his PIN. */
@Composable
private fun SignDialog(o: UniformOrder, onCancel: () -> Unit, onSign: (String, Boolean) -> Unit) {
    var agree by remember { mutableStateOf(false) }
    var askPin by remember { mutableStateOf(false) }
    androidx.compose.material3.AlertDialog(
        onDismissRequest = onCancel,
        title = { Text("Sign for order #${o.number}") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("Check that you have received:")
                o.lines.filter { it.decision != "declined" }.forEach { Text("• ${it.quantity} × ${it.label} ${it.size}") }
                o.agreeStatement?.let { st ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(checked = agree, onCheckedChange = { agree = it })
                        Text(st, fontWeight = FontWeight.Bold)
                    }
                }
            }
        },
        confirmButton = {
            Button(onClick = { askPin = true }, enabled = o.guardCents == 0 || agree) { Text("Sign with my PIN") }
        },
        dismissButton = { OutlinedButton(onClick = onCancel) { Text("Not now") } },
    )
    if (askPin) PinDialog("Your PIN", onCancel = { askPin = false }) { pin -> askPin = false; onSign(pin, agree) }
}
