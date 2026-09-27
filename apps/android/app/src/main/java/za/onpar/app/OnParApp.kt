package za.onpar.app

import android.app.Application
import za.onpar.core.OnParDevice
import java.io.File

/** Holds the one On Par device object for the whole app. Its data lives in the app's private storage. */
class OnParApp : Application() {
    val device: OnParDevice by lazy { OnParDevice(File(filesDir, "onpar")) }
}
