package za.onpar.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import za.onpar.app.ui.OnParScreens

class MainActivity : ComponentActivity() {
    private val vm: AppViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            val state by vm.state.collectAsStateWithLifecycle()
            MaterialTheme {
                Surface { OnParScreens(state, vm) }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        // On managed phones, lock the screen to On Par (kiosk mode).
        Kiosk.enter(this)
    }
}
