package za.onpar.app.ui

import android.content.Context
import android.media.AudioManager
import android.media.ToneGenerator
import android.os.VibrationEffect
import android.os.Vibrator
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import za.onpar.app.AppViewModel
import za.onpar.app.Page
import za.onpar.app.UiState
import za.onpar.core.LocalPatrol
import za.onpar.core.PatrolPoint
import java.io.File
import java.time.Duration
import java.time.Instant

private val Red = Color(0xFFB3261E)
private val Amber = Color(0xFFB86E00)

@Composable
fun PatrolsScreen(vm: AppViewModel, state: UiState) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text("Patrols", style = MaterialTheme.typography.headlineSmall, modifier = Modifier.weight(1f))
        OutlinedButton(onClick = { vm.go(Page.Home) }) { Text("Back") }
    }
    val s = state.patrols
    val active = state.activePatrol
    if (active != null) ActivePatrolCard(vm, active, s?.types?.firstOrNull { it.id == active.typeId }?.points.orEmpty(), state.busy)
    BigButton("SCAN A POINT", enabled = !state.busy) { vm.go(Page.PatrolScan) }
    when {
        s == null -> Text(if (state.busy) "Loading…" else "Patrols will show when the phone has signal.")
        !s.onDuty -> Text("Log Duty On before patrolling.")
        s.types.isEmpty() -> Text("No patrols are set up for this site and shift.")
        else -> s.types.forEach { t ->
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(14.dp)) {
                    Text("${t.code}. ${t.name}", fontWeight = FontWeight.Bold)
                    Text("${t.done} of ${t.perShift} done this shift · ${t.points.size} points · ${t.maxDurationMinutes} min to finish")
                    when {
                        active != null && active.typeId == t.id -> Text("In progress", color = Green)
                        t.canStart -> Text("Ready to start: scan any point", color = Green)
                        else -> Text(t.reason ?: "Not open yet" + (t.opensAt?.let { " · opens ${time(it)}" } ?: ""), color = Amber)
                    }
                }
            }
        }
    }
    OutlinedButton(onClick = { vm.loadPatrols() }, modifier = Modifier.fillMaxWidth()) { Text("Refresh") }
}

/** The patrol in progress: points done, and the time left, counting down on the phone even with no signal. */
@Composable
private fun ActivePatrolCard(vm: AppViewModel, p: LocalPatrol, points: List<PatrolPoint>, busy: Boolean) {
    val context = LocalContext.current
    var now by remember { mutableStateOf(Instant.now()) }
    LaunchedEffect(p.id) {
        var alarmed = false
        while (true) {
            now = Instant.now()
            if (!alarmed && now.isAfter(p.deadline())) {
                alarmed = true
                alarm(context)
            }
            delay(1000)
        }
    }
    val left = Duration.between(now, p.deadline())
    val over = left.isNegative
    var ending by remember(p.id) { mutableStateOf(false) }
    var reason by remember(p.id) { mutableStateOf("") }
    Card(Modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = if (over) Color(0xFFFBE3E0) else Color(0xFFDFF3E7))) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text("${p.typeName} in progress", fontWeight = FontWeight.Bold)
            val mins = kotlin.math.abs(left.toMinutes())
            val secs = kotlin.math.abs(left.seconds % 60)
            Text(
                if (over) "OVERDUE by %d:%02d. Your supervisor has been alerted.".format(mins, secs) else "Time left %d:%02d".format(mins, secs),
                color = if (over) Red else Green, fontSize = 22.sp, fontWeight = FontWeight.Bold,
            )
            Text("${p.done.size} of ${p.pointIds.size} points done")
            points.filter { it.id in p.pointIds }.forEach { pt ->
                val mark = when (pt.id) {
                    in p.done -> "✓"
                    in p.scanned -> "…"
                    else -> "○"
                }
                Row {
                    Text("$mark  ${pt.name}", Modifier.weight(1f))
                    if (pt.id in p.scanned && pt.id !in p.done) {
                        OutlinedButton(onClick = { vm.go(Page.PatrolPoint(p.id, pt)) }) { Text("Finish checks") }
                    }
                }
            }
            if (!ending) OutlinedButton(onClick = { ending = true }) { Text("I cannot finish this patrol") }
            else {
                OutlinedTextField(reason, { reason = it.take(500) }, label = { Text("Why?") }, modifier = Modifier.fillMaxWidth())
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = { vm.endPatrolEarly(p.id, reason) }, enabled = !busy && reason.trim().length >= 3) { Text("End patrol") }
                    OutlinedButton(onClick = { ending = false }) { Text("Cancel") }
                }
            }
        }
    }
}

/** A short alarm when the patrol runs over its time, also with no signal (brief section 6.5). */
private fun alarm(context: Context) {
    runCatching { ToneGenerator(AudioManager.STREAM_ALARM, 100).startTone(ToneGenerator.TONE_CDMA_ALERT_CALL_GUARD, 2000) }
    runCatching {
        @Suppress("DEPRECATION")
        (context.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator).vibrate(VibrationEffect.createWaveform(longArrayOf(0, 600, 300, 600, 300, 600), -1))
    }
}

@Composable
fun PatrolScanScreen(vm: AppViewModel, state: UiState) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text("Scan the point's code", style = MaterialTheme.typography.headlineSmall, modifier = Modifier.weight(1f))
        OutlinedButton(onClick = { vm.go(Page.Patrols) }) { Text("Back") }
    }
    val acc = state.gpsAccuracy
    if (acc != null) {
        Text("Getting your location…", fontWeight = FontWeight.Bold)
        Text(if (acc < 0) "Stand still in the open." else "Accuracy %.0f m (needs 25 m or better)".format(acc))
    } else {
        Text("Hold the phone steady over the QR code. Your location is checked only at this moment.")
        QrScanner(onCode = { code -> if (!state.busy) vm.scanCode(code) })
    }
}

/** The checks at a scanned point: instruction, photo, note and readings (brief section 6.5, scenario 7). */
@Composable
fun PatrolPointScreen(vm: AppViewModel, state: UiState, patrolId: String, point: PatrolPoint) {
    val context = LocalContext.current
    val photoFile = remember(point.id) { File(context.cacheDir, "patrol-${point.id}.jpg") }
    var photo by remember(point.id) { mutableStateOf(photoFile.takeIf { it.exists() }) }
    var takePhoto by remember(point.id) { mutableStateOf(point.photoMode == "required") }
    var note by remember(point.id) { mutableStateOf("") }
    val numbers = remember(point.id) { mutableStateMapOf<String, String>() }
    val oks = remember(point.id) { mutableStateMapOf<String, Boolean>() }
    val checkPhotos = remember(point.id) { mutableStateMapOf<String, File>() }

    Text(point.name, style = MaterialTheme.typography.headlineSmall)
    if (point.instruction.isNotBlank()) {
        Card(Modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = Color(0xFFFDF0DC))) {
            Text(point.instruction, Modifier.padding(14.dp), fontWeight = FontWeight.Bold)
        }
    }
    point.checks.forEach { c ->
        when (c.kind) {
            "number" -> {
                val v = numbers[c.id].orEmpty()
                OutlinedTextField(
                    v, { numbers[c.id] = it.filter { ch -> ch.isDigit() || ch == '.' || ch == ',' }.replace(',', '.').take(10) },
                    label = { Text("${c.label}${c.unit?.takeIf { it.isNotBlank() }?.let { " ($it)" } ?: ""}") },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), singleLine = true, modifier = Modifier.fillMaxWidth(),
                )
                if (c.outOfLimit(v.toDoubleOrNull())) Text("Outside the limit: a report will be raised automatically.", color = Amber)
            }
            "ok_problem" -> {
                Text(c.label, fontWeight = FontWeight.Bold)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    FilterChip(selected = oks[c.id] == true, onClick = { oks[c.id] = true }, label = { Text("OK") })
                    FilterChip(selected = oks[c.id] == false, onClick = { oks[c.id] = false }, label = { Text("Problem") })
                }
                if (oks[c.id] == false) Text("A report will be raised automatically.", color = Amber)
            }
            "photo" -> {
                Text(c.label, fontWeight = FontWeight.Bold)
                val f = remember(point.id, c.id) { File(context.cacheDir, "patrol-${point.id}-${c.id}.jpg") }
                PhotoTaker(f, front = false) { taken ->
                    checkPhotos.remove(c.id)
                    if (taken != null) checkPhotos.put(c.id, taken)
                }
            }
        }
    }
    if (point.photoMode != "off") {
        Text(if (point.photoMode == "required") "Photo (required)" else "Photo (optional)", fontWeight = FontWeight.Bold)
        if (takePhoto) PhotoTaker(photoFile, front = false) { photo = it }
        else OutlinedButton(onClick = { takePhoto = true }, modifier = Modifier.fillMaxWidth()) { Text("Add a photo") }
    }
    if (point.noteMode != "off") {
        OutlinedTextField(note, { note = it.take(2000) }, label = { Text(if (point.noteMode == "required") "Note (required)" else "Note (optional)") }, minLines = 2, modifier = Modifier.fillMaxWidth())
    }
    val ready = (point.photoMode != "required" || photo != null) && (point.noteMode != "required" || note.isNotBlank()) &&
        point.checks.all { c ->
            when (c.kind) {
                "number" -> numbers[c.id]?.toDoubleOrNull() != null
                "ok_problem" -> oks[c.id] != null
                else -> checkPhotos[c.id] != null
            }
        }
    BigButton(if (state.busy) "Saving…" else "Save and continue", enabled = ready && !state.busy) {
        vm.savePoint(patrolId, point, note, photo, numbers.mapNotNull { (k, v) -> v.toDoubleOrNull()?.let { k to it } }.toMap(), oks.toMap(), checkPhotos.toMap())
    }
    OutlinedButton(onClick = { vm.go(Page.Patrols) }, modifier = Modifier.fillMaxWidth()) { Text("Back (finish later)") }
}
