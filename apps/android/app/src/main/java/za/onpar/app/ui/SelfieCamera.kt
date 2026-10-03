package za.onpar.app.ui

import android.Manifest
import android.content.pm.PackageManager
import android.graphics.BitmapFactory
import android.util.Size
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.Preview
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import java.io.File

/**
 * Takes a photo with the front camera (the Duty On / Duty From selfie) or the back camera,
 * saved as a JPEG in the app's own storage. Calls [onTaken] with the file, or null when retaken.
 */
@Composable
fun PhotoTaker(file: File, front: Boolean, onTaken: (File?) -> Unit) {
    val context = LocalContext.current
    var allowed by remember {
        mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED)
    }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { allowed = it }
    LaunchedEffect(Unit) { if (!allowed) ask.launch(Manifest.permission.CAMERA) }
    var taken by remember { mutableStateOf(file.exists() && file.length() > 0) }
    var error by remember { mutableStateOf<String?>(null) }
    val owner = LocalLifecycleOwner.current

    if (!allowed) {
        Button(onClick = { ask.launch(Manifest.permission.CAMERA) }) { Text("Allow the camera") }
        return
    }
    Column {
        if (taken) {
            val bitmap = remember(file.lastModified()) { BitmapFactory.decodeFile(file.absolutePath)?.asImageBitmap() }
            bitmap?.let { Image(it, contentDescription = "Your photo", modifier = Modifier.fillMaxWidth().height(260.dp)) }
            OutlinedButton(onClick = {
                file.delete()
                taken = false
                onTaken(null)
            }, modifier = Modifier.fillMaxWidth()) { Text("Take it again") }
        } else {
            val capture = remember {
                ImageCapture.Builder()
                    .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
                    // A modest size keeps uploads small on a weak signal.
                    .setResolutionSelector(
                        ResolutionSelector.Builder()
                            .setResolutionStrategy(ResolutionStrategy(Size(960, 1280), ResolutionStrategy.FALLBACK_RULE_CLOSEST_LOWER_THEN_HIGHER))
                            .build(),
                    )
                    .build()
            }
            AndroidView(factory = { ctx ->
                val view = PreviewView(ctx)
                val future = ProcessCameraProvider.getInstance(ctx)
                future.addListener({
                    val provider = future.get()
                    val preview = Preview.Builder().build().also { it.setSurfaceProvider(view.surfaceProvider) }
                    provider.unbindAll()
                    provider.bindToLifecycle(owner, if (front) CameraSelector.DEFAULT_FRONT_CAMERA else CameraSelector.DEFAULT_BACK_CAMERA, preview, capture)
                }, ContextCompat.getMainExecutor(ctx))
                view
            }, modifier = Modifier.fillMaxWidth().height(320.dp))
            error?.let { Text(it) }
            Button(onClick = {
                file.parentFile?.mkdirs()
                capture.takePicture(
                    ImageCapture.OutputFileOptions.Builder(file).build(),
                    ContextCompat.getMainExecutor(context),
                    object : ImageCapture.OnImageSavedCallback {
                        override fun onImageSaved(output: ImageCapture.OutputFileResults) {
                            // Turn it upright off the main thread, then show it.
                            Thread {
                                runCatching { makeUpright(file) }
                                ContextCompat.getMainExecutor(context).execute {
                                    taken = true
                                    onTaken(file)
                                }
                            }.start()
                        }

                        override fun onError(e: ImageCaptureException) {
                            error = "The photo could not be taken. Try again."
                        }
                    },
                )
            }, modifier = Modifier.fillMaxWidth().height(56.dp)) { Text(if (front) "Take selfie" else "Take photo") }
        }
    }
}
