package za.onpar.app.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import za.onpar.app.AppViewModel
import za.onpar.app.Page
import za.onpar.app.UiState

private val Silver = Color(0xFF8A939B)
private val Gold = Color(0xFFB8860B)
private val Ink = Color(0xFF1F2328)

private fun insigniaColour(i: String) = when (i) {
    "gold" -> Gold
    "silver" -> Silver
    else -> Ink
}

private val MONTHS = listOf("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
private fun monthLabel(m: String) = "${MONTHS[(m.substring(5, 7).toIntOrNull() ?: 1) - 1]} ${m.substring(0, 4)}"

/**
 * My Wire (owner's rule book, 8 Oct 2026). Reward only: what he has earned, what he can still
 * earn and how close the next insignia is. Nothing negative, no rand amounts, no other guards.
 */
@Composable
fun WireScreen(vm: AppViewModel, state: UiState) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text("My Wire", style = MaterialTheme.typography.headlineSmall, modifier = Modifier.weight(1f))
        OutlinedButton(onClick = { vm.go(Page.Home) }) { Text("Back") }
    }
    val w = state.wire
    if (w == null) {
        Text(if (state.busy) "Loading…" else "Your Wire will show when the phone has signal.")
        return
    }
    val colour = insigniaColour(w.insignia)
    Card(Modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = Color.White)) {
        Column(Modifier.padding(16.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(w.insigniaLabel.uppercase(), color = colour, fontWeight = FontWeight.Black, fontSize = 20.sp)
            Text("${w.wireTotal}", fontSize = 48.sp, fontWeight = FontWeight.Bold)
            Text("barbs on your Wire", color = Color.Gray)
            WireDrawing(w.barbsDrawn)
            Text("${w.available} barbs available", fontWeight = FontWeight.Bold)
        }
    }
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text("THIS MONTH", fontWeight = FontWeight.Bold, color = Color.Gray, fontSize = 13.sp)
            Text("${w.thisMonth.total} barbs earned", fontSize = 22.sp, fontWeight = FontWeight.Bold)
            w.thisMonth.bySource.forEach { Text("${it.label}: +${it.barbs}") }
            if (w.streak > 0) Text("${w.streak} month${if (w.streak == 1) "" else "s"} in a row at the standard.", color = Green, fontWeight = FontWeight.Bold)
        }
    }
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text("NEXT", fontWeight = FontWeight.Bold, color = Color.Gray, fontSize = 13.sp)
            Text("${w.next.toGo} barbs to the ${w.next.name}", fontSize = 18.sp, fontWeight = FontWeight.Bold)
            w.next.months?.takeIf { it > 0 }?.let { Text("About $it month${if (it == 1) "" else "s"} at your pace.") }
            Text(
                "Every shift can earn ${w.perShift} barbs: be on duty ${w.readyLeadMinutes} minutes before the start, finish your duties, and hand over what you reported.",
                color = Color.Gray, fontSize = 14.sp,
            )
        }
    }
    if (w.months.isNotEmpty()) {
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("YOUR MONTHS", fontWeight = FontWeight.Bold, color = Color.Gray, fontSize = 13.sp)
                w.months.forEach { m ->
                    val award = when (m.award) {
                        "standard" -> " · standard award"
                        "improvement" -> " · improvement award"
                        else -> ""
                    }
                    Text("${monthLabel(m.month)}: ${m.barbs} barbs$award")
                }
            }
        }
    }
    if (w.recent.isNotEmpty()) {
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text("LATEST BARBS", fontWeight = FontWeight.Bold, color = Color.Gray, fontSize = 13.sp)
                w.recent.forEach { Text("${it.date}  ${it.label}  +${it.barbs}", fontSize = 14.sp) }
            }
        }
    }
}

/** The Wire as a strand of wire with one barb for every 100 earned (at most 50 drawn). */
@Composable
private fun WireDrawing(barbs: Int) {
    val shown = barbs.coerceIn(0, 50)
    Canvas(Modifier.fillMaxWidth().height(28.dp)) {
        val y = size.height / 2
        drawLine(Ink, Offset(0f, y), Offset(size.width, y), strokeWidth = 3f)
        if (shown == 0) return@Canvas
        val gap = size.width / (shown + 1)
        for (i in 1..shown) {
            val x = gap * i
            // The barb at 1,000 is silver and the barb at 5,000 is gold (rule book).
            val c = when (i) {
                50 -> Gold
                10 -> Silver
                else -> Ink
            }
            val p = Path().apply {
                moveTo(x - 7f, y - 9f)
                lineTo(x + 7f, y + 9f)
                moveTo(x + 7f, y - 9f)
                lineTo(x - 7f, y + 9f)
            }
            drawPath(p, c, style = androidx.compose.ui.graphics.drawscope.Stroke(width = 3f))
        }
    }
}
