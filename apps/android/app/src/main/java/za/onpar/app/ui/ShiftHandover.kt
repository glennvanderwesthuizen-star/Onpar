package za.onpar.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Card
import androidx.compose.material3.Checkbox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
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
import za.onpar.core.HandoverActions
import za.onpar.core.HandoverLine

@Composable
private fun HandoverHeader(title: String, vm: AppViewModel) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(title, style = MaterialTheme.typography.headlineSmall, modifier = Modifier.weight(1f))
        OutlinedButton(onClick = { vm.go(Page.Home) }) { Text("Back") }
    }
}

/** One item: minus, the count, plus, and "damaged". */
@Composable
private fun ItemCounter(line: HandoverLine, onChange: (HandoverLine) -> Unit) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(line.name, fontWeight = FontWeight.Bold, fontSize = 18.sp)
                    Text("Should be ${line.expected}", color = Color.Gray, fontSize = 14.sp)
                }
                OutlinedButton(onClick = { if (line.present > 0) onChange(line.copy(present = line.present - 1)) }) { Text("−", fontSize = 20.sp) }
                Text("${line.present}", fontSize = 24.sp, fontWeight = FontWeight.Bold, modifier = Modifier.padding(horizontal = 14.dp), color = if (line.present < line.expected) Color(0xFFB3261E) else Color.Unspecified)
                OutlinedButton(onClick = { onChange(line.copy(present = line.present + 1)) }) { Text("+", fontSize = 20.sp) }
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Checkbox(checked = line.damaged, onCheckedChange = { onChange(line.copy(damaged = it)) })
                Text("Damaged")
            }
        }
    }
}

/**
 * The one handover screen (owner, 7 Oct 2026; D-45): on a gate phone the visitors first, then the
 * shift's equipment counted, then a note, then sign. Anything missing or damaged is reported.
 */
@Composable
fun ShiftHandoverScreen(vm: AppViewModel, state: UiState) {
    HandoverHeader("Hand over shift", vm)
    val h = state.shiftHandover
    if (h == null) {
        Text(if (state.busy) "Loading…" else "The handover needs signal. Try again when the phone has signal.", color = Color.Gray)
        return
    }
    if (h.mine != null) {
        Text("You handed over this shift at ${time(h.mine!!.signedAt)}.", color = Green, fontWeight = FontWeight.Bold)
        return
    }
    val lines = remember(h.equipment) { mutableStateListOf<HandoverLine>().apply { addAll(h.equipment.map { HandoverLine(it.name, it.count, it.count) }) } }
    var note by remember { mutableStateOf("") }
    val shift = state.home?.attendance
    if (state.gate?.gate != null) {
        Text("1. VISITORS", fontWeight = FontWeight.Bold, color = Color.Gray, fontSize = 13.sp)
        if (shift?.visitorHandoverOwed == true) {
            Text("Go through the visitors on site and sign them over first.")
            OutlinedButton(onClick = { vm.go(Page.Handover) }, modifier = Modifier.fillMaxWidth()) { Text("Go through the visitors") }
        } else Text("Visitors handed over ✓", color = Green, fontWeight = FontWeight.Bold)
    }
    Text((if (state.gate?.gate != null) "2. " else "1. ") + "EQUIPMENT", fontWeight = FontWeight.Bold, color = Color.Gray, fontSize = 13.sp)
    if (lines.isEmpty()) Text("No equipment is set up for this shift. Your supervisor sets it up with the site.", color = Color.Gray)
    lines.forEachIndexed { i, line -> ItemCounter(line) { lines[i] = it } }
    val problems = HandoverActions.problems(lines)
    if (problems.isNotEmpty()) Text("An equipment report will be raised for: ${problems.joinToString("; ")}.", color = Color(0xFFB86E00))
    Text((if (state.gate?.gate != null) "3. " else "2. ") + "NOTE FOR THE NEXT GUARD", fontWeight = FontWeight.Bold, color = Color.Gray, fontSize = 13.sp)
    OutlinedTextField(note, { note = it.take(2000) }, label = { Text("Anything he should know (optional)") }, minLines = 2, modifier = Modifier.fillMaxWidth())
    BigButton(if (state.busy) "Sending…" else "SIGN: HAND OVER", enabled = !state.busy && !(state.gate?.gate != null && shift?.visitorHandoverOwed == true)) {
        vm.handOverShift(lines.toList(), note)
    }
}

/** The incoming guard checks what was handed over and receives it. A difference is reported. */
@Composable
fun ReceiveHandoverScreen(vm: AppViewModel, state: UiState) {
    HandoverHeader("Receive the handover", vm)
    val inc = state.shiftHandover?.incoming
    if (inc == null) {
        Text(if (state.busy) "Loading…" else "No handover is waiting for you.", color = Color.Gray)
        return
    }
    val lines = remember(inc.id) { mutableStateListOf<HandoverLine>().apply { addAll(inc.items) } }
    var note by remember { mutableStateOf("") }
    Text("From ${inc.from} at ${time(inc.signedAt)}" + (inc.shiftName?.let { ", $it shift" } ?: ""), fontWeight = FontWeight.Bold)
    if (inc.note.isNotBlank()) {
        Card(Modifier.fillMaxWidth()) { Text("“${inc.note}”", modifier = Modifier.padding(12.dp)) }
    }
    Text("Count what is really there. The numbers start at what was handed over.", color = Color.Gray)
    lines.forEachIndexed { i, line -> ItemCounter(line) { lines[i] = it } }
    val diffs = inc.items.mapNotNull { h ->
        val r = lines.firstOrNull { it.name == h.name } ?: return@mapNotNull null
        when {
            r.present != h.present -> "${h.name}: handed over ${h.present}, you count ${r.present}"
            r.damaged && !h.damaged -> "${h.name}: damaged"
            else -> null
        }
    }
    if (diffs.isNotEmpty()) Text("An equipment report will be raised for: ${diffs.joinToString("; ")}.", color = Color(0xFFB86E00))
    OutlinedTextField(note, { note = it.take(2000) }, label = { Text("Note (optional)") }, minLines = 2, modifier = Modifier.fillMaxWidth())
    BigButton(if (state.busy) "Sending…" else "RECEIVE", enabled = !state.busy) { vm.receiveHandover(inc.id, lines.toList(), note) }
}
