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
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import za.onpar.app.AppViewModel
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
    Column(Modifier.fillMaxSize()) {
        StatusBar(state)
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            state.error?.let { Banner(it, Color(0xFFFBE3E0)) { vm.dismiss() } }
            state.message?.let { Banner(it, Color(0xFFDFF3E7)) { vm.dismiss() } }
            when (state.screen) {
                Screen.Setup -> SetupScreen(vm, state.busy)
                Screen.Login -> LoginScreen(vm, state.busy)
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
                    Page.NewReorder -> if (state.owed != null) HomeScreen(vm, state) else NewReorderScreen(vm, state)
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
        Text("On Par", color = Color.White, fontWeight = FontWeight.Bold, fontSize = 18.sp)
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

@Composable
private fun LoginScreen(vm: AppViewModel, busy: Boolean) {
    var number by remember { mutableStateOf("") }
    var pin by remember { mutableStateOf("") }
    Text("Log in", style = MaterialTheme.typography.headlineSmall)
    OutlinedTextField(
        number, { number = it.filter(Char::isDigit).take(8) },
        label = { Text("Employee number") }, singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
        modifier = Modifier.fillMaxWidth(),
    )
    OutlinedTextField(
        pin, { pin = it.filter(Char::isDigit).take(6) },
        label = { Text("PIN") }, singleLine = true,
        visualTransformation = PasswordVisualTransformation(),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
        modifier = Modifier.fillMaxWidth(),
    )
    BigButton(if (busy) "Checking…" else "Log in", enabled = !busy && number.isNotEmpty() && pin.length >= 4) {
        vm.signIn(number, pin)
        pin = ""
    }
    Text("Five wrong PINs lock your login until your supervisor resets it.", color = Color.Gray, fontSize = 13.sp)
}

@Composable
private fun HomeScreen(vm: AppViewModel, state: UiState) {
    var askPin by remember { mutableStateOf<DutyKind?>(null) }
    val home = state.home
    val shift = home?.attendance
    // A declaration still owed comes first: nothing else until it is done (brief section 6.2).
    state.owed?.let {
        DeclarationScreen(vm, it, state.busy)
        return
    }
    Text("Hello, ${state.guardName ?: ""}", style = MaterialTheme.typography.headlineSmall)
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
                Text("You are not on duty.", fontWeight = FontWeight.Bold)
                Text("Press Duty On when you start your shift.")
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
    if (home != null) {
        if (shift == null) BigButton("DUTY ON", enabled = !state.busy) { askPin = DutyKind.ON }
        else BigButton("DUTY FROM", enabled = !state.busy) { askPin = DutyKind.FROM }
    }
    OutlinedButton(onClick = { vm.go(Page.Patrols) }, modifier = Modifier.fillMaxWidth().height(56.dp)) { Text("Patrols", fontSize = 18.sp) }
    OutlinedButton(onClick = { vm.go(Page.Tasks) }, modifier = Modifier.fillMaxWidth().height(56.dp)) { Text("Tasks", fontSize = 18.sp) }
    OutlinedButton(onClick = { vm.go(Page.Reports) }, modifier = Modifier.fillMaxWidth().height(56.dp)) { Text("Report", fontSize = 18.sp) }
    OutlinedButton(onClick = { vm.go(Page.Reorders) }, modifier = Modifier.fillMaxWidth().height(56.dp)) { Text("Re-order", fontSize = 18.sp) }
    OutlinedButton(onClick = { vm.refresh() }, modifier = Modifier.fillMaxWidth()) { Text("Refresh") }
    OutlinedButton(onClick = { vm.signOut() }, modifier = Modifier.fillMaxWidth()) { Text("Log out") }

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
