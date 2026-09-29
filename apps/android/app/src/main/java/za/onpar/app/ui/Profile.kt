package za.onpar.app.ui

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.telecom.TelecomManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import za.onpar.app.AppViewModel
import za.onpar.core.rosterDate
import za.onpar.core.shiftText
import za.onpar.core.todayText
import za.onpar.app.CallInfo
import za.onpar.app.Calls
import za.onpar.app.Kiosk
import za.onpar.app.Page
import za.onpar.app.UiState
import za.onpar.core.Contact
import za.onpar.core.ScoreEvent

private val Red = Color(0xFFB3261E)
private val Amber = Color(0xFFB86E00)

@Composable
private fun Title(text: String, back: () -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(text, style = MaterialTheme.typography.headlineSmall, modifier = Modifier.weight(1f))
        OutlinedButton(onClick = back) { Text("Back") }
    }
}

/** The guard's score and why it changed, with the Query button on lost points (brief section 6.8). */
@Composable
fun ScoreScreen(vm: AppViewModel, state: UiState) {
    Title("My score") { vm.go(Page.Home) }
    val s = state.score
    if (s == null) {
        Text(if (state.busy) "Loading…" else "Your score will show when the phone has signal.")
        return
    }
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Text("${s.score}", fontSize = 48.sp, fontWeight = FontWeight.Bold)
            Text(s.positionLabel, fontWeight = FontWeight.Bold, color = if (s.position == "NEEDS_ATTENTION") Amber else Green)
            Text("Based on the last 30 days. Points help a conversation; they never lead to discipline on their own.", color = Color.Gray, fontSize = 13.sp)
        }
    }
    Text("Why it changed", style = MaterialTheme.typography.titleMedium)
    if (s.events.isEmpty()) Text("No changes in the last 30 days.", color = Color.Gray)
    s.events.forEach { e -> ScoreRow(vm, e, state.busy) }
}

@Composable
private fun ScoreRow(vm: AppViewModel, e: ScoreEvent, busy: Boolean) {
    var asking by remember(e.id) { mutableStateOf(false) }
    var text by remember(e.id) { mutableStateOf("") }
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row {
                Text(e.label, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
                val pts = if (e.impact % 1.0 == 0.0) e.impact.toInt().toString() else "%.2f".format(e.impact)
                Text(if (e.impact > 0) "+$pts" else pts, color = if (e.impact < 0) Red else Green, fontWeight = FontWeight.Bold)
            }
            Text("${e.date}${e.siteName?.let { " · $it" } ?: ""}", color = Color.Gray, fontSize = 13.sp)
            if (e.evidence.isNotBlank()) Text(e.evidence)
            if (e.reversedBy != null) Text("Reversed", color = Green)
            when {
                e.queryStatus != null -> {
                    Text("You queried this: “${e.queryText.orEmpty()}”", color = Color.DarkGray)
                    Text(e.queryAnswer?.let { "Answer: $it" } ?: "Waiting for your supervisor's answer${e.queryAnswerDue?.let { " (due $it)" } ?: ""}.", color = Amber)
                }
                e.canQuery && !asking -> OutlinedButton(onClick = { asking = true }) { Text("Query this") }
                e.canQuery -> {
                    OutlinedTextField(text, { text = it.take(2000) }, label = { Text("Why do you disagree?") }, minLines = 2, modifier = Modifier.fillMaxWidth())
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(onClick = { vm.query(e, text); asking = false }, enabled = !busy && text.trim().length >= 5) { Text("Send query") }
                        OutlinedButton(onClick = { asking = false }) { Text("Cancel") }
                    }
                    e.queryUntil?.let { Text("You can query this until $it.", color = Color.Gray, fontSize = 13.sp) }
                }
            }
        }
    }
}

/** The guard's own qualifications and PSIRA registration (brief section 6.9). */
@Composable
fun TrainingScreen(vm: AppViewModel, state: UiState) {
    Title("My training") { vm.go(Page.Home) }
    if (state.training.isEmpty()) Text(if (state.busy) "Loading…" else "Nothing recorded yet.", color = Color.Gray)
    state.training.forEach { q ->
        Card(Modifier.fillMaxWidth()) {
            Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(q.name, fontWeight = FontWeight.Bold)
                    Text(q.expiryDate?.let { "Expires $it" } ?: "Does not expire", color = Color.Gray)
                }
                val (label, colour) = when (q.status) {
                    "EXPIRED" -> "Expired" to Red
                    "EXPIRING" -> "Expiring soon" to Amber
                    else -> "Current" to Green
                }
                Text(label, color = colour, fontWeight = FontWeight.Bold)
            }
        }
    }
}

/** My roster: today and only the days the guard works in the next four weeks. */
@Composable
fun RosterScreen(vm: AppViewModel, state: UiState) {
    Title("My roster") { vm.go(Page.Home) }
    val r = state.roster
    if (r == null) {
        Text(if (state.busy) "Loading…" else "Your roster will show when the phone has signal.", color = Color.Gray)
        return
    }
    Card(Modifier.fillMaxWidth()) {
        Text(r.todayText(), fontWeight = FontWeight.Bold, modifier = Modifier.padding(12.dp))
    }
    if (r.rostered && r.comingUp.isEmpty()) Text("No working days in the next four weeks.", color = Color.Gray)
    r.comingUp.forEach { d ->
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(12.dp)) {
                Text(rosterDate(d.date), fontWeight = FontWeight.Bold)
                Text(d.shiftText(), color = if (d.kind == "night") Color(0xFF1D4F91) else Amber)
            }
        }
    }
}

/** Places a call to an approved number. With On Par as the calling app, the call stays inside On Par. */
private fun placeCall(context: Context, number: String) {
    val tm = context.getSystemService(TelecomManager::class.java)
    tm.placeCall(Uri.fromParts("tel", number, null), Bundle())
}

/** Approved contacts only: no keypad and no other numbers (brief section 6.10). */
@Composable
fun CallScreen(vm: AppViewModel, state: UiState, back: () -> Unit) {
    val context = LocalContext.current
    var pending by remember { mutableStateOf<Contact?>(null) }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        pending?.let { if (ok) placeCall(context, it.phone) }
        pending = null
    }
    val role = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { }
    Title("Call", back)
    Text("Approved contacts, set by your administrator.", color = Color.Gray)
    if (state.contacts.isEmpty()) Text(if (state.busy) "Loading…" else "No contacts are set up for this site yet.", color = Color.Gray)
    state.contacts.forEach { c ->
        Card(Modifier.fillMaxWidth()) {
            Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(c.label, fontWeight = FontWeight.Bold)
                    if (c.name.isNotBlank()) Text(c.name, color = Color.Gray)
                }
                Button(
                    onClick = {
                        if (!vm.canCall(c.phone)) return@Button
                        if (ContextCompat.checkSelfPermission(context, Manifest.permission.CALL_PHONE) == PackageManager.PERMISSION_GRANTED) placeCall(context, c.phone)
                        else { pending = c; ask.launch(Manifest.permission.CALL_PHONE) }
                    },
                    colors = ButtonDefaults.buttonColors(containerColor = Green),
                ) { Text("Call") }
            }
        }
    }
    Text("Calls use the mobile network, so they work without data.", color = Color.Gray, fontSize = 13.sp)
    if (!Kiosk.isCallingApp(context)) {
        Spacer(Modifier.height(8.dp))
        Text("On Par is not yet this phone's calling app, so calls open the normal phone app. On managed phones the administrator sets this.", color = Amber, fontSize = 13.sp)
        OutlinedButton(onClick = { role.launch(Kiosk.callingAppRequest(context)) }) { Text("Make On Par the calling app") }
    }
}

/** A call in progress or ringing, shown over everything else: Answer, Decline, End. */
@Composable
fun InCallScreen(call: CallInfo, contacts: List<Contact>) {
    val who = contacts.firstOrNull { it.phone.filter(Char::isDigit).takeLast(9) == call.number.filter(Char::isDigit).takeLast(9) }
    Column(Modifier.fillMaxWidth().padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Text(
            when {
                call.ringing -> "Incoming call"
                call.active -> "On a call"
                else -> "Calling…"
            },
            color = Color.Gray,
        )
        Text(who?.label ?: call.number.ifBlank { "Unknown number" }, fontSize = 28.sp, fontWeight = FontWeight.Bold)
        who?.name?.takeIf { it.isNotBlank() }?.let { Text(it) }
        if (call.ringing) {
            Button(onClick = { Calls.answer() }, modifier = Modifier.fillMaxWidth().height(64.dp), colors = ButtonDefaults.buttonColors(containerColor = Green)) {
                Text("ANSWER", fontSize = 20.sp, fontWeight = FontWeight.Bold)
            }
            OutlinedButton(onClick = { Calls.decline() }, modifier = Modifier.fillMaxWidth().height(56.dp)) { Text("DECLINE", fontSize = 18.sp) }
        } else {
            Button(onClick = { Calls.end() }, modifier = Modifier.fillMaxWidth().height(64.dp), colors = ButtonDefaults.buttonColors(containerColor = Red)) {
                Text("END CALL", fontSize = 20.sp, fontWeight = FontWeight.Bold)
            }
        }
    }
}
