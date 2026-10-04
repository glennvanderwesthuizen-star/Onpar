package za.onpar.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Card
import androidx.compose.material3.Checkbox
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import za.onpar.app.AppViewModel
import za.onpar.core.PendingDeclaration
import java.io.File

/**
 * The declaration after Duty On or Duty From (brief section 6.2, scenario 10): the guard
 * cannot go on until every statement is ticked and the selfie is taken.
 */
@Composable
fun DeclarationScreen(vm: AppViewModel, owed: PendingDeclaration, busy: Boolean) {
    val context = LocalContext.current
    val ticks = remember(owed.dutyEventId) { mutableStateListOf(*Array(owed.wording.statements.size) { false }) }
    var comment by remember(owed.dutyEventId) { mutableStateOf("") }
    var report by remember(owed.dutyEventId) { mutableStateOf(false) }
    var priority by remember(owed.dutyEventId) { mutableStateOf("green") }
    val selfieFile = remember(owed.dutyEventId) { File(context.cacheDir, "selfie-${owed.dutyEventId}.jpg") }
    var selfie by remember(owed.dutyEventId) { mutableStateOf(selfieFile.takeIf { it.exists() }) }
    val title = if (owed.kind == "duty_from") "Duty From declaration" else "Duty On declaration"

    Text(title, style = MaterialTheme.typography.headlineSmall)
    Text("Tick each statement that is true, then take your selfie.")
    owed.wording.statements.forEachIndexed { i, s ->
        Card(Modifier.fillMaxWidth()) {
            Row(Modifier.padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Checkbox(checked = ticks[i], onCheckedChange = { ticks[i] = it })
                Text(s, Modifier.weight(1f))
            }
        }
    }
    Text("If a statement is not true, do not tick it: add a comment and call your supervisor.", color = Color.Gray)
    OutlinedTextField(comment, { comment = it.take(2000) }, label = { Text("Comment (optional)") }, minLines = 2, modifier = Modifier.fillMaxWidth())
    if (comment.isNotBlank()) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Switch(checked = report, onCheckedChange = { report = it })
            Text("  Raise this as an equipment report")
        }
        if (report) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf("green" to "Green", "amber" to "Amber", "red" to "Red").forEach { (k, label) ->
                    FilterChip(selected = priority == k, onClick = { priority = k }, label = { Text(label) })
                }
            }
        }
    }
    Text("Selfie", style = MaterialTheme.typography.titleMedium)
    var liveness by remember { mutableStateOf<String?>(null) }
    PhotoTaker(selfieFile, front = true, onLiveness = { liveness = it }) { selfie = it }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        val ready = ticks.all { it } && selfie != null && (!report || comment.isNotBlank())
        if (!ticks.all { it }) Text("Tick every statement to continue.", color = Color(0xFFB86E00))
        else if (selfie == null) Text("Take your selfie to continue.", color = Color(0xFFB86E00))
        BigButton(if (busy) "Saving…" else "Submit declaration", enabled = ready && !busy) {
            vm.declare(owed, ticks.toList(), comment, report && comment.isNotBlank(), priority, selfieFile, liveness)
        }
    }
}
