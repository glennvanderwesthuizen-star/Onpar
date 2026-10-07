package za.onpar.app.ui

import android.Manifest
import android.content.pm.PackageManager
import android.util.Size
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import za.onpar.app.AppViewModel
import za.onpar.app.Page
import za.onpar.app.UiState
import za.onpar.core.BarcodeReader
import za.onpar.core.GateSetup
import za.onpar.core.Scanned
import za.onpar.core.VisitDraft
import za.onpar.core.VisitPerson
import za.onpar.core.VisitRow
import za.onpar.core.VisitVehicle
import za.onpar.core.VisitorRules
import za.onpar.core.VisitorScan
import java.io.File
import java.util.UUID
import java.util.concurrent.Executors

private val Red = Color(0xFFB3261E)
private val Amber = Color(0xFFB86E00)
private val statusColour = mapOf("awaiting_approval" to Amber, "on_site" to Color(0xFF1B7A4E), "exited" to Color.Gray)

@Composable
private fun VisitorHeader(title: String, back: () -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(title, style = MaterialTheme.typography.headlineSmall, modifier = Modifier.weight(1f))
        OutlinedButton(onClick = back) { Text("Back") }
    }
}

/**
 * Reads the barcode on a licence disc or an ID document with the back camera. The picture is
 * taken at a higher resolution than for QR codes, because these barcodes are small and dense.
 * Works on any Android phone without Google services (brief: no brand-specific logic).
 */
@Composable
fun DocumentScanner(onCode: (String) -> Unit) {
    val context = LocalContext.current
    var allowed by remember {
        mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED)
    }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { allowed = it }
    LaunchedEffect(Unit) { if (!allowed) ask.launch(Manifest.permission.CAMERA) }
    if (!allowed) {
        Button(onClick = { ask.launch(Manifest.permission.CAMERA) }) { Text("Allow the camera") }
        return
    }

    val owner = LocalLifecycleOwner.current
    val latest by rememberUpdatedState(onCode)
    val executor = remember { Executors.newSingleThreadExecutor() }
    DisposableEffect(Unit) { onDispose { executor.shutdown() } }

    AndroidView(factory = { ctx ->
        val view = PreviewView(ctx)
        val future = ProcessCameraProvider.getInstance(ctx)
        future.addListener({
            val provider = future.get()
            val preview = Preview.Builder().build().also { it.setSurfaceProvider(view.surfaceProvider) }
            val reader = BarcodeReader()
            var lastText = ""
            var lastAt = 0L
            val analysis = ImageAnalysis.Builder()
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .setResolutionSelector(
                    ResolutionSelector.Builder()
                        .setResolutionStrategy(ResolutionStrategy(Size(1920, 1080), ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER))
                        .build(),
                )
                .build()
            analysis.setAnalyzer(executor) { image ->
                val text = image.use {
                    val plane = it.planes[0]
                    val buffer = plane.buffer
                    val bytes = ByteArray(buffer.remaining()).also { b -> buffer.get(b) }
                    runCatching { reader.read(bytes, plane.rowStride, it.width, it.height) }.getOrNull()
                }
                val now = System.currentTimeMillis()
                // The same barcode stays in view for many pictures: it is reported once every two seconds.
                if (text != null && (text != lastText || now - lastAt > 2000)) {
                    lastText = text
                    lastAt = now
                    ContextCompat.getMainExecutor(ctx).execute { latest(text) }
                }
            }
            provider.unbindAll()
            provider.bindToLifecycle(owner, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
        }, ContextCompat.getMainExecutor(ctx))
        view
    }, modifier = Modifier.fillMaxWidth().height(320.dp))
}

/** The gate's own screen: start a new visitor, and see today's. */
@Composable
fun VisitorsScreen(vm: AppViewModel, state: UiState) {
    VisitorHeader("Visitors") { vm.go(Page.Home) }
    val setup = state.gate
    val gate = setup?.gate
    if (setup == null || gate == null) {
        Text(setup?.message ?: if (state.busy) "Loading…" else "This phone is not set up as a gate phone.", color = Color.DarkGray)
        return
    }
    Text(listOfNotNull(gate.name, setup.siteName).joinToString(" · "), color = Color.DarkGray)
    BigButton("NEW VISITOR", enabled = !state.busy) { vm.go(Page.NewVisitor) }
    Text("Today", style = MaterialTheme.typography.titleMedium)
    if (state.visits.isEmpty()) Text(if (state.busy) "Loading…" else "No visitors yet today.", color = Color.Gray)
    state.visits.forEach { VisitCard(it) }
    OutlinedButton(onClick = { vm.loadVisitors() }, modifier = Modifier.fillMaxWidth()) { Text("Refresh") }
}

@Composable
private fun VisitCard(v: VisitRow) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(time(v.at), fontWeight = FontWeight.Bold)
                Text(v.statusLabel, color = statusColour[v.status] ?: Red, fontWeight = FontWeight.Bold)
            }
            Text(listOf(v.surname, v.names).filter { it.isNotBlank() }.joinToString(", "), fontWeight = FontWeight.Bold)
            val vehicle = if (v.type == "pedestrian") "On foot" else listOfNotNull(v.registration, v.colour, v.make, v.model).filter { it.isNotBlank() }.joinToString(" ")
            Text(vehicle + (v.pax?.let { " · $it passenger" + if (it == 1) "" else "s" } ?: ""))
            Text("To see " + (v.unitName?.let { "unit $it" } ?: "the office") + " · ${v.category}", color = Color.DarkGray, fontSize = 13.sp)
        }
    }
}

private enum class Step { Vehicle, Face, Identity, Details }

/**
 * A new visitor, one step at a time so only one camera is open at once: the vehicle's licence
 * disc, the driver's licence or ID, then who they are here to see. A visitor on foot has a face
 * photo in place of the vehicle. Any barcode that will not scan can be typed in, with a photo.
 */
@Composable
fun NewVisitorScreen(vm: AppViewModel, state: UiState) {
    val context = LocalContext.current
    VisitorHeader("New visitor") { vm.go(Page.Visitors) }
    val setup: GateSetup? = state.gate
    if (setup == null || setup.gate == null) {
        Text(setup?.message ?: if (state.busy) "Loading…" else "This phone is not set up as a gate phone.", color = Color.DarkGray)
        return
    }

    val eventId = remember { UUID.randomUUID().toString() }
    val faceFile = remember { File(context.cacheDir, "visitor-face.jpg").also { it.delete() } }
    val identityFile = remember { File(context.cacheDir, "visitor-identity.jpg").also { it.delete() } }
    val discFile = remember { File(context.cacheDir, "visitor-disc.jpg").also { it.delete() } }

    var type by remember { mutableStateOf("vehicle") }
    var step by remember { mutableStateOf(Step.Vehicle) }
    var note by remember { mutableStateOf<String?>(null) }

    // The vehicle.
    var registration by remember { mutableStateOf("") }
    var make by remember { mutableStateOf("") }
    var model by remember { mutableStateOf("") }
    var colour by remember { mutableStateOf("") }
    var vin by remember { mutableStateOf("") }
    var discExpiry by remember { mutableStateOf("") }
    var discMethod by remember { mutableStateOf("scan") }
    var typeDisc by remember { mutableStateOf(false) }
    var discPhoto by remember { mutableStateOf<File?>(null) }

    // The person.
    var docChoice by remember { mutableStateOf("licence") }
    var typeIdentity by remember { mutableStateOf(false) }
    var scannedIdentity by remember { mutableStateOf(false) }
    var document by remember { mutableStateOf("drivers_licence") }
    var idNumber by remember { mutableStateOf("") }
    var surname by remember { mutableStateOf("") }
    var names by remember { mutableStateOf("") }
    var licenceExpiry by remember { mutableStateOf("") }
    var identityPhoto by remember { mutableStateOf<File?>(null) }
    var face by remember { mutableStateOf<File?>(null) }

    // The visit.
    var pax by remember { mutableStateOf("") }
    var categoryId by remember { mutableStateOf("") }
    var unitId by remember { mutableStateOf<String?>(null) }
    var office by remember { mutableStateOf(false) }
    var unitSearch by remember { mutableStateOf("") }
    var seenWarnings by remember { mutableStateOf(false) }

    val strictExpiry = !setup.on("expiredLicenceOk")
    val discDay = VisitorRules.day(discExpiry)
    val licenceDay = VisitorRules.day(licenceExpiry)

    fun startAgain(newType: String) {
        type = newType
        step = if (newType == "vehicle") Step.Vehicle else if (setup.on("facePhoto")) Step.Face else Step.Identity
        docChoice = if (newType == "vehicle") "licence" else "id"
        typeIdentity = false
        scannedIdentity = false
        note = null
    }

    if (step == Step.Vehicle || step == Step.Face) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FilterChip(selected = type == "vehicle", onClick = { if (type != "vehicle") startAgain("vehicle") }, label = { Text("Vehicle") })
            FilterChip(selected = type == "pedestrian", onClick = { if (type != "pedestrian") startAgain("pedestrian") }, label = { Text("On foot") })
        }
    }
    note?.let { Text(it, color = Red, fontWeight = FontWeight.Bold) }

    when (step) {
        Step.Vehicle -> {
            Text("1. The vehicle", style = MaterialTheme.typography.titleMedium)
            if (!typeDisc) {
                Text("Hold the phone over the licence disc on the windscreen until it reads.")
                DocumentScanner { code ->
                    val s = VisitorScan.read(code)
                    if (s is Scanned.Disc) {
                        registration = s.registration
                        make = s.make
                        model = s.model
                        colour = s.colour
                        vin = s.vin
                        discExpiry = s.expiry.orEmpty()
                        discMethod = "scan"
                        note = null
                        step = Step.Identity
                    } else {
                        note = "That is not a licence disc. Scan the round disc on the windscreen."
                    }
                }
                OutlinedButton(onClick = { typeDisc = true; note = null }, modifier = Modifier.fillMaxWidth()) { Text("The disc will not scan: type it in") }
            } else {
                Text("Take a photo of the licence disc, then type what it says.")
                PhotoTaker(discFile, front = false) { discPhoto = it }
                OutlinedTextField(registration, { registration = it.take(12).uppercase() }, label = { Text("Number plate") }, singleLine = true,
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters), modifier = Modifier.fillMaxWidth())
                OutlinedTextField(make, { make = it.take(40) }, label = { Text("Make, for example Toyota") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(model, { model = it.take(40) }, label = { Text("Model, for example Corolla") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(colour, { colour = it.take(30) }, label = { Text("Colour") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                if (strictExpiry) {
                    OutlinedTextField(discExpiry, { discExpiry = it.take(10) }, label = { Text("Disc expiry date, day/month/year") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                }
                val ready = VisitorScan.plate(registration).length >= 2 && discPhoto != null && (!strictExpiry || discExpiry.isBlank() || discDay != null)
                BigButton("Next", enabled = ready) {
                    discMethod = "manual"
                    step = Step.Identity
                }
                OutlinedButton(onClick = { typeDisc = false }, modifier = Modifier.fillMaxWidth()) { Text("Try scanning again") }
            }
        }

        Step.Face -> {
            Text("1. The visitor's face", style = MaterialTheme.typography.titleMedium)
            Text("Take a photo of the visitor's face.")
            PhotoTaker(faceFile, front = false) { face = it }
            BigButton("Next", enabled = face != null) { step = Step.Identity }
        }

        Step.Identity -> {
            Text(if (type == "vehicle") "2. The driver" else "2. The visitor's ID", style = MaterialTheme.typography.titleMedium)
            if (type == "vehicle") Text(listOf(registration, colour, make, model).filter { it.isNotBlank() }.joinToString(" "), color = Color.DarkGray)
            if (!scannedIdentity) {
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    FilterChip(selected = docChoice == "licence", onClick = { docChoice = "licence"; typeIdentity = false; note = null }, label = { Text("Driver's licence") })
                    FilterChip(selected = docChoice == "id", onClick = { docChoice = "id"; typeIdentity = false; note = null }, label = { Text("ID card or book") })
                    FilterChip(selected = docChoice == "other", onClick = { docChoice = "other"; typeIdentity = false; note = null }, label = { Text("Passport") })
                }
            }
            if (docChoice == "id" && !typeIdentity && !scannedIdentity) {
                Text("Hold the phone over the barcode on the back of the ID card, or inside the ID book.")
                DocumentScanner { code ->
                    when (val s = VisitorScan.read(code)) {
                        is Scanned.Identity -> {
                            idNumber = s.idNumber
                            surname = s.surname
                            names = s.names
                            document = s.document
                            scannedIdentity = true
                            note = null
                            if (s.surname.isNotBlank()) step = Step.Details
                        }
                        is Scanned.DriversLicence -> note = "That is a driver's licence. Choose Driver's licence above, photograph it and type the details."
                        else -> note = "That barcode is not an ID. Try again, or type the details in."
                    }
                }
                OutlinedButton(onClick = { typeIdentity = true; note = null }, modifier = Modifier.fillMaxWidth()) { Text("It will not scan: type it in") }
            } else if (scannedIdentity) {
                // An ID book's barcode holds only the number: the guard types the name from the book.
                Text("ID number $idNumber", fontWeight = FontWeight.Bold)
                OutlinedTextField(surname, { surname = it.take(80) }, label = { Text("Surname") }, singleLine = true,
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Words), modifier = Modifier.fillMaxWidth())
                OutlinedTextField(names, { names = it.take(120) }, label = { Text("First names") }, singleLine = true,
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Words), modifier = Modifier.fillMaxWidth())
                BigButton("Next", enabled = surname.isNotBlank()) { step = Step.Details }
                OutlinedButton(onClick = { scannedIdentity = false; idNumber = ""; surname = ""; names = "" }, modifier = Modifier.fillMaxWidth()) { Text("Scan a different ID") }
            } else {
                val what = when (docChoice) {
                    "licence" -> "driver's licence"
                    "id" -> "ID"
                    else -> "passport"
                }
                Text("Take a photo of the $what, then type the details from it.")
                PhotoTaker(identityFile, front = false) { identityPhoto = it }
                OutlinedTextField(surname, { surname = it.take(80) }, label = { Text("Surname") }, singleLine = true,
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Words), modifier = Modifier.fillMaxWidth())
                OutlinedTextField(names, { names = it.take(120) }, label = { Text(if (docChoice == "licence") "Initials" else "First names") }, singleLine = true,
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Words), modifier = Modifier.fillMaxWidth())
                OutlinedTextField(idNumber, { idNumber = it.take(20).uppercase() }, label = { Text(if (docChoice == "other") "Passport number" else "ID number") }, singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = if (docChoice == "other") KeyboardType.Text else KeyboardType.Number), modifier = Modifier.fillMaxWidth())
                if (docChoice == "licence" && strictExpiry) {
                    OutlinedTextField(licenceExpiry, { licenceExpiry = it.take(10) }, label = { Text("Licence expiry date, day/month/year") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                }
                val ready = surname.isNotBlank() && VisitorScan.idNumber(idNumber).length >= 5 && identityPhoto != null &&
                    (docChoice != "licence" || !strictExpiry || licenceDay != null)
                BigButton("Next", enabled = ready) {
                    document = when (docChoice) {
                        "licence" -> "drivers_licence"
                        "id" -> "id_card"
                        else -> "passport"
                    }
                    step = Step.Details
                }
            }
            if (type == "vehicle") OutlinedButton(onClick = { step = Step.Vehicle; note = null }, modifier = Modifier.fillMaxWidth()) { Text("Back to the vehicle") }
        }

        Step.Details -> {
            val plate = if (type == "vehicle") VisitorScan.plate(registration) else null
            // What this site already knows about the visitor, and whether they are barred.
            LaunchedEffect(idNumber, plate, unitId) { vm.checkVisitor(VisitorScan.idNumber(idNumber), plate, unitId) }

            Text("3. The visit", style = MaterialTheme.typography.titleMedium)
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(listOf(surname, names).filter { it.isNotBlank() }.joinToString(", "), fontWeight = FontWeight.Bold)
                    Text("ID number $idNumber")
                    if (type == "vehicle") Text(listOf(registration, colour, make, model).filter { it.isNotBlank() }.joinToString(" "))
                    val known = state.scanCheck
                    known?.person?.lastSeen?.let { Text("This person has been here before.", color = Color.DarkGray, fontSize = 13.sp) }
                    known?.vehicle?.lastSeen?.let { Text("This vehicle has been here before.", color = Color.DarkGray, fontSize = 13.sp) }
                }
            }
            val barred = state.scanCheck?.barred.orEmpty()
            if (barred.isNotEmpty()) {
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.background(Color(0xFFFBE3E0)).padding(12.dp)) {
                        Text("ON THE BARRED LIST", color = Red, fontWeight = FontWeight.Bold, fontSize = 18.sp)
                        Text("Do not let this visitor in. " + barred.joinToString(", ") { it.kindLabel } + " is barred. Finish below so the attempt is recorded.")
                    }
                }
            }

            if (type == "vehicle" && setup.on("paxCount")) {
                OutlinedTextField(pax, { v -> pax = v.filter { it.isDigit() }.take(2) }, label = { Text("Passengers, not counting the driver") }, singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), modifier = Modifier.fillMaxWidth())
            }

            Text("What kind of visitor?", fontWeight = FontWeight.Bold)
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                setup.categories.forEach { c -> FilterChip(selected = categoryId == c.id, onClick = { categoryId = c.id }, label = { Text(c.name) }) }
            }

            Text("Who are they here to see?", fontWeight = FontWeight.Bold)
            val chosen = setup.units.firstOrNull { it.id == unitId }
            if (chosen != null || office) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(if (chosen != null) "Unit ${chosen.name}" else "The office", fontWeight = FontWeight.Bold, fontSize = 18.sp)
                    OutlinedButton(onClick = { unitId = null; office = false }) { Text("Change") }
                }
            } else {
                OutlinedTextField(unitSearch, { unitSearch = it.take(20) }, label = { Text("Unit number or name") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                val matches = setup.units.filter { unitSearch.isBlank() || it.name.contains(unitSearch.trim(), ignoreCase = true) }.take(8)
                if (matches.isEmpty()) Text("No unit matches that.", color = Color.Gray)
                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    matches.chunked(4).forEach { row ->
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            row.forEach { u -> FilterChip(selected = false, onClick = { unitId = u.id; office = false }, label = { Text(u.name) }) }
                        }
                    }
                    if (setup.hasClient) FilterChip(selected = false, onClick = { unitId = null; office = true }, label = { Text("The office") })
                }
            }

            val warnings = VisitorRules.warnings(setup, licenceDay, discDay)
            if (warnings.isNotEmpty()) {
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.background(Color(0xFFFDF0DC)).padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        warnings.forEach { w -> Text(VisitorRules.WARNING_TEXT[w] ?: w, color = Amber, fontWeight = FontWeight.Bold) }
                        Text("You decide whether the visitor may continue.")
                        FilterChip(selected = seenWarnings, onClick = { seenWarnings = !seenWarnings }, label = { Text("I have seen this. Continue.") })
                    }
                }
            }

            val draft = VisitDraft(
                eventId = eventId,
                type = type,
                person = VisitPerson(idNumber, surname, names, document, if (scannedIdentity) "scan" else "manual"),
                vehicle = if (type == "vehicle") VisitVehicle(registration, make, model, colour, vin, discDay, discMethod) else null,
                licenceExpiry = if (document == "drivers_licence") licenceDay else null,
                pax = pax.toIntOrNull(),
                categoryId = categoryId,
                unitId = unitId,
                office = office,
                acknowledged = if (seenWarnings) warnings else emptyList(),
                face = if (type == "pedestrian") face else null,
                identityPhoto = if (scannedIdentity) null else identityPhoto,
                discPhoto = if (type == "vehicle" && discMethod == "manual") discPhoto else null,
            )
            val problem = VisitorRules.problem(setup, draft)
            if (problem != null) Text(problem, color = Color.DarkGray)
            BigButton(
                when {
                    state.busy -> "Sending…"
                    barred.isNotEmpty() -> "Record and turn away"
                    else -> "Request approval"
                },
                enabled = !state.busy && problem == null,
            ) { vm.saveVisit(draft) }
            OutlinedButton(onClick = { step = Step.Identity }, modifier = Modifier.fillMaxWidth()) { Text("Back to the ID") }
        }
    }
}

/** What happened to the visitor just sent. */
@Composable
fun VisitSavedScreen(vm: AppViewModel, state: UiState) {
    VisitorHeader("Visitor") { vm.go(Page.Visitors) }
    val done = state.visitDone
    if (done == null) {
        Text("Nothing to show.", color = Color.Gray)
    } else if (done.blocked != null) {
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.background(Color(0xFFFBE3E0)).padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("DO NOT LET THEM IN", color = Red, fontWeight = FontWeight.Bold, fontSize = 22.sp)
                Text(done.blocked.orEmpty())
            }
        }
    } else {
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.background(Color(0xFFDFF3E7)).padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("Saved: ${done.statusLabel}", fontWeight = FontWeight.Bold, fontSize = 22.sp)
                Text("The visitor is recorded. Asking the customer to approve from their phone comes with the next update of On Par; until then, follow your site's usual rule before letting the visitor in.")
            }
        }
    }
    BigButton("NEXT VISITOR") { vm.go(Page.NewVisitor) }
    OutlinedButton(onClick = { vm.go(Page.Visitors) }, modifier = Modifier.fillMaxWidth()) { Text("Back to visitors") }
}
