package za.onpar.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import za.onpar.app.AppViewModel
import za.onpar.app.Page
import za.onpar.app.UiState

/**
 * MY MESSAGES (owner, 9 Oct 2026, D-52): the HR notices of the guard holding the phone, signed
 * in with his own PIN. Another guard on the same phone sees only his own.
 */
@Composable
fun MessagesScreen(vm: AppViewModel, state: UiState) {
    Text("My messages", style = MaterialTheme.typography.titleLarge)
    Text("Only you can see these, while you hold the phone. Lock the phone when you hand it over.", color = Color.DarkGray)
    val list = state.notices
    if (list == null) {
        Text(if (state.busy) "Loading…" else "Your messages need signal. Try again when the phone has signal.", color = Color.DarkGray)
    } else if (list.notices.isEmpty()) {
        Text("You have no messages.", color = Color.DarkGray)
    } else {
        list.notices.forEach { n ->
            Card(Modifier.fillMaxWidth().clickable { vm.go(Page.Message(n.id)) }) {
                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(n.subject, fontWeight = FontWeight.Bold, fontSize = 17.sp)
                    Text("${n.typeLabel} · ${date(n.issuedAt)}", color = Color.DarkGray, fontSize = 13.sp)
                    Text(if (n.acknowledged != null) "Acknowledged" else "Please read", color = if (n.acknowledged != null) Color(0xFF0C4A34) else Color(0xFFB86E00), fontWeight = FontWeight.Bold)
                }
            }
        }
    }
    OutlinedButton(onClick = { vm.go(Page.Home) }, modifier = Modifier.fillMaxWidth().height(52.dp)) { Text("Back") }
}

@Composable
fun MessageScreen(vm: AppViewModel, state: UiState, id: String) {
    val n = state.notice?.takeIf { it.id == id }
    if (n == null) {
        Text(if (state.busy) "Opening…" else "This message needs signal.", color = Color.DarkGray)
    } else {
        Text("${n.typeLabel} · ${date(n.issuedAt)}", color = Color.DarkGray, fontSize = 13.sp)
        Text(n.subject, style = MaterialTheme.typography.titleLarge)
        Card(Modifier.fillMaxWidth()) { Text(n.body, Modifier.padding(12.dp)) }
        n.documents.forEach { d ->
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(d.title, fontWeight = FontWeight.Bold)
                    Text(d.body)
                }
            }
        }
        if (n.acknowledged != null) {
            Text("You acknowledged receipt.", Modifier.background(Color(0xFFDFF3E7)).padding(12.dp).fillMaxWidth(), fontWeight = FontWeight.Bold)
        } else {
            Text(n.ackText)
            BigButton(if (state.busy) "Saving…" else "I ACKNOWLEDGE RECEIPT", enabled = !state.busy) { vm.acknowledgeNotice(id) }
            Text("If you do not agree, you may still acknowledge receipt, and then speak to HR or your representative.", color = Color.DarkGray, fontSize = 13.sp)
        }
    }
    OutlinedButton(onClick = { vm.go(Page.Messages) }, modifier = Modifier.fillMaxWidth().height(52.dp)) { Text("Back to my messages") }
}

private fun date(iso: String?): String = iso?.let { runCatching { java.time.format.DateTimeFormatter.ofPattern("d MMM yyyy, HH:mm").format(java.time.Instant.parse(it).atZone(java.time.ZoneId.of("Africa/Johannesburg"))) }.getOrNull() } ?: ""
