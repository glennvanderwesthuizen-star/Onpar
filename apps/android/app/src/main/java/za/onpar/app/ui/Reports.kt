package za.onpar.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import za.onpar.app.AppViewModel
import za.onpar.app.Page
import za.onpar.app.UiState
import za.onpar.core.FOLLOW_UP_OUTCOMES
import za.onpar.core.IssuedItem
import za.onpar.core.PRIORITIES
import za.onpar.core.REORDER_STAGES
import za.onpar.core.REPORT_CATEGORIES
import za.onpar.core.REPORT_STAGES
import za.onpar.core.ReportItem
import java.io.File

private fun hex(c: String?, fallback: Color = Color.Gray): Color =
    c?.removePrefix("#")?.toLongOrNull(16)?.let { Color(0xFF000000 or it) } ?: fallback

private val priorityColour = mapOf("green" to Color(0xFF1B7A4E), "amber" to Color(0xFFB86E00), "red" to Color(0xFFB3261E))

/** The report's colour badge with its number (brief section 24). */
@Composable
private fun Badge(number: Int, colour: String?) {
    Box(Modifier.clip(RoundedCornerShape(6.dp)).background(hex(colour)).padding(horizontal = 8.dp, vertical = 2.dp)) {
        Text("#$number", color = Color.White, fontWeight = FontWeight.Bold)
    }
}

@Composable
private fun Header(title: String, back: () -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(title, style = MaterialTheme.typography.headlineSmall, modifier = Modifier.weight(1f))
        OutlinedButton(onClick = back) { Text("Back") }
    }
}

@Composable
private fun Waiting(labels: List<String>) {
    if (labels.isEmpty()) return
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.background(Color(0xFFFDF0DC)).padding(12.dp)) {
            Text("Waiting for signal to send:", fontWeight = FontWeight.Bold)
            labels.forEach { Text("• $it") }
        }
    }
}

@Composable
fun ReportsScreen(vm: AppViewModel, state: UiState) {
    Header("Reports") { vm.go(Page.Home) }
    BigButton("NEW REPORT", enabled = !state.busy) { vm.go(Page.NewReport) }
    Waiting(state.waitingLabels.filter { it.startsWith("Report") })
    val (mine, site) = state.reports.partition { it.mine }
    Text("My reports", style = MaterialTheme.typography.titleMedium)
    if (mine.isEmpty()) Text("None in the last 30 days.", color = Color.Gray)
    mine.forEach { ReportRow(it) { vm.go(Page.Report(it.id)) } }
    if (site.isNotEmpty()) {
        Text("Open at this site", style = MaterialTheme.typography.titleMedium)
        Text("Anyone on site can follow up on these.", color = Color.Gray)
        site.forEach { ReportRow(it) { vm.go(Page.Report(it.id)) } }
    }
    OutlinedButton(onClick = { vm.loadReports() }, modifier = Modifier.fillMaxWidth()) { Text("Refresh") }
}

@Composable
private fun ReportRow(r: ReportItem, onClick: () -> Unit) {
    Card(Modifier.fillMaxWidth().clickable(onClick = onClick)) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Badge(r.number, r.colour)
                Text(REPORT_CATEGORIES[r.category] ?: r.category, fontWeight = FontWeight.Bold)
                Text(PRIORITIES[r.priority] ?: r.priority, color = priorityColour[r.priority] ?: Color.Gray, fontWeight = FontWeight.Bold)
            }
            Text(r.description, maxLines = 2)
            Text(
                (REPORT_STAGES[r.stage] ?: r.stage) + (r.assigneeName?.let { " · $it" } ?: "") + if (r.awaitingInspection) " · please inspect the work" else "",
                color = if (r.awaitingInspection) Color(0xFFB86E00) else Color.DarkGray,
            )
        }
    }
}

@Composable
fun NewReportScreen(vm: AppViewModel, state: UiState) {
    val context = LocalContext.current
    var category by remember { mutableStateOf("") }
    var priority by remember { mutableStateOf("green") }
    var text by remember { mutableStateOf("") }
    val photoFile = remember { File(context.cacheDir, "report-new.jpg") }
    var photo by remember { mutableStateOf(photoFile.takeIf { it.exists() }) }
    var takePhoto by remember { mutableStateOf(false) }
    Header("New report") { vm.go(Page.Reports) }
    Text("What kind of report?", fontWeight = FontWeight.Bold)
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        REPORT_CATEGORIES.entries.chunked(3).forEach { row ->
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                row.forEach { (k, label) -> FilterChip(selected = category == k, onClick = { category = k }, label = { Text(label) }) }
            }
        }
    }
    Text("How urgent?", fontWeight = FontWeight.Bold)
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        PRIORITIES.forEach { (k, label) -> FilterChip(selected = priority == k, onClick = { priority = k }, label = { Text(label, color = priorityColour[k] ?: Color.Unspecified) }) }
    }
    if (priority == "red") Text("Red goes to the site manager as well as your supervisor. For an emergency, also phone.", color = Color(0xFFB3261E))
    OutlinedTextField(text, { text = it.take(4000) }, label = { Text("What did you see?") }, minLines = 3, modifier = Modifier.fillMaxWidth())
    if (takePhoto) PhotoTaker(photoFile, front = false) { photo = it }
    else OutlinedButton(onClick = { takePhoto = true }, modifier = Modifier.fillMaxWidth()) { Text("Add a photo (optional)") }
    BigButton(if (state.busy) "Sending…" else "Send report", enabled = !state.busy && category.isNotEmpty() && text.trim().length >= 3) {
        vm.createReport(category, priority, text, photo)
    }
}

/** A report and its follow-up (brief section 6.6): what the officer found, with a note and photo. */
@Composable
fun ReportScreen(vm: AppViewModel, state: UiState, id: String) {
    val r = state.reports.firstOrNull { it.id == id }
    Header(r?.let { "Report #${it.number}" } ?: "Report") { vm.go(Page.Reports) }
    if (r == null) {
        Text(if (state.busy) "Loading…" else "This report is no longer open here.")
        return
    }
    val context = LocalContext.current
    var outcome by remember(id) { mutableStateOf(if (r.awaitingInspection) "done_ok" else "") }
    var note by remember(id) { mutableStateOf("") }
    val photoFile = remember(id) { File(context.cacheDir, "followup-$id.jpg") }
    var photo by remember(id) { mutableStateOf(photoFile.takeIf { it.exists() }) }
    var takePhoto by remember(id) { mutableStateOf(false) }
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Badge(r.number, r.colour)
                Text(REPORT_CATEGORIES[r.category] ?: r.category, fontWeight = FontWeight.Bold)
                Text(PRIORITIES[r.priority] ?: r.priority, color = priorityColour[r.priority] ?: Color.Gray, fontWeight = FontWeight.Bold)
            }
            Text(r.description)
            Text("Stage: ${REPORT_STAGES[r.stage] ?: r.stage}" + (r.assigneeName?.let { " · assigned to $it" } ?: ""), color = Color.DarkGray)
            r.reportedBy?.let { Text("Reported by $it at ${time(r.reportedAt)}", color = Color.Gray, fontSize = 13.sp) }
        }
    }
    val refusal = r.followUpRefusal
    if (refusal != null) {
        Text(refusal, color = Color.Gray)
        return
    }
    Text(if (r.awaitingInspection) "Inspect the work: is it fixed?" else "Follow up: what did you find?", fontWeight = FontWeight.Bold)
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        FOLLOW_UP_OUTCOMES.forEach { (k, label) -> FilterChip(selected = outcome == k, onClick = { outcome = k }, label = { Text(label) }) }
    }
    OutlinedTextField(note, { note = it.take(2000) }, label = { Text(if (outcome == "not_fixed") "What is still wrong?" else "Note (optional)") }, minLines = 2, modifier = Modifier.fillMaxWidth())
    if (takePhoto) PhotoTaker(photoFile, front = false) { photo = it }
    else OutlinedButton(onClick = { takePhoto = true }, modifier = Modifier.fillMaxWidth()) { Text("Add a photo (optional)") }
    BigButton(if (state.busy) "Sending…" else "Send follow-up", enabled = !state.busy && outcome.isNotEmpty() && (outcome != "not_fixed" || note.isNotBlank())) {
        vm.followUp(r, outcome, note, photo)
    }
}

@Composable
fun ReordersScreen(vm: AppViewModel, state: UiState) {
    Header("Re-orders") { vm.go(Page.Home) }
    BigButton("NEW RE-ORDER", enabled = !state.busy) { vm.go(Page.NewReorder) }
    Waiting(state.waitingLabels.filter { it.contains("re-order", ignoreCase = true) || it.startsWith("Received") })
    if (state.reorders.isEmpty()) Text(if (state.busy) "Loading…" else "No re-orders.", color = Color.Gray)
    state.reorders.forEach { r ->
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                val what = r.item + listOfNotNull(r.size?.let { "size $it" }, r.assetNumber, r.quantity?.takeIf { it.isNotBlank() }).joinToString(", ", " (", ")").takeIf { it != " ()" }.orEmpty()
                Text("#${r.number} $what", fontWeight = FontWeight.Bold)
                Text((if (r.kind == "site") "Site · " else "Personal · ") + (REORDER_STAGES[r.stage] ?: r.stage) + (r.assigneeName?.let { " · $it" } ?: ""), color = Color.DarkGray)
                if (r.canConfirm) OutlinedButton(onClick = { vm.received(r) }, enabled = !state.busy) { Text("I have received it") }
            }
        }
    }
    OutlinedButton(onClick = { vm.loadReorders() }, modifier = Modifier.fillMaxWidth()) { Text("Refresh") }
}

@Composable
fun NewReorderScreen(vm: AppViewModel, state: UiState) {
    var kind by remember { mutableStateOf("personal") }
    var item by remember { mutableStateOf<IssuedItem?>(null) }
    var siteItem by remember { mutableStateOf("") }
    var quantity by remember { mutableStateOf("") }
    var comment by remember { mutableStateOf("") }
    Header("New re-order") { vm.go(Page.Reorders) }
    Text("Is it for you or for the site?", fontWeight = FontWeight.Bold)
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        FilterChip(selected = kind == "personal", onClick = { kind = "personal" }, label = { Text("For me") })
        FilterChip(selected = kind == "site", onClick = { kind = "site" }, label = { Text("For the site") })
    }
    if (kind == "personal") {
        if (state.kit.isEmpty()) Text("No kit is recorded as issued to you. Ask your supervisor.", color = Color.Gray)
        state.kit.forEach { k ->
            FilterChip(
                selected = item?.id == k.id, onClick = { item = k },
                label = { Text(k.item + (k.size?.let { " (size $it)" } ?: k.assetNumber?.let { " ($it)" } ?: "")) },
            )
        }
        item?.let { Text("It is ordered in the size on your profile: ${it.size ?: it.assetNumber ?: "none recorded"}.", color = Color.DarkGray) }
        OutlinedTextField(comment, { comment = it.take(1000) }, label = { Text("Why does it need replacing?") }, minLines = 2, modifier = Modifier.fillMaxWidth())
        BigButton(if (state.busy) "Sending…" else "Send re-order", enabled = !state.busy && item != null && comment.trim().length >= 3) {
            vm.reorderPersonal(item!!, comment)
        }
    } else {
        OutlinedTextField(siteItem, { siteItem = it.take(200) }, label = { Text("What does the site need?") }, placeholder = { Text("e.g. Toilet paper") }, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(quantity, { quantity = it.take(100) }, label = { Text("How many? (optional)") }, placeholder = { Text("e.g. 2 packs") }, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(comment, { comment = it.take(1000) }, label = { Text("Comment (optional)") }, modifier = Modifier.fillMaxWidth())
        BigButton(if (state.busy) "Sending…" else "Send re-order", enabled = !state.busy && siteItem.trim().length >= 2) {
            vm.reorderSite(siteItem, quantity, comment)
        }
    }
}
