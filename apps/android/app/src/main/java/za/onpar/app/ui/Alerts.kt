package za.onpar.app.ui

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import za.onpar.app.AppViewModel
import za.onpar.app.Page
import za.onpar.app.PanicStage
import za.onpar.app.UiState
import za.onpar.core.PANIC_HOLD_MS
import java.io.File

private val PanicRed = Color(0xFFB3261E)
private val PanicDark = Color(0xFF6E120D)
private val BoloBlue = Color(0xFF1D4F91)

/**
 * Asks once for what PANIC needs: location (taken only at the moment of a panic or a
 * scan) and calling. On managed phones the administrator grants these in advance.
 */
@Composable
fun AskForAlertPermissions() {
    val context = LocalContext.current
    val needed = listOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.CALL_PHONE)
        .filter { ContextCompat.checkSelfPermission(context, it) != PackageManager.PERMISSION_GRANTED }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { }
    LaunchedEffect(Unit) { if (needed.isNotEmpty()) ask.launch(needed.toTypedArray()) }
}

/**
 * The red PANIC button. It must be held for two seconds: the red fills up while it is
 * held, and letting go early cancels it, so a brush against the screen does nothing.
 */
@Composable
fun PanicButton(vm: AppViewModel, modifier: Modifier = Modifier, height: Dp = 150.dp, big: Boolean = true) {
    val scope = rememberCoroutineScope()
    val haptic = LocalHapticFeedback.current
    var progress by remember { mutableFloatStateOf(0f) }
    Box(
        modifier
            .height(height)
            .clip(RoundedCornerShape(16.dp))
            .background(PanicRed)
            .semantics { contentDescription = "Panic. Hold for two seconds." }
            .pointerInput(Unit) {
                detectTapGestures(onPress = {
                    val hold = scope.launch {
                        val start = System.currentTimeMillis()
                        while (true) {
                            val p = (System.currentTimeMillis() - start).toFloat() / PANIC_HOLD_MS
                            progress = p.coerceAtMost(1f)
                            if (p >= 1f) {
                                haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                                vm.panic()
                                break
                            }
                            delay(30)
                        }
                    }
                    tryAwaitRelease()
                    hold.cancel()
                    progress = 0f
                })
            },
        contentAlignment = Alignment.Center,
    ) {
        Box(Modifier.align(Alignment.CenterStart).fillMaxHeight().fillMaxWidth(progress).background(PanicDark))
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            if (big) Text("🚨", fontSize = 40.sp)
            Text("PANIC", color = Color.White, fontSize = if (big) 30.sp else 22.sp, fontWeight = FontWeight.Black)
            Text(if (progress > 0f) "Keep holding…" else "Hold 2 seconds", color = Color.White, fontSize = 13.sp)
        }
    }
}

/** A big square button with a symbol, for the front screen. */
@Composable
private fun Tile(symbol: String, label: String, colour: Color, modifier: Modifier, outlined: Boolean = false, onClick: () -> Unit) {
    val shape = RoundedCornerShape(16.dp)
    Box(
        modifier
            .height(150.dp)
            .clip(shape)
            .then(if (outlined) Modifier.border(2.dp, colour, shape) else Modifier.background(colour))
            .clickable(role = Role.Button, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(symbol, fontSize = 40.sp)
            Text(label, color = if (outlined) colour else Color.White, fontSize = 22.sp, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center)
        }
    }
}

/** The front screen before anyone signs in (decision D-27): Sign in, PANIC, BOLO and Call. */
@Composable
fun FrontScreen(vm: AppViewModel, state: UiState) {
    AskForAlertPermissions()
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Tile("👤", "Sign in\nDuty On", Green, Modifier.weight(1f)) { vm.go(Page.SignIn) }
        PanicButton(vm, Modifier.weight(1f))
    }
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Tile("📷", "BOLO", BoloBlue, Modifier.weight(1f)) { vm.go(Page.Bolo) }
        Tile("📞", "Call", Green, Modifier.weight(1f), outlined = true) { vm.go(Page.Call) }
    }
    // Guards on duty on this phone who locked it (D-33): only their PIN brings them back.
    var unlocking by remember { mutableStateOf<za.onpar.core.GuardSession?>(null) }
    if (state.lockedGuards.isNotEmpty()) {
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("On duty on this phone", fontWeight = FontWeight.Bold)
                state.lockedGuards.forEach { g ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(g.name.ifBlank { "Guard" }, Modifier.weight(1f), fontSize = 18.sp)
                        Button(onClick = { unlocking = g }, colors = ButtonDefaults.buttonColors(containerColor = Green)) { Text("Unlock") }
                    }
                }
            }
        }
    }
    unlocking?.let { g ->
        PinDialog("Unlock: ${g.name}", onCancel = { unlocking = null }) { pin ->
            unlocking = null
            vm.unlock(g.number, pin)
        }
    }
    Text("PANIC calls the control room and alerts your supervisors. BOLO sends a photo of something to look out for.", color = Color.Gray, fontSize = 13.sp)
    if (state.waiting > 0) Text("${state.waiting} waiting on the phone to be sent.", color = Color.Gray, fontSize = 13.sp)
}

/** PANIC and BOLO side by side, at the top of the guard's home screen. */
@Composable
fun AlertRow(vm: AppViewModel) {
    AskForAlertPermissions()
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        PanicButton(vm, Modifier.weight(1f), height = 72.dp, big = false)
        Button(
            onClick = { vm.go(Page.Bolo) },
            modifier = Modifier.weight(1f).height(72.dp),
            shape = RoundedCornerShape(16.dp),
            colors = ButtonDefaults.buttonColors(containerColor = BoloBlue),
        ) { Text("📷 BOLO", fontSize = 20.sp, fontWeight = FontWeight.Bold) }
    }
}

/** After PANIC: what the phone did, so the guard knows help has been asked for. */
@Composable
fun PanicSentScreen(vm: AppViewModel, state: UiState) {
    val p = state.panic
    if (p == null) {
        LaunchedEffect(Unit) { vm.panicDone() }
        return
    }
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.background(PanicRed).fillMaxWidth().padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                when (p.stage) {
                    PanicStage.Sending -> "Sending PANIC…"
                    PanicStage.Sent -> "PANIC SENT"
                    PanicStage.Saved -> "PANIC SAVED"
                    PanicStage.Refused -> "PANIC NOT SENT"
                },
                color = Color.White, fontSize = 30.sp, fontWeight = FontWeight.Black,
            )
            Text(
                when (p.stage) {
                    PanicStage.Sending -> "Taking your location and alerting your supervisors."
                    PanicStage.Sent -> "Your supervisors can see it on the website now" + if (p.located) ", with your location." else " (the phone could not get a location)."
                    PanicStage.Saved -> "No signal. It will be sent the moment the phone has signal. Phone for help."
                    PanicStage.Refused -> "The server refused it: ${p.refusal}. Phone for help."
                },
                color = Color.White, fontSize = 17.sp,
            )
            if (p.stage == PanicStage.Sending) CircularProgressIndicator(color = Color.White)
        }
    }
    if (p.callProblem == null) Text("Calling the control room…", fontWeight = FontWeight.Bold)
    else Text(p.callProblem, color = PanicRed, fontWeight = FontWeight.Bold)
    p.controlRoom?.let {
        Button(onClick = { vm.callControlRoom() }, modifier = Modifier.fillMaxWidth().height(64.dp), colors = ButtonDefaults.buttonColors(containerColor = Green)) {
            Text("📞 Call control room again", fontSize = 18.sp, fontWeight = FontWeight.Bold)
        }
    }
    OutlinedButton(onClick = { vm.go(Page.Call) }, modifier = Modifier.fillMaxWidth().height(56.dp)) { Text("Other contacts", fontSize = 18.sp) }
    OutlinedButton(onClick = { vm.panicDone() }, enabled = p.stage != PanicStage.Sending, modifier = Modifier.fillMaxWidth()) { Text("Done") }
}

/** BOLO, "be on the lookout": a photo and a short note, sent to the supervisors under Reports. */
@Composable
fun BoloScreen(vm: AppViewModel, state: UiState) {
    val context = LocalContext.current
    val photoFile = remember { File(context.cacheDir, "bolo-new.jpg") }
    var photo by remember { mutableStateOf(photoFile.takeIf { it.exists() && it.length() > 0 }) }
    var note by remember { mutableStateOf("") }
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text("BOLO: be on the lookout", style = MaterialTheme.typography.headlineSmall, modifier = Modifier.weight(1f))
        OutlinedButton(onClick = { vm.go(Page.Home) }) { Text("Back") }
    }
    Text("Take a photo of the person or vehicle and say what to look out for. Your supervisors see it under Reports.", color = Color.Gray)
    PhotoTaker(photoFile, front = false) { photo = it }
    OutlinedTextField(
        note, { note = it.take(2000) },
        label = { Text("What to look out for") },
        placeholder = { Text("For example: white Toyota Hilux CA 123-456, circled the block three times") },
        minLines = 3, modifier = Modifier.fillMaxWidth(),
    )
    BigButton(if (state.busy) "Sending…" else "Send BOLO", enabled = !state.busy && note.trim().length >= 3) {
        vm.bolo(note, photo)
    }
    if (photo == null) Text("A photo is best, but you can send the note on its own.", color = Color.Gray, fontSize = 13.sp)
}
