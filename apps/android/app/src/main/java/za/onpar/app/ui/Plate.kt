package za.onpar.app.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import za.onpar.app.R
import za.onpar.core.TsfNumber

private val PlateBlue = Color(0xFF10308A)

/** The guard's TSF number as a number plate: "BCD [TSF shield] 123 GP", dark blue on white. */
@Composable
fun TsfPlate(number: String, modifier: Modifier = Modifier) {
    val parts = TsfNumber.parts(number)
    val shape = RoundedCornerShape(6.dp)
    Row(
        modifier
            .background(Color.White, shape)
            .border(3.dp, PlateBlue, shape)
            .padding(horizontal = 12.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        if (parts == null) {
            part(number)
        } else {
            part(parts.first)
            Image(painterResource(R.drawable.tsf_logo), contentDescription = null, modifier = Modifier.size(34.dp))
            part(parts.second)
            part(" " + parts.third)
        }
    }
}

@Composable
private fun part(t: String) = Text(t, color = PlateBlue, fontSize = 34.sp, fontWeight = FontWeight.ExtraBold, fontFamily = FontFamily.SansSerif)
