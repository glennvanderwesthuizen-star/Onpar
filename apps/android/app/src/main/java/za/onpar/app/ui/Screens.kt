package za.onpar.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import za.onpar.app.AppViewModel
import za.onpar.core.TsfNumber
import za.onpar.core.rosterDate
import za.onpar.core.shiftText
import za.onpar.core.todayText
import za.onpar.app.Calls
import androidx.compose.runtime.collectAsState
import za.onpar.app.Page
import za.onpar.app.Screen
import za.onpar.app.UiState
import za.onpar.core.DutyKind
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

val Green = Color(0xFF0C4A34)
private val SAST: ZoneId = ZoneId.of("Africa/Johannesburg")
private val HHMM: DateTimeFormatter = DateTimeFormatter.ofPattern("HH:mm").withZone(SAST)
fun time(iso: String?): String = iso?.let { runCatching { HHMM.format(Instant.parse(it)) }.getOrNull() } ?: "—"

@Composable
fun OnParScreens(state: UiState, vm: AppViewModel) {
    // safeDrawingPadding keeps everything clear of the phone's own status bar, navigation buttons and
    // keyboard, so nothing (such as Log out at the bottom) is hidden behind them.
    // A call, ringing or in progress, comes before everything else (brief section 6.10).
    val call by Calls.current.collectAsState()
    val current = call
    if (current != null) {
        Column(Modifier.fillMaxSize().safeDrawingPadding()) {
            StatusBar(state)
            InCallScreen(current, state.contacts)
        }
        return
    }
    Column(Modifier.fillMaxSize().safeDrawingPadding()) {
        StatusBar(state)
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            state.error?.let { Banner(it, Color(0xFFFBE3E0)) { vm.dismiss() } }
            state.message?.let { Banner(it, Color(0xFFDFF3E7)) { vm.dismiss() } }
            when (state.screen) {
                Screen.Setup -> SetupScreen(vm, state.busy)
                // Before sign-in: the front screen (decision D-27), from which Panic, BOLO and Call work without signing in.
                Screen.Login -> when (state.page) {
                    Page.Call -> CallScreen(vm, state) { vm.go(Page.Home) }
                    Page.SignIn -> LoginScreen(vm, state.busy)
                    Page.Bolo -> BoloScreen(vm, state)
                    Page.PanicSent -> PanicSentScreen(vm, state)
                    else -> FrontScreen(vm, state)
                }
                Screen.Home -> when (val page = state.page) {
                    Page.Home -> HomeScreen(vm, state)
                    Page.Tasks -> if (state.owed != null) HomeScreen(vm, state) else TasksScreen(vm, state)
                    is Page.Task -> if (state.owed != null) HomeScreen(vm, state) else TaskScreen(vm, state, page.id)
                    Page.Patrols -> if (state.owed != null) HomeScreen(vm, state) else PatrolsScreen(vm, state)
                    Page.PatrolScan -> if (state.owed != null) HomeScreen(vm, state) else PatrolScanScreen(vm, state)
                    is Page.PatrolPoint -> if (state.owed != null) HomeScreen(vm, state) else PatrolPointScreen(vm, state, page.patrolId, page.point)
                    Page.Reports -> if (state.owed != null) HomeScreen(vm, state) else ReportsScreen(vm, state)
                    Page.NewReport -> if (state.owed != null) HomeScreen(vm, state) else NewReportScreen(vm, state)
                    is Page.Report -> if (state.owed != null) HomeScreen(vm, state) else ReportScreen(vm, state, page.id)
                    Page.Reorders -> if (state.owed != null) HomeScreen(vm, state) else ReordersScreen(vm, state)
                    Page.Uniform -> if (state.owed != null) HomeScreen(vm, state) else UniformScreen(vm, state)
                    Page.NewReorder -> if (state.owed != null) HomeScreen(vm, state) else NewReorderScreen(vm, state)
                    Page.Score -> if (state.owed != null) HomeScreen(vm, state) else ScoreScreen(vm, state)
                    Page.Training -> if (state.owed != null) HomeScreen(vm, state) else TrainingScreen(vm, state)
                    Page.Roster -> if (state.owed != null) HomeScreen(vm, state) else RosterScreen(vm, state)
                    Page.Visitors -> if (state.owed != null) HomeScreen(vm, state) else VisitorsScreen(vm, state)
                    Page.NewVisitor -> if (state.owed != null) HomeScreen(vm, state) else NewVisitorScreen(vm, state)
                    Page.ExpectedVisitor -> if (state.owed != null) HomeScreen(vm, state) else ExpectedVisitorScreen(vm, state)
                    is Page.Visit -> if (state.owed != null) HomeScreen(vm, state) else VisitScreen(vm, state, page.id)
                    // Calling is always allowed, even with a declaration owed.
                    Page.Call -> CallScreen(vm, state) { vm.go(Page.Home) }
                    // Panic and BOLO are always allowed too.
                    Page.PanicSent -> PanicSentScreen(vm, state)
                    Page.Bolo -> BoloScreen(vm, state)
                    Page.SignIn -> HomeScreen(vm, state)
                }
            }
        }
    }
}

@Composable
private fun StatusBar(state: UiState) {
    Row(
        Modifier.fillMaxWidth().background(Green).padding(horizontal = 16.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        val context = androidx.compose.ui.platform.LocalContext.current
        val build = remember { runCatching { context.packageManager.getPackageInfo(context.packageName, 0).versionName }.getOrNull() }
        Row(verticalAlignment = Alignment.Bottom) {
            Text("On Par", color = Color.White, fontWeight = FontWeight.Bold, fontSize = 18.sp)
            build?.let { Text("  build $it", color = Color.White, fontSize = 11.sp) }
        }
        val net = if (state.online) "Online" else "No signal"
        Text(if (state.waiting > 0) "$net · ${state.waiting} waiting" else net, color = Color.White, fontSize = 13.sp)
    }
}

@Composable
private fun Banner(text: String, colour: Color, onClose: () -> Unit) {
    Card(Modifier.fillMaxWidth()) {
        Row(Modifier.background(colour).padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(text, Modifier.weight(1f))
            TextButton(onClick = onClose) { Text("OK") }
        }
    }
}

@Composable
fun BigButton(text: String, enabled: Boolean = true, onClick: () -> Unit) {
    Button(
        onClick = onClick,
        enabled = enabled,
        modifier = Modifier.fillMaxWidth().height(64.dp),
        colors = ButtonDefaults.buttonColors(containerColor = Green),
    ) { Text(text, fontSize = 20.sp, fontWeight = FontWeight.Bold) }
}

@Composable
private fun SetupScreen(vm: AppViewModel, busy: Boolean) {
    var manual by remember { mutableStateOf(false) }
    var hint by remember { mutableStateOf<String?>(null) }
    Text("Set up this phone", style = MaterialTheme.typography.headlineSmall)
    Text("A supervisor registers the phone on the On Par website (Devices), then scans the code shown there with this phone.")
    if (!manual) {
        QrScanner(onCode = { code -> if (!busy && !vm.setupFromQr(code)) hint = "That is not an On Par setup code." })
        hint?.let { Text(it, color = Color(0xFFB3261E)) }
        TextButton(onClick = { manual = true }) { Text("Type the details instead") }
    } else {
        var server by remember { mutableStateOf("https://") }
        var key by remember { mutableStateOf("") }
        OutlinedTextField(server, { server = it }, label = { Text("Server address") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(key, { key = it }, label = { Text("Device key") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        BigButton(if (busy) "Checking…" else "Set up", enabled = !busy) { vm.setupManually(server, key) }
        TextButton(onClick = { manual = false }) { Text("Scan the code instead") }
    }
}

/**
 * Sign-in: the guard scans his ID card (QR code with his TSF number), sees his number plate,
 * then types his PIN, every time. Typing the number is the fallback for a lost or damaged card.
 */
@Composable
private fun LoginScreen(vm: AppViewModel, busy: Boolean) {
    var number by remember { mutableStateOf("") }
    var typing by remember { mutableStateOf(false) }
    var hint by remember { mutableStateOf<String?>(null) }
    var pin by remember { mutableStateOf("") }
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text("Log in", style = MaterialTheme.typography.headlineSmall, modifier = Modifier.weight(1f))
        OutlinedButton(onClick = { vm.go(Page.Home) }) { Text("Back") }
    }
    if (number.isEmpty() && !typing) {
        Text("Scan your ID card", fontWeight = FontWeight.Bold, fontSize = 20.sp)
        Text("Hold the QR code on your card in front of the camera.")
        QrScanner(onCode = { code ->
            if (TsfNumber.isIdCard(code)) {
                number = code.trim()
                hint = null
            } else {
                hint = "That is not an On Par ID card."
            }
        })
        hint?.let { Text(it, color = Color(0xFFB3261E)) }
        TextButton(onClick = { typing = true }) { Text("No card? Type your TSF number") }
    } else {
        if (typing && TsfNumber.normalise(number) == null) {
            OutlinedTextField(
                number, { number = it.uppercase().filter { c -> c.isLetterOrDigit() || c == ' ' }.take(12) },
                label = { Text("TSF number, e.g. BCD 123 GP") }, singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Ascii, capitalization = KeyboardCapitalization.Characters),
                modifier = Modifier.fillMaxWidth(),
            )
        } else if (TsfNumber.normalise(number) != null) {
            TsfPlate(TsfNumber.normalise(number)!!)
        } else {
            Text("ID card read. Now type your PIN.", fontWeight = FontWeight.Bold, fontSize = 20.sp, color = Green)
        }
        OutlinedTextField(
            pin, { pin = it.filter(Char::isDigit).take(6) },
            label = { Text("PIN") }, singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
            modifier = Modifier.fillMaxWidth(),
        )
        BigButton(if (busy) "Checking…" else "Log in", enabled = !busy && number.isNotBlank() && pin.length >= 4) {
            vm.signIn(number, pin)
            pin = ""
        }
        TextButton(onClick = { number = ""; typing = false; pin = "" }) { Text("Not you? Scan again") }
    }
    Text("Five wrong PINs lock your login until your supervisor resets it.", color = Color.Gray, fontSize = 13.sp)
    OutlinedButton(onClick = { vm.go(Page.Call) }, modifier = Modifier.fillMaxWidth()) { Text("Call supervisor or control room") }
}

@Composable
private fun HomeScreen(vm: AppViewModel, state: UiState) {
    var askPin by remember { mutableStateOf<DutyKind?>(null) }
    val home = state.home
    val shift = home?.attendance
    // A declaration still owed comes first: nothing else until it is done (brief section 6.2).
    state.owed?.let {
        AlertRow(vm)
        DeclarationScreen(vm, it, state.busy)
        OutlinedButton(onClick = { vm.go(Page.Call) }, modifier = Modifier.fillMaxWidth()) { Text("Call supervisor or control room") }
        return
    }
    Text("Hello, ${state.guardName ?: ""}", style = MaterialTheme.typography.headlineSmall)
    AlertRow(vm)
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            if (home == null && !state.online) {
                Text("No signal.", fontWeight = FontWeight.Bold)
                Text("Your shift will show when the phone is back online. Anything you do is saved and sent later.")
            } else if (home == null) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(Modifier.height(20.dp))
                    Spacer(Modifier.padding(4.dp))
                    Text("Loading your shift…")
                }
            } else if (shift == null) {
                // The real shift from the roster, never a fixed example (brief section 40).
                Text(home.roster.todayText(), fontWeight = FontWeight.Bold)
                Text("You are not on duty. Press Duty On when you start your shift.")
                val next = home.roster?.comingUp.orEmpty().take(3)
                if (next.isNotEmpty()) {
                    Text("Coming up", fontWeight = FontWeight.Bold, modifier = Modifier.padding(top = 6.dp))
                    next.forEach { Text("${rosterDate(it.date)}: ${it.shiftText()}", fontSize = 14.sp) }
                }
            } else {
                Text("On duty since ${time(shift.dutyOnAt)}", fontWeight = FontWeight.Bold)
                Text("${shift.shiftName ?: "Shift"} at ${shift.siteName ?: "your site"}")
                Text(
                    when (shift.arrivalStatus) {
                        "ON_TIME" -> "Arrived on time"
                        "LATE" -> "Arrived ${shift.lateMinutes} min late"
                        else -> "No matching shift"
                    },
                    color = if (shift.arrivalStatus == "LATE") Color(0xFFB3261E) else Green,
                )
            }
        }
    }
    var askTurnPin by remember { mutableStateOf(false) }
    if (home != null) {
        if (shift == null) BigButton("DUTY ON", enabled = !state.busy) { askPin = DutyKind.ON }
        else {
            // Duty From waits for the relief (D-33). Without signal the phone cannot check, so it lets him try.
            val relief = shift.relief
            val blocked = relief != null && !relief.canLeave && state.online
            if (relief != null && relief.message.isNotBlank()) {
                Card(Modifier.fillMaxWidth()) {
                    Text(
                        relief.message,
                        Modifier.background(if (blocked) Color(0xFFFFF4D6) else Color(0xFFDFF3E7)).padding(12.dp).fillMaxWidth(),
                        fontWeight = FontWeight.Bold,
                    )
                }
            }
            BigButton(if (blocked) "DUTY FROM (wait for relief)" else "DUTY FROM", enabled = !state.busy && !blocked) { askPin = DutyKind.FROM }
            if (relief?.canGiveTurn == true) {
                OutlinedButton(onClick = { askTurnPin = true }, modifier = Modifier.fillMaxWidth()) { Text("Let my partner go first") }
            }
        }
    }
    // Only on a phone the administrator has put at a gate.
    if (state.gate?.gate != null) {
        Button(onClick = { vm.go(Page.Visitors) }, modifier = Modifier.fillMaxWidth().height(56.dp), colors = ButtonDefaults.buttonColors(containerColor = Green)) { Text("Visitors", fontSize = 18.sp) }
    }
    OutlinedButton(onClick = { vm.go(Page.Patrols) }, modifier = Modifier.fillMaxWidth().height(56.dp)) { Text("Patrols", fontSize = 18.sp) }
    OutlinedButton(onClick = { vm.go(Page.Tasks) }, modifier = Modifier.fillMaxWidth().height(56.dp)) { Text("Tasks", fontSize = 18.sp) }
    OutlinedButton(onClick = { vm.go(Page.Reports) }, modifier = Modifier.fillMaxWidth().height(56.dp)) { Text("Report", fontSize = 18.sp) }
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedButton(onClick = { vm.go(Page.Uniform) }, modifier = Modifier.weight(1f).height(56.dp)) { Text("Uniform", fontSize = 18.sp) }
        OutlinedButton(onClick = { vm.go(Page.Reorders) }, modifier = Modifier.weight(1f).height(56.dp)) { Text("Re-order", fontSize = 18.sp) }
    }
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedButton(onClick = { vm.go(Page.Score) }, modifier = Modifier.weight(1f).height(56.dp)) { Text("Score", fontSize = 18.sp) }
        OutlinedButton(onClick = { vm.go(Page.Training) }, modifier = Modifier.weight(1f).height(56.dp)) { Text("Training", fontSize = 18.sp) }
    }
    OutlinedButton(onClick = { vm.go(Page.Roster) }, modifier = Modifier.fillMaxWidth().height(56.dp)) { Text("My roster", fontSize = 18.sp) }
    Button(onClick = { vm.go(Page.Call) }, modifier = Modifier.fillMaxWidth().height(56.dp), colors = ButtonDefaults.buttonColors(containerColor = Green)) { Text("Call", fontSize = 18.sp) }
    OutlinedButton(onClick = { vm.refresh() }, modifier = Modifier.fillMaxWidth()) { Text("Refresh") }
    // On duty: Lock, never Log out (D-33). The only way off duty is Duty From.
    if (shift != null) {
        OutlinedButton(onClick = { vm.lock() }, modifier = Modifier.fillMaxWidth().height(56.dp)) { Text("Lock (stay on duty)", fontSize = 18.sp) }
    } else {
        OutlinedButton(onClick = { vm.signOut() }, modifier = Modifier.fillMaxWidth()) { Text("Log out") }
    }
    if (askTurnPin) {
        PinDialog("Let my partner go first", onCancel = { askTurnPin = false }) { pin ->
            askTurnPin = false
            vm.giveTurn(pin)
        }
    }

    askPin?.let { kind ->
        PinDialog(kind.label, onCancel = { askPin = null }) { pin ->
            askPin = null
            vm.duty(kind, pin)
        }
    }
}

@Composable
fun PinDialog(title: String, onCancel: () -> Unit, onPin: (String) -> Unit) {
    var pin by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onCancel,
        title = { Text(title) },
        text = {
            OutlinedTextField(
                pin, { pin = it.filter(Char::isDigit).take(6) },
                label = { Text("Your PIN") }, singleLine = true,
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
            )
        },
        confirmButton = { Button(onClick = { onPin(pin) }, enabled = pin.length >= 4) { Text("Confirm") } },
        dismissButton = { TextButton(onClick = onCancel) { Text("Cancel") } },
    )
}
