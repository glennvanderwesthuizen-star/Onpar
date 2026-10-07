package za.onpar.app.ui

import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
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
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import za.onpar.app.AppViewModel
import za.onpar.app.UiState
import za.onpar.core.Contact
import za.onpar.core.EmergencyButton
import za.onpar.core.emergencyButtons

private val PoliceBlue = Color(0xFF123C7A)
private val FireRed = Color(0xFFB3261E)
private val AmbulanceGreen = Color(0xFF0B6B3A)
private val ArmedDark = Color(0xFF22262B)

private fun colourOf(service: String) = when (service) {
    "police" -> PoliceBlue
    "fire" -> FireRed
    "ambulance" -> AmbulanceGreen
    else -> ArmedDark
}

/**
 * The emergency panel (owner, 7 Oct 2026): Police, Fire brigade, Ambulance and the site's armed
 * response company. Shown after PANIC and on the Call screen. Nothing is dialled until the guard
 * taps. Police opens to two choices when the site has its local station's number: 10111 and the
 * station. The armed response button carries the company's logo when the site has one.
 */
@Composable
fun EmergencyPanel(vm: AppViewModel, state: UiState, panicId: String?) {
    val buttons = state.contacts.emergencyButtons()
    if (buttons.isEmpty()) return
    var open by remember { mutableStateOf<String?>(null) }
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("EMERGENCY", fontWeight = FontWeight.Black, fontSize = 18.sp)
        Text("Tap who you need. The phone calls them.", color = Color.Gray, fontSize = 14.sp)
        buttons.forEach { b ->
            val colour = colourOf(b.service)
            ServiceButton(b, colour, if (b.service == "armed_response") state.armedLogo?.bytes else null) {
                if (b.options.size == 1) vm.emergencyCall(b.options.first(), panicId) else open = if (open == b.service) null else b.service
            }
            if (open == b.service && b.options.size > 1) {
                b.options.forEach { c ->
                    Button(
                        onClick = { vm.emergencyCall(c, panicId) },
                        modifier = Modifier.fillMaxWidth().padding(start = 20.dp).heightIn(min = 60.dp),
                        colors = ButtonDefaults.buttonColors(containerColor = colour),
                        shape = RoundedCornerShape(10.dp),
                    ) { OptionText(c) }
                }
            }
        }
    }
}

@Composable
private fun OptionText(c: Contact) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Text("📞 ${c.label}", fontSize = 18.sp, fontWeight = FontWeight.Bold, color = Color.White)
        if (c.name.isNotBlank()) Text(c.name, fontSize = 14.sp, color = Color.White)
    }
}

@Composable
private fun ServiceButton(b: EmergencyButton, colour: Color, logo: ByteArray?, onClick: () -> Unit) {
    val only = b.options.singleOrNull()
    val bitmap = remember(logo) { logo?.let { runCatching { BitmapFactory.decodeByteArray(it, 0, it.size)?.asImageBitmap() }.getOrNull() } }
    Button(onClick = onClick, modifier = Modifier.fillMaxWidth().heightIn(min = 68.dp), colors = ButtonDefaults.buttonColors(containerColor = colour), shape = RoundedCornerShape(10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            if (bitmap != null) {
                // The logo sits on white so any company's colours stay readable.
                Image(bitmap, contentDescription = null, contentScale = ContentScale.Fit, modifier = Modifier.size(72.dp, 48.dp).clip(RoundedCornerShape(6.dp)).background(Color.White).padding(4.dp))
            }
            Column(horizontalAlignment = if (bitmap != null) Alignment.Start else Alignment.CenterHorizontally) {
                Text(b.title, fontSize = 20.sp, fontWeight = FontWeight.Black, color = Color.White)
                val under = when {
                    only == null -> "Tap to choose: 10111 or the local station"
                    only.national -> only.phone
                    else -> only.name
                }
                if (under.isNotBlank()) Text(under, fontSize = 14.sp, color = Color.White)
            }
        }
    }
}
