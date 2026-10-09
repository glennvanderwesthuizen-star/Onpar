package za.onpar.app.ui

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import za.onpar.app.AppViewModel
import za.onpar.app.Page
import za.onpar.app.UiState

/**
 * Write in the Occurrence Book (owner, 9 Oct 2026, D-51): anything that happened that On Par
 * did not record by itself. It cannot be changed afterwards; a correction is a new entry.
 */
@Composable
fun BookEntryScreen(vm: AppViewModel, state: UiState) {
    var text by rememberSaveable { mutableStateOf("") }
    Text("Occurrence Book", style = MaterialTheme.typography.titleLarge)
    Text("Write what happened, where and who was involved. The time is taken now. An entry cannot be changed afterwards; to correct it, write a new entry.", color = Color.DarkGray)
    Text("This is not the official Occurrence Book. Keep writing in the site's OB as usual.", color = Color(0xFFB86E00))
    OutlinedTextField(text, { text = it.take(2000) }, label = { Text("What happened") }, minLines = 5, modifier = Modifier.fillMaxWidth())
    BigButton(if (state.busy) "Saving…" else "WRITE IT IN THE BOOK", enabled = !state.busy && text.trim().length >= 3) { vm.writeInBook(text) }
    OutlinedButton(onClick = { vm.go(Page.Home) }, modifier = Modifier.fillMaxWidth().height(52.dp)) { Text("Cancel") }
}
