package za.onpar.app.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Card
import androidx.compose.material3.FilterChip
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
import za.onpar.app.AppViewModel
import za.onpar.app.Page
import za.onpar.app.UiState
import za.onpar.core.COULD_NOT_COMPLETE_REASONS
import za.onpar.core.TaskActions
import za.onpar.core.TaskItem
import java.io.File
import java.time.LocalTime

private val Amber = Color(0xFFB86E00)
private val Red = Color(0xFFB3261E)

/** Where a task stands, in words and colour. */
private fun status(t: TaskItem, now: LocalTime): Pair<String, Color> = when {
    t.waiting && t.state == "completed" -> "Done · waiting to send" to Amber
    t.waiting -> "Could not complete · waiting to send" to Amber
    t.state == "completed" -> "Done" to Green
    t.state == "could_not_complete" -> "Could not complete" to Amber
    t.state == "missed" -> "Missed" to Red
    t.isInspection -> "Inspection: tap to record it on the report" to Amber
    t.overdue(now) -> "Overdue (due ${t.dueTime})" to Red
    t.dueTime != null -> "Due ${t.dueTime}" to Color.DarkGray
    else -> "Any time during the shift" to Color.DarkGray
}

@Composable
fun TasksScreen(vm: AppViewModel, state: UiState) {
    val now = LocalTime.now(TaskActions.SAST)
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text("Today's tasks", style = MaterialTheme.typography.headlineSmall, modifier = Modifier.weight(1f))
        OutlinedButton(onClick = { vm.go(Page.Home) }) { Text("Back") }
    }
    if (state.tasks.isEmpty()) Text(if (state.busy) "Loading…" else "No tasks today.")
    val (open, done) = state.tasks.partition { it.isOpen && !it.isInspection }
    open.sortedBy { it.dueTime ?: "99:99" }.forEach { TaskRow(it, now) { vm.go(Page.Task(it.id)) } }
    if (done.isNotEmpty()) Text("Done and other", style = MaterialTheme.typography.titleMedium)
    done.forEach { t -> TaskRow(t, now, onClick = if (t.isInspection && t.isOpen && t.reportId != null) ({ vm.go(Page.Report(t.reportId!!)) }) else null) }
    OutlinedButton(onClick = { vm.loadTasks() }, modifier = Modifier.fillMaxWidth()) { Text("Refresh") }
}

@Composable
private fun TaskRow(t: TaskItem, now: LocalTime, onClick: (() -> Unit)?) {
    val (label, colour) = status(t, now)
    Card(Modifier.fillMaxWidth().let { if (onClick != null) it.clickable(onClick = onClick) else it }) {
        Column(Modifier.padding(14.dp)) {
            Text(t.title, fontWeight = FontWeight.Bold)
            Text(label + if (t.photoRequired && t.isOpen) " · photo needed" else "", color = colour)
        }
    }
}

/** One task: instructions, then Done (with a photo if needed) or Could not complete (with a reason). */
@Composable
fun TaskScreen(vm: AppViewModel, state: UiState, id: String) {
    val t = state.tasks.firstOrNull { it.id == id }
    if (t == null) {
        Text("This task is no longer in today's list.")
        OutlinedButton(onClick = { vm.go(Page.Tasks) }) { Text("Back") }
        return
    }
    val context = LocalContext.current
    val photoFile = remember(id) { File(context.cacheDir, "task-$id.jpg") }
    var photo by remember(id) { mutableStateOf(photoFile.takeIf { it.exists() }) }
    var takePhoto by remember(id) { mutableStateOf(t.photoRequired) }
    var comment by remember(id) { mutableStateOf("") }
    var cannot by remember(id) { mutableStateOf(false) }
    var reason by remember(id) { mutableStateOf("") }

    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(t.title, style = MaterialTheme.typography.headlineSmall, modifier = Modifier.weight(1f))
        OutlinedButton(onClick = { vm.go(Page.Tasks) }) { Text("Back") }
    }
    Text(t.dueTime?.let { "Due $it" } ?: "Any time during the shift", color = Color.DarkGray)
    if (t.instructions.isNotBlank()) Card(Modifier.fillMaxWidth()) { Text(t.instructions, Modifier.padding(14.dp)) }

    if (!cannot) {
        if (t.photoRequired) Text("A photo is needed for this task.", fontWeight = FontWeight.Bold)
        if (takePhoto) PhotoTaker(photoFile, front = false) { photo = it }
        else OutlinedButton(onClick = { takePhoto = true }, modifier = Modifier.fillMaxWidth()) { Text("Add a photo (optional)") }
        OutlinedTextField(comment, { comment = it.take(2000) }, label = { Text("Comment (optional)") }, minLines = 2, modifier = Modifier.fillMaxWidth())
        BigButton(if (state.busy) "Saving…" else "Done", enabled = !state.busy && (!t.photoRequired || photo != null)) {
            vm.completeTask(t, comment, photo)
        }
        OutlinedButton(onClick = { cannot = true }, modifier = Modifier.fillMaxWidth()) { Text("I could not complete this task") }
    } else {
        Text("Why could you not complete it?", fontWeight = FontWeight.Bold)
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            COULD_NOT_COMPLETE_REASONS.forEach { (k, label) ->
                FilterChip(selected = reason == k, onClick = { reason = k }, label = { Text(label) })
            }
        }
        OutlinedTextField(comment, { comment = it.take(2000) }, label = { Text(if (reason == "other") "What happened?" else "Comment (optional)") }, minLines = 2, modifier = Modifier.fillMaxWidth())
        if (takePhoto) PhotoTaker(photoFile, front = false) { photo = it }
        else OutlinedButton(onClick = { takePhoto = true }, modifier = Modifier.fillMaxWidth()) { Text("Add a photo (optional)") }
        Text("There is no penalty until your supervisor reviews it.", color = Color.Gray)
        BigButton(if (state.busy) "Saving…" else "Send", enabled = !state.busy && reason.isNotEmpty() && (reason != "other" || comment.isNotBlank())) {
            vm.cannotCompleteTask(t, reason, comment, photo)
        }
        OutlinedButton(onClick = { cannot = false }, modifier = Modifier.fillMaxWidth()) { Text("Cancel") }
    }
}
