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
import androidx.compose.foundation.clickable
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
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
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
import za.onpar.core.ExitDraft
import za.onpar.core.ExpectedHint
import za.onpar.core.ExpectedRow
import za.onpar.core.GateSetup
import za.onpar.core.OnSiteVisitor
import za.onpar.core.ReasonOption
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
import kotlinx.coroutines.delay

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
    // Once the scanner has left the screen it must not report another barcode, and the camera is let go.
    val open = remember { java.util.concurrent.atomic.AtomicBoolean(true) }
    DisposableEffect(Unit) {
        onDispose {
            open.set(false)
            executor.shutdown()
            runCatching { ProcessCameraProvider.getInstance(context).get().unbindAll() }
        }
    }

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
                    ContextCompat.getMainExecutor(ctx).execute { if (open.get()) latest(text) }
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
    // The handover from the last guard at this gate: the incoming guard reads it and says so.
    setup.handover?.let { h ->
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.background(Color(0xFFFDF0DC)).padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("HANDOVER FROM ${h.from.uppercase()}", color = Amber, fontWeight = FontWeight.Bold, fontSize = 18.sp)
                Text("Handed over at ${time(h.signedOffAt)}. ${h.onSite} on site, ${h.overstays} past their time" + (if (h.unresolved > 0) ", ${h.unresolved} unresolved." else "."))
                h.notes.forEach { n ->
                    Text(listOfNotNull(n.visitor, n.vehicle).joinToString(", ") + ", ${n.visiting}" + (n.overBy?.let { ", $it over" } ?: ""), fontWeight = FontWeight.Bold)
                    Text((n.action ?: "No action") + (if (n.note.isNotBlank()) ": ${n.note}" else ""))
                }
                Button(onClick = { vm.acknowledgeHandover(h.id) }, enabled = !state.busy, modifier = Modifier.fillMaxWidth().height(56.dp)) { Text("I HAVE READ THIS", fontSize = 18.sp, fontWeight = FontWeight.Bold) }
            }
        }
    }
    BigButton("NEW VISITOR", enabled = !state.busy) { vm.startVisitor(null) }
    Button(onClick = { vm.go(Page.ExpectedVisitor) }, enabled = !state.busy, modifier = Modifier.fillMaxWidth().height(64.dp),
        colors = androidx.compose.material3.ButtonDefaults.buttonColors(containerColor = Color(0xFF1B7A4E))) {
        Text("EXPECTED VISITOR" + if (state.expected.isEmpty()) "" else " (${state.expected.size} today)", fontSize = 20.sp, fontWeight = FontWeight.Bold)
    }
    Button(onClick = { vm.go(Page.VisitorExit) }, enabled = !state.busy, modifier = Modifier.fillMaxWidth().height(64.dp),
        colors = androidx.compose.material3.ButtonDefaults.buttonColors(containerColor = Color(0xFF37474F))) {
        Text("VISITOR LEAVING", fontSize = 20.sp, fontWeight = FontWeight.Bold)
    }
    val counts = setup.counts
    Button(onClick = { vm.go(Page.OnSite) }, enabled = !state.busy, modifier = Modifier.fillMaxWidth().height(56.dp),
        colors = androidx.compose.material3.ButtonDefaults.buttonColors(containerColor = if (counts.needAction > 0) Red else Color(0xFF455A64))) {
        Text("ON SITE NOW: ${counts.onSite}" + (if (counts.overstays > 0) " (${counts.overstays} past their time)" else ""), fontSize = 18.sp, fontWeight = FontWeight.Bold)
    }
    OutlinedButton(onClick = { vm.go(Page.Handover) }, enabled = !state.busy, modifier = Modifier.fillMaxWidth().height(56.dp)) { Text("HAND OVER SHIFT", fontSize = 18.sp) }
    Text("Today", style = MaterialTheme.typography.titleMedium)
    if (state.visits.isEmpty()) Text(if (state.busy) "Loading…" else "No visitors yet today.", color = Color.Gray)
    state.visits.forEach { v -> VisitCard(v) { vm.go(Page.Visit(v.id)) } }
    OutlinedButton(onClick = { vm.loadVisitors() }, modifier = Modifier.fillMaxWidth()) { Text("Refresh") }
}

@Composable
private fun VisitCard(v: VisitRow, onClick: () -> Unit) {
    Card(Modifier.fillMaxWidth().clickable(onClick = onClick)) {
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

@Composable
private fun ExpectedCard(e: ExpectedRow, onClick: () -> Unit) {
    Card(Modifier.fillMaxWidth().clickable(onClick = onClick)) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(e.visitorName, fontWeight = FontWeight.Bold)
            Text("To see " + (if (e.visiting == "The office") "the office" else e.visiting) + " · ${e.category}")
            Text(listOfNotNull(e.time, e.gateName, e.knownBy.takeIf { it.isNotBlank() }?.let { "known by $it" }).joinToString(" · "), color = Color.DarkGray, fontSize = 13.sp)
        }
    }
}

/**
 * "Are you expected?" The guard types what the visitor gives (a cell number, an ID number or a
 * number plate) or taps their name in today's list, and sees the announcement at once. The
 * visitor is then scanned in as usual: the scan is what confirms it.
 */
@Composable
fun ExpectedVisitorScreen(vm: AppViewModel, state: UiState) {
    VisitorHeader("Expected visitor") { vm.go(Page.Visitors) }
    var typed by remember { mutableStateOf("") }
    val hint = state.expectedHint
    if (hint != null) {
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.background(Color(0xFFDFF3E7)).padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("EXPECTED", color = Green, fontWeight = FontWeight.Bold, fontSize = 22.sp)
                Text(hint.visitorName, fontWeight = FontWeight.Bold, fontSize = 18.sp)
                Text("To see " + (if (hint.visiting == "The office") "the office" else hint.visiting))
                if (hint.knownBy.isNotBlank()) Text("Found by ${hint.knownBy}", color = Color.DarkGray, fontSize = 13.sp)
                Text("Now scan them in. They are let in without asking the customer if the scan matches.", color = Color.DarkGray)
            }
        }
        BigButton("SCAN THEM IN") { vm.startVisitor(hint) }
        OutlinedButton(onClick = { vm.go(Page.ExpectedVisitor) }, modifier = Modifier.fillMaxWidth()) { Text("Look up someone else") }
        return
    }
    Text("Ask the visitor for their cell number, ID number or number plate.")
    OutlinedTextField(typed, { typed = it.take(24) }, label = { Text("Cell number, ID number or number plate") }, singleLine = true, modifier = Modifier.fillMaxWidth())
    BigButton(if (state.busy) "Looking…" else "FIND", enabled = !state.busy && typed.isNotBlank()) { vm.findExpected(typed) }
    if (state.expectedNotFound) {
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.background(Color(0xFFFDF0DC)).padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("Nobody expected today matches that.", color = Amber, fontWeight = FontWeight.Bold)
                Text("Check the number with the visitor, find their name below, or scan them in as a new visitor and the customer will be asked.")
            }
        }
        OutlinedButton(onClick = { vm.startVisitor(null) }, modifier = Modifier.fillMaxWidth()) { Text("Scan in as a new visitor") }
    }
    Text("Expected today", style = MaterialTheme.typography.titleMedium)
    if (state.expected.isEmpty()) Text(if (state.busy) "Loading…" else "Nobody has been announced for today.", color = Color.Gray)
    state.expected.forEach { e -> ExpectedCard(e) { vm.startVisitor(ExpectedHint(e.id, e.visitorName, e.visiting, e.knownBy)) } }
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
    // Kept in the app's own storage, not its cache: Android may empty the cache at any moment, and a photo must last until the visit is sent.
    val photoDir = remember { File(context.filesDir, "visitor-photos").also { it.mkdirs() } }
    val faceFile = remember { File(photoDir, "face.jpg").also { it.delete() } }
    val identityFile = remember { File(photoDir, "identity.jpg").also { it.delete() } }
    val discFile = remember { File(photoDir, "disc.jpg").also { it.delete() } }

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
    /** An ID number read from a barcode that holds nothing else, while the scanner looks a little longer for one with the name. */
    var numberOnly by remember { mutableStateOf<String?>(null) }
    var document by remember { mutableStateOf("drivers_licence") }
    var idNumber by remember { mutableStateOf("") }
    var surname by remember { mutableStateOf("") }
    var names by remember { mutableStateOf("") }
    var licenceExpiry by remember { mutableStateOf("") }
    var identityPhoto by remember { mutableStateOf<File?>(null) }
    var face by remember { mutableStateOf<File?>(null) }

    // The visit.
    var pax by remember { mutableStateOf("") }
    // "Visitor" is already chosen; the guard taps Contractor for someone coming to do work on site.
    var categoryId by remember { mutableStateOf(setup.categories.firstOrNull()?.id.orEmpty()) }
    var unitId by remember { mutableStateOf<String?>(null) }
    var office by remember { mutableStateOf(false) }
    var unitSearch by remember { mutableStateOf("") }
    var seenWarnings by remember { mutableStateOf(false) }
    // Still recorded as on site from an earlier visit: the guard's reason for letting them in again.
    var onSiteReason by remember { mutableStateOf<String?>(null) }
    var onSiteNote by remember { mutableStateOf("") }
    // Pulled up before scanning ("Are you expected?"): shown all the way through, and confirmed by the scan.
    val hint = state.expectedHint
    var expectedCell by remember { mutableStateOf(hint?.cell.orEmpty()) }

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
    if (hint != null) {
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.background(Color(0xFFDFF3E7)).padding(12.dp)) {
                Text("Expected: ${hint.visitorName}, to see " + (if (hint.visiting == "The office") "the office" else hint.visiting), color = Green, fontWeight = FontWeight.Bold)
            }
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
                Text("Hold the phone over the large barcode on the back of the ID card, or the barcode inside the ID book.")
                val numberRead = numberOnly
                if (numberRead != null) {
                    val useNumber = {
                        idNumber = numberRead
                        surname = ""
                        names = ""
                        document = "id_book"
                        scannedIdentity = true
                        numberOnly = null
                    }
                    Text("The ID number was read. On an ID card, keep the phone over the large barcode to read the name too…", color = Amber, fontWeight = FontWeight.Bold)
                    LaunchedEffect(numberRead) {
                        delay(4000)
                        if (numberOnly == numberRead) useNumber()
                    }
                }
                DocumentScanner { code ->
                    when (val s = VisitorScan.read(code)) {
                        is Scanned.Identity -> {
                            note = null
                            if (s.surname.isBlank()) {
                                // A barcode with only the number: an ID book, or the thin barcode on an ID card.
                                // Wait a moment for the card's large barcode, which also holds the name.
                                if (numberOnly == null) numberOnly = s.idNumber
                            } else {
                                numberOnly = null
                                idNumber = s.idNumber
                                surname = s.surname
                                names = s.names
                                document = s.document
                                scannedIdentity = true
                                step = Step.Details
                            }
                        }
                        is Scanned.DriversLicence -> note = "That is a driver's licence. Choose Driver's licence above, photograph it and type the details."
                        else -> note = "That barcode is not an ID. Try again, or type the details in."
                    }
                }
                OutlinedButton(onClick = { typeIdentity = true; note = null }, modifier = Modifier.fillMaxWidth()) { Text("It will not scan: type it in") }
            } else if (scannedIdentity) {
                // An ID book's barcode holds only the number: the guard types the name from the book.
                Text("ID number $idNumber", fontWeight = FontWeight.Bold)
                Text("Only the number could be read. Type the surname and first names from the ID, then tap Next.")
                OutlinedTextField(surname, { surname = it.take(80) }, label = { Text("Surname") }, singleLine = true,
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Words), modifier = Modifier.fillMaxWidth())
                OutlinedTextField(names, { names = it.take(120) }, label = { Text("First names") }, singleLine = true,
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Words), modifier = Modifier.fillMaxWidth())
                BigButton("Next", enabled = surname.isNotBlank()) { step = Step.Details }
                OutlinedButton(onClick = { scannedIdentity = false; numberOnly = null; idNumber = ""; surname = ""; names = "" }, modifier = Modifier.fillMaxWidth()) { Text("Scan a different ID") }
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
            if (type == "pedestrian" && setup.on("facePhoto")) OutlinedButton(onClick = { step = Step.Face; note = null }, modifier = Modifier.fillMaxWidth()) { Text("Back to the face photo") }
        }

        Step.Details -> {
            val plate = if (type == "vehicle") VisitorScan.plate(registration) else null
            // What this site already knows about the visitor, and whether they are barred.
            // A visitor who says they are expected may be on the list by cell number only: the guard types it in.
            val cellKey = expectedCell.filter { it.isDigit() }.takeIf { it.length >= 9 }
            LaunchedEffect(idNumber, plate, unitId, cellKey) { vm.checkVisitor(VisitorScan.idNumber(idNumber), plate, unitId, cellKey) }
            val pass = state.scanCheck?.expected

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

            // Owner, 7 Oct 2026: a visitor still recorded as on site is not stopped. The guard is warned and decides, with a reason.
            val stillOnSite = state.scanCheck?.onSite.orEmpty()
            if (stillOnSite.isNotEmpty() && barred.isEmpty()) {
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.background(Color(0xFFFDF0DC)).padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text("ALREADY ON SITE", color = Amber, fontWeight = FontWeight.Bold, fontSize = 18.sp)
                        stillOnSite.forEach { o ->
                            Text((if (o.what == "vehicle") "This vehicle" else "This person") + " came in at ${time(o.since)} at ${o.gateName} and was never scanned out: " +
                                listOfNotNull(o.visitor, o.vehicle).joinToString(", ") + ", to see " + (if (o.visiting == "The office") "the office" else o.visiting) + ".")
                        }
                        Text("You decide whether to carry on. Say why first. The earlier visit is closed and your supervisor is told.")
                        val options = state.scanCheck?.reasons.orEmpty().filter { it.id == "not_scanned_out" || it.id == "other" }
                        ReasonPicker(options, onSiteReason, onSiteNote, { onSiteReason = it }, { onSiteNote = it })
                    }
                }
            }

            if (type == "vehicle" && setup.on("paxCount")) {
                OutlinedTextField(pax, { v -> pax = v.filter { it.isDigit() }.take(2) }, label = { Text("Passengers, not counting the driver") }, singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), modifier = Modifier.fillMaxWidth())
            }

            if (pass != null && barred.isEmpty()) {
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.background(Color(0xFFDFF3E7)).padding(12.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text("EXPECTED by " + (if (pass.visiting == "The office") "the office" else pass.visiting), color = Green, fontWeight = FontWeight.Bold, fontSize = 18.sp)
                        Text("${pass.by} told the gate: ${pass.visitorName}, ${pass.category}" + if (pass.regular) " (a regular)." else ".")
                        pass.namedGate?.let { Text("Announced for $it. They may still come in here.", color = Color.DarkGray) }
                        if (pass.mismatch.isNotEmpty()) Text("The ${pass.mismatch.joinToString(" and ")} is not the one the customer gave. Let them in; the customer is told.", color = Amber, fontWeight = FontWeight.Bold)
                        Text("No approval is needed.", color = Color.DarkGray)
                    }
                }
            }

            // The announcement was pulled up first, but what was scanned does not match it.
            if (hint != null && state.scanCheck != null && pass?.passId != hint.passId && barred.isEmpty()) {
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.background(Color(0xFFFDF0DC)).padding(12.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text("This does not match the announcement for ${hint.visitorName}.", color = Amber, fontWeight = FontWeight.Bold)
                        Text("The customer gave something else to know them by" + (if (hint.knownBy.isNotBlank()) " (${hint.knownBy})" else "") + ". If they gave a cell number, type it below. Otherwise carry on: the customer will be asked.")
                    }
                }
            }

            if (pass == null) Text("What kind of visitor?", fontWeight = FontWeight.Bold)
            if (pass == null) Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                setup.categories.forEach { c -> FilterChip(selected = categoryId == c.id, onClick = { categoryId = c.id }, label = { Text(c.name) }) }
            }

            if (pass == null) Text("Who are they here to see?", fontWeight = FontWeight.Bold)
            val chosen = setup.units.firstOrNull { it.id == unitId }
            if (pass != null) {
                // The unit comes from the customer's announcement.
            } else if (chosen != null || office) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(if (chosen != null) "Unit ${chosen.name}" else "The office", fontWeight = FontWeight.Bold, fontSize = 18.sp)
                    OutlinedButton(onClick = { unitId = null; office = false }) { Text("Change") }
                }
            } else {
                OutlinedTextField(unitSearch, { typed ->
                    unitSearch = typed.take(20)
                    // Typing a unit's whole name chooses it, when no other unit also fits what was typed.
                    val fits = setup.units.filter { it.name.contains(typed.trim(), ignoreCase = true) }
                    val exact = fits.singleOrNull()?.takeIf { it.name.equals(typed.trim(), ignoreCase = true) }
                    if (exact != null) {
                        unitId = exact.id
                        office = false
                    }
                }, label = { Text("Unit number or name") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                val matches = setup.units.filter { unitSearch.isBlank() || it.name.contains(unitSearch.trim(), ignoreCase = true) }.take(8)
                if (matches.isEmpty()) Text("No unit matches that.", color = Color.Gray) else Text("Tap the unit:", color = Color.DarkGray)
                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    matches.chunked(4).forEach { row ->
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            row.forEach { u -> FilterChip(selected = false, onClick = { unitId = u.id; office = false }, label = { Text(u.name) }) }
                        }
                    }
                    if (setup.hasClient) FilterChip(selected = false, onClick = { unitId = null; office = true }, label = { Text("The office") })
                }
            }

            // The face photo is taken first; if it is not there now, it can be taken here, so the guard is never stuck.
            val savedFace = (face ?: faceFile).takeIf { it.isFile && it.length() > 0 }
            if (type == "pedestrian" && setup.on("facePhoto") && savedFace == null) {
                Text(if (face == null) "The visitor's face has not been photographed yet. Take it now." else "The photo of the visitor's face was lost. Take it again.", color = Red, fontWeight = FontWeight.Bold)
                PhotoTaker(faceFile, front = false) { face = it }
            }

            if (pass == null) {
                OutlinedTextField(expectedCell, { expectedCell = it.take(16) }, label = { Text("Says they are expected? Their cell number") }, singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone), modifier = Modifier.fillMaxWidth())
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
                face = if (type == "pedestrian") savedFace else null,
                identityPhoto = if (scannedIdentity) null else identityPhoto,
                discPhoto = if (type == "vehicle" && discMethod == "manual") discPhoto else null,
                passId = pass?.passId,
                cell = cellKey,
                stillOnSite = stillOnSite.isNotEmpty() && barred.isEmpty(),
                onSiteReason = onSiteReason,
                onSiteNote = onSiteNote,
            )
            val problem = VisitorRules.problem(setup, draft)
            if (problem != null) Text("Still needed: $problem", color = Amber, fontWeight = FontWeight.Bold)
            BigButton(
                when {
                    state.busy -> "Sending…"
                    barred.isNotEmpty() -> "Record and turn away"
                    pass != null -> "Let them in"
                    else -> "Request approval"
                },
                enabled = !state.busy && problem == null,
            ) { vm.saveVisit(draft) }
            OutlinedButton(onClick = { step = Step.Identity }, modifier = Modifier.fillMaxWidth()) { Text("Back to the ID") }
        }
    }
}

/** The big answer at the end of a visit: let them in, or turn them away. */
@Composable
private fun Verdict(title: String, detail: String, good: Boolean) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.background(if (good) Color(0xFFDFF3E7) else Color(0xFFFBE3E0)).padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(title, color = if (good) Green else Red, fontWeight = FontWeight.Bold, fontSize = 24.sp)
            if (detail.isNotBlank()) Text(detail)
        }
    }
}

/**
 * One visitor after "Request approval": the wait while the customer answers on their phone;
 * then, with no answer, the phone call and how it went; and the answer in large letters.
 */
@Composable
fun VisitScreen(vm: AppViewModel, state: UiState, id: String) {
    val context = LocalContext.current
    var pendingDial by remember { mutableStateOf<String?>(null) }
    val askCall = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        val contact = pendingDial
        pendingDial = null
        if (ok && contact != null) vm.dialCustomer(id, contact)
    }
    fun dial(contact: String) {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.CALL_PHONE) == PackageManager.PERMISSION_GRANTED) vm.dialCustomer(id, contact)
        else {
            pendingDial = contact
            askCall.launch(Manifest.permission.CALL_PHONE)
        }
    }

    VisitorHeader("Visitor") { vm.go(Page.Visitors) }
    val v = state.visit?.takeIf { it.id == id }
    if (v == null) {
        Text("Loading…", color = Color.Gray)
        return
    }
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(v.visitor, fontWeight = FontWeight.Bold, fontSize = 18.sp)
            Text(v.vehicle)
            Text("To see " + (if (v.visiting == "The office") "the office" else v.visiting), color = Color.DarkGray)
        }
    }

    val blocked = v.blocked
    if (blocked != null) {
        Verdict("DO NOT LET THEM IN", blocked, good = false)
    } else if (v.letIn) {
        Verdict("LET THEM IN", v.decided ?: "Approved.", good = true)
    } else if (!v.waiting) {
        Verdict("TURN THE VISITOR AWAY", v.decided ?: v.statusLabel, good = false)
    } else if (!v.canDial) {
        // The customer's time to answer on their phone.
        var left by remember(v.secondsLeft) { mutableIntStateOf(v.secondsLeft) }
        LaunchedEffect(v.secondsLeft) {
            while (left > 0) {
                delay(1000)
                left -= 1
            }
        }
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.background(Color(0xFFFDF0DC)).padding(16.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("Waiting for the answer", fontWeight = FontWeight.Bold, fontSize = 20.sp)
                Text(if (left > 0) "%d:%02d".format(left / 60, left % 60) else "Checking…", fontSize = 40.sp, fontWeight = FontWeight.Bold)
                Text((if (v.asked == 1) "1 person was" else "${v.asked} people were") + " asked on their phone. Keep the visitor at the gate.")
            }
        }
    } else {
        val called = state.calledContact
        val primary = v.dial.primary
        val second = v.dial.second
        Text(if (v.asked == 0) "Nobody at ${v.visiting} uses the app." else "No response.", fontWeight = FontWeight.Bold, fontSize = 20.sp)
        if (called != null) {
            Text("How did the call go?", fontWeight = FontWeight.Bold)
            BigButton("Approved by phone", enabled = !state.busy) { vm.callOutcome(id, called, "approved") }
            Button(onClick = { vm.callOutcome(id, called, "denied") }, enabled = !state.busy, modifier = Modifier.fillMaxWidth().height(64.dp),
                colors = androidx.compose.material3.ButtonDefaults.buttonColors(containerColor = Red)) { Text("Denied by phone", fontSize = 20.sp, fontWeight = FontWeight.Bold) }
            OutlinedButton(onClick = { vm.callOutcome(id, called, "no_answer") }, enabled = !state.busy, modifier = Modifier.fillMaxWidth().height(56.dp)) { Text("No answer", fontSize = 18.sp) }
        } else {
            if (primary == null && second == null) Text("No phone number is set for ${v.visiting}. The visitor cannot be let in.")
            if (primary != null && !primary.tried) {
                Text("Dial the customer?")
                BigButton("Dial ${primary.label}", enabled = !state.busy) { dial("primary") }
            }
            if (primary != null && primary.tried) {
                Text("${primary.label} did not answer.", color = Color.DarkGray)
                if (second != null && !second.tried) BigButton("Dial the second contact", enabled = !state.busy) { dial("second") }
                OutlinedButton(onClick = { dial("primary") }, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) { Text("Dial ${primary.label} again") }
            }
            if (primary == null && second != null && !second.tried) BigButton("Dial the second contact", enabled = !state.busy) { dial("second") }
            if (second != null && second.tried) {
                Text("The second contact did not answer.", color = Color.DarkGray)
                OutlinedButton(onClick = { dial("second") }, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) { Text("Dial the second contact again") }
            }
            if (v.dial.allTried) {
                Button(onClick = { vm.noResponse(id) }, enabled = !state.busy, modifier = Modifier.fillMaxWidth().height(64.dp),
                    colors = androidx.compose.material3.ButtonDefaults.buttonColors(containerColor = Red)) { Text("Nobody answers: turn away", fontSize = 18.sp, fontWeight = FontWeight.Bold) }
            }
        }
        Text("The customer can still answer on their phone while you are dialling.", color = Color.Gray, fontSize = 13.sp)
    }

    if (!v.waiting) BigButton("NEXT VISITOR") { vm.go(Page.Visitors) }
    OutlinedButton(onClick = { vm.go(Page.Visitors) }, modifier = Modifier.fillMaxWidth()) { Text("Back to visitors") }
}

/** The reasons a guard can pick for an exception, and a note. Tapping a chosen reason again clears it. */
@Composable
private fun ReasonPicker(options: List<ReasonOption>, reason: String?, note: String, onReason: (String?) -> Unit, onNote: (String) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        options.forEach { r -> FilterChip(selected = reason == r.id, onClick = { onReason(if (reason == r.id) null else r.id) }, label = { Text(r.label) }) }
    }
    OutlinedTextField(note, { onNote(it.take(300)) }, label = { Text(if (reason == "other") "What happened?" else "Note (optional with a reason)") }, modifier = Modifier.fillMaxWidth())
}

/**
 * A visitor leaving (visitor management, step 5). The guard scans the licence disc, or the ID of
 * a visitor on foot. The entry record comes up to compare against: the same driver, the same
 * number of passengers. If something does not match, the guard gives a reason and decides
 * whether the visitor may go; the customer and the supervisor are told either way.
 */
@Composable
fun VisitorExitScreen(vm: AppViewModel, state: UiState) {
    val context = LocalContext.current
    VisitorHeader("Visitor leaving") { vm.go(Page.Visitors) }
    val setup = state.gate
    if (setup == null || setup.gate == null) {
        Text(setup?.message ?: if (state.busy) "Loading…" else "This phone is not set up as a gate phone.", color = Color.DarkGray)
        return
    }

    val done = state.exitDone
    if (done != null) {
        when (done.status) {
            "exited" -> Verdict("SCANNED OUT", done.message, good = true)
            "exited_exception" -> Verdict("SCANNED OUT, WITH AN EXCEPTION", done.message, good = true)
            "held" -> Verdict("NOT LET GO", done.message, good = false)
            else -> Verdict("EXCEPTION RECORDED", done.message, good = false)
        }
        BigButton("NEXT VISITOR") { vm.go(Page.Visitors) }
        return
    }

    val eventId = remember { UUID.randomUUID().toString() }
    val photoFile = remember { File(File(context.filesDir, "visitor-photos").also { it.mkdirs() }, "exception.jpg").also { it.delete() } }
    var onFoot by remember { mutableStateOf(false) }
    var typeIt by remember { mutableStateOf(false) }
    var typed by remember { mutableStateOf("") }
    var note by remember { mutableStateOf<String?>(null) }
    // What was scanned or typed: the number plate of a vehicle, or the ID number of a visitor on foot.
    var registration by remember { mutableStateOf<String?>(null) }
    var idNumber by remember { mutableStateOf<String?>(null) }
    var sameDriver by remember { mutableStateOf<Boolean?>(null) }
    var pax by remember { mutableStateOf("") }
    var reason by remember { mutableStateOf<String?>(null) }
    var why by remember { mutableStateOf("") }
    var addPhoto by remember { mutableStateOf(false) }
    var photo by remember { mutableStateOf<File?>(null) }

    val found = state.exitFound
    if (found == null) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FilterChip(selected = !onFoot, onClick = { onFoot = false; typeIt = false; typed = ""; note = null }, label = { Text("Vehicle") })
            FilterChip(selected = onFoot, onClick = { onFoot = true; typeIt = false; typed = ""; note = null }, label = { Text("On foot") })
        }
        note?.let { Text(it, color = Red, fontWeight = FontWeight.Bold) }
        if (state.busy) {
            Text("Looking for the visit…", color = Color.DarkGray)
        } else if (!typeIt) {
            Text(if (onFoot) "Hold the phone over the barcode on the visitor's ID." else "Hold the phone over the licence disc on the windscreen until it reads.")
            DocumentScanner { code ->
                val s = VisitorScan.read(code)
                if (!onFoot && s is Scanned.Disc) {
                    note = null
                    registration = s.registration
                    idNumber = null
                    vm.findExit(null, s.registration)
                } else if (onFoot && s is Scanned.Identity) {
                    note = null
                    idNumber = s.idNumber
                    registration = null
                    vm.findExit(s.idNumber, null)
                } else {
                    note = if (onFoot) "That barcode is not an ID. Try again, or type the ID number." else "That is not a licence disc. Scan the round disc on the windscreen."
                }
            }
            OutlinedButton(onClick = { typeIt = true; note = null }, modifier = Modifier.fillMaxWidth()) { Text("It will not scan: type it in") }
        } else {
            OutlinedTextField(typed, { typed = it.take(20).uppercase() }, label = { Text(if (onFoot) "ID or passport number" else "Number plate") }, singleLine = true,
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters), modifier = Modifier.fillMaxWidth())
            val ready = if (onFoot) VisitorScan.idNumber(typed).length >= 5 else VisitorScan.plate(typed).length >= 2
            BigButton("FIND", enabled = ready) {
                if (onFoot) {
                    idNumber = VisitorScan.idNumber(typed)
                    registration = null
                } else {
                    registration = VisitorScan.plate(typed)
                    idNumber = null
                }
                vm.findExit(idNumber, registration)
            }
            OutlinedButton(onClick = { typeIt = false }, modifier = Modifier.fillMaxWidth()) { Text("Try scanning again") }
        }
        return
    }

    // The entry record, to compare against who and what is at the gate now.
    val visit = found.visit
    if (visit != null) {
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text("CAME IN AT ${time(visit.enteredAt)}, ${visit.gateName}", color = Color.DarkGray, fontSize = 13.sp)
                Text(visit.visitor, fontWeight = FontWeight.Bold, fontSize = 20.sp)
                Text(visit.vehicle ?: "On foot")
                visit.paxIn?.let { Text("$it passenger" + (if (it == 1) "" else "s") + " came in with the driver", fontWeight = FontWeight.Bold) }
                Text("To see " + (if (visit.visiting == "The office") "the office" else visit.visiting) + " · ${visit.category}", color = Color.DarkGray)
            }
        }
        val face = state.exitFace
        if (face != null) {
            val bitmap = remember(face) { android.graphics.BitmapFactory.decodeByteArray(face.bytes, 0, face.bytes.size)?.asImageBitmap() }
            if (bitmap != null) {
                Text("The photo taken when they came in. Is this the same person?", fontWeight = FontWeight.Bold)
                androidx.compose.foundation.Image(bitmap, contentDescription = "The visitor when they came in", modifier = Modifier.fillMaxWidth().height(260.dp))
            }
        }
    }

    val needsDecision = found.exceptions.isNotEmpty() && (visit == null || state.exitChecked || (!found.askDriver && !found.askPax))
    val draft = ExitDraft(
        eventId = eventId,
        visitId = visit?.id,
        idNumber = idNumber,
        registration = registration,
        sameDriver = sameDriver,
        paxOut = pax.toIntOrNull(),
        reason = reason,
        note = why,
        photo = photo,
    )

    if (!needsDecision && visit != null) {
        if (found.askDriver) {
            Text("Is ${visit.visitor} driving?", fontWeight = FontWeight.Bold, fontSize = 18.sp)
            Text("Ask for the driver's licence or ID and compare the name.", color = Color.DarkGray)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilterChip(selected = sameDriver == true, onClick = { sameDriver = true }, label = { Text("Yes, the same driver") })
                FilterChip(selected = sameDriver == false, onClick = { sameDriver = false }, label = { Text("No, someone else") })
            }
        }
        if (found.askPax) {
            OutlinedTextField(pax, { v -> pax = v.filter { it.isDigit() }.take(2) }, label = { Text("Passengers leaving, not counting the driver") }, singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), modifier = Modifier.fillMaxWidth())
        }
        val problem = VisitorRules.exitProblem(found, draft)
        if (problem != null) Text("Still needed: $problem", color = Amber, fontWeight = FontWeight.Bold)
        BigButton(if (state.busy) "Checking…" else "SCAN OUT", enabled = !state.busy && problem == null) { vm.leave(draft) }
    }

    if (needsDecision) {
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.background(Color(0xFFFBE3E0)).padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("EXCEPTION", color = Red, fontWeight = FontWeight.Bold, fontSize = 20.sp)
                found.exceptions.forEach { e -> Text(e.text, fontWeight = FontWeight.Bold) }
                if (visit != null && found.exceptions.any { it.type == "pax_mismatch" }) Text("Came in: ${visit.paxIn ?: "?"}. Leaving: ${pax.ifBlank { "?" }}.")
                Text("Say why, then decide. Your supervisor" + (if (visit != null) " and the customer are" else " is") + " told either way.")
            }
        }
        Text("Why?", fontWeight = FontWeight.Bold)
        // Only the reasons that fit what was raised.
        val types = found.exceptions.map { it.type }
        val fits = buildList {
            if ("driver_mismatch" in types) add("passenger_driving")
            if ("pax_mismatch" in types) { add("passengers_stayed"); add("passengers_added") }
            if ("vehicle_mismatch" in types) add("vehicle_stayed")
            if ("no_open_visit" in types) add("not_scanned_in")
            add("other")
        }
        ReasonPicker(found.reasons.filter { it.id in fits }, reason, why, { reason = it }, { why = it })
        if (!addPhoto) {
            OutlinedButton(onClick = { addPhoto = true }, modifier = Modifier.fillMaxWidth()) { Text("Add a photo (optional)") }
        } else {
            PhotoTaker(photoFile, front = false) { photo = it }
        }
        val problem = VisitorRules.handlingProblem(reason, why)
        if (problem != null) Text("Still needed: $problem", color = Amber, fontWeight = FontWeight.Bold)
        val go = if (visit == null) "RECORD: LET THEM GO" else "LET THEM GO"
        BigButton(if (state.busy) "Sending…" else go, enabled = !state.busy && problem == null) { vm.leave(draft.copy(allowed = true)) }
        Button(onClick = { vm.leave(draft.copy(allowed = false)) }, enabled = !state.busy && problem == null, modifier = Modifier.fillMaxWidth().height(64.dp),
            colors = androidx.compose.material3.ButtonDefaults.buttonColors(containerColor = Red)) { Text("DO NOT LET THEM GO", fontSize = 20.sp, fontWeight = FontWeight.Bold) }
    }
    OutlinedButton(onClick = { vm.go(Page.Visitors) }, modifier = Modifier.fillMaxWidth()) { Text("Cancel: back to visitors") }
}

/**
 * One visitor on the on-site list. A visitor past their time is in red, with the three things
 * the guard can do: phone the customer, confirm they are still on site, or mark them as having
 * left without being scanned out. The last two need a note.
 */
@Composable
private fun OnSiteCard(v: OnSiteVisitor, busy: Boolean, inHandover: Boolean, onDial: () -> Unit, onAct: (String, String) -> Unit) {
    var note by remember(v.id) { mutableStateOf("") }
    var open by remember(v.id) { mutableStateOf(false) }
    val done = if (inHandover) v.handoverAction else v.action
    val red = v.overdue && (if (inHandover) v.todo else v.needsAction)
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.background(if (red) Color(0xFFFBE3E0) else if (v.overdue) Color(0xFFFDF0DC) else Color.Transparent).padding(12.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            if (v.overdue) Text("PAST THEIR TIME BY ${(v.overBy ?: "").uppercase()}", color = if (red) Red else Amber, fontWeight = FontWeight.Bold)
            Text(v.visitor, fontWeight = FontWeight.Bold, fontSize = 18.sp)
            Text((v.vehicle ?: "On foot") + (v.pax?.let { " · $it passenger" + if (it == 1) "" else "s" } ?: ""))
            Text("To see " + (if (v.visiting == "The office") "the office" else v.visiting) + " · ${v.category}", color = Color.DarkGray, fontSize = 13.sp)
            Text("Came in ${time(v.enteredAt)} at ${v.gateName} · on site ${v.stay}", color = Color.DarkGray, fontSize = 13.sp)
            if (done != null) Text("${done.label}" + (if (done.note.isNotBlank()) ": ${done.note}" else "") + " (${done.by}, ${time(done.at)})", fontWeight = FontWeight.Bold)
            if (v.overdue) {
                OutlinedButton(onClick = onDial, enabled = !busy, modifier = Modifier.fillMaxWidth()) { Text("Dial the customer") }
                OutlinedTextField(note, { note = it.take(300) }, label = { Text("Note: what did you find?") }, modifier = Modifier.fillMaxWidth())
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = { onAct("confirmed", note); note = "" }, enabled = !busy && note.trim().length >= 3, modifier = Modifier.weight(1f)) { Text("Still on site") }
                    Button(onClick = { onAct("left", note); note = "" }, enabled = !busy && note.trim().length >= 3, modifier = Modifier.weight(1f),
                        colors = androidx.compose.material3.ButtonDefaults.buttonColors(containerColor = Red)) { Text("Left, not scanned out") }
                }
            } else if (!open) {
                OutlinedButton(onClick = { open = true }, enabled = !busy) { Text("Left without being scanned out…") }
            } else {
                OutlinedTextField(note, { note = it.take(300) }, label = { Text("Note: how do you know they left?") }, modifier = Modifier.fillMaxWidth())
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = { onAct("left", note); note = ""; open = false }, enabled = !busy && note.trim().length >= 3,
                        colors = androidx.compose.material3.ButtonDefaults.buttonColors(containerColor = Red)) { Text("Mark as left") }
                    OutlinedButton(onClick = { open = false; note = "" }) { Text("Cancel") }
                }
            }
        }
    }
}

/** Phones the customer about an overstay, asking for the phone permission first if the app does not have it yet. */
@Composable
private fun rememberOverstayDialer(vm: AppViewModel, inHandover: Boolean): (String) -> Unit {
    val context = LocalContext.current
    var pending by remember { mutableStateOf<String?>(null) }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        val id = pending
        pending = null
        if (ok && id != null) vm.overstayAction(id, "dialled", "", inHandover)
    }
    return { id ->
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.CALL_PHONE) == PackageManager.PERMISSION_GRANTED) vm.overstayAction(id, "dialled", "", inHandover)
        else {
            pending = id
            ask.launch(Manifest.permission.CALL_PHONE)
        }
    }
}

/** Everyone on site now (visitor management, step 6): visitors past their time first, in red. */
@Composable
fun OnSiteScreen(vm: AppViewModel, state: UiState) {
    VisitorHeader("On site now") { vm.go(Page.Visitors) }
    val list = state.onSite
    if (list == null) {
        Text(if (state.busy) "Loading…" else "The list could not be loaded. Tap Refresh.", color = Color.Gray)
        OutlinedButton(onClick = { vm.loadOnSite() }, modifier = Modifier.fillMaxWidth()) { Text("Refresh") }
        return
    }
    val dial = rememberOverstayDialer(vm, inHandover = false)
    Text("${list.onSite} on site" + (if (list.overstays > 0) ", ${list.overstays} past their time" else ""), fontWeight = FontWeight.Bold, fontSize = 18.sp)
    if (list.visitors.isEmpty()) Text("No visitors are on site.", color = Color.Gray)
    list.visitors.forEach { v -> OnSiteCard(v, state.busy, inHandover = false, onDial = { dial(v.id) }) { action, note -> vm.overstayAction(v.id, action, note, false) } }
    OutlinedButton(onClick = { vm.loadOnSite() }, modifier = Modifier.fillMaxWidth()) { Text("Refresh") }
}

/**
 * "Hand over shift" (visitor management, step 6). The outgoing gate guard goes through everyone
 * on site. Each visitor past their time needs an action in this handover before he can sign
 * off; after signing off he can log Duty From, and the incoming guard is shown the list.
 */
@Composable
fun HandoverScreen(vm: AppViewModel, state: UiState) {
    VisitorHeader("Hand over shift") { vm.go(Page.Visitors) }
    if (state.handoverDone) {
        Verdict("HANDED OVER", "The next guard will see this list when they open Visitors. You can now log Duty From.", good = true)
        BigButton("BACK TO HOME") { vm.go(Page.Home) }
        return
    }
    val h = state.handover
    if (h == null) {
        Text(if (state.busy) "Loading…" else "The handover could not be loaded. Tap Try again.", color = Color.Gray)
        OutlinedButton(onClick = { vm.startHandover() }, modifier = Modifier.fillMaxWidth()) { Text("Try again") }
        return
    }
    val dial = rememberOverstayDialer(vm, inHandover = true)
    Text("${h.onSite} on site, ${h.overstays} past their time", fontWeight = FontWeight.Bold, fontSize = 18.sp)
    if (h.todo > 0) Text("Deal with each visitor in red (${h.todo} to go): dial the customer, or type a note and say whether they are still on site.", color = Red, fontWeight = FontWeight.Bold)
    else Text("Check the list below against who is really still on site, then sign off.")
    h.visitors.forEach { v -> OnSiteCard(v, state.busy, inHandover = true, onDial = { dial(v.id) }) { action, note -> vm.overstayAction(v.id, action, note, true) } }
    BigButton(if (state.busy) "Sending…" else "SIGN OFF: HAND OVER", enabled = !state.busy && h.canSignOff) { vm.signOffHandover() }
}
