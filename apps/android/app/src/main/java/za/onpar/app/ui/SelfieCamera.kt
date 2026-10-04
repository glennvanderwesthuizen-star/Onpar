package za.onpar.app.ui

import android.Manifest
import android.content.pm.PackageManager
import android.graphics.BitmapFactory
import android.util.Size
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ExperimentalGetImage
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
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
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.face.FaceDetection
import com.google.mlkit.vision.face.FaceDetector
import com.google.mlkit.vision.face.FaceDetectorOptions
import kotlinx.coroutines.delay
import za.onpar.core.BlinkCheck
import java.io.File
import java.util.concurrent.Executors

/**
 * Takes a photo with the front camera (the Duty On / Duty From selfie) or the back camera,
 * saved as a JPEG in the app's own storage. Calls [onTaken] with the file, or null when retaken.
 *
 * With [onLiveness], the guard first blinks for the camera (D-36): the face finder runs on the
 * phone and nothing leaves it. After a while he may take the selfie anyway; it is then marked
 * "not_passed" for a person to look at. It never stops him working.
 */
@Composable
fun PhotoTaker(file: File, front: Boolean, onLiveness: ((String) -> Unit)? = null, onTaken: (File?) -> Unit) {
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
            val blink = remember { BlinkCheck() }
            var step by remember { mutableStateOf(blink.step) }
            var waited by remember { mutableIntStateOf(0) }
            val checking = onLiveness != null
            if (checking) {
                LaunchedEffect(Unit) {
                    while (waited < BlinkCheck.ALLOW_SKIP_AFTER_SECONDS) {
                        delay(1000)
                        waited++
                    }
                }
            }
            val detector = remember {
                if (!checking) null
                else FaceDetection.getClient(
                    FaceDetectorOptions.Builder()
                        .setPerformanceMode(FaceDetectorOptions.PERFORMANCE_MODE_FAST)
                        .setClassificationMode(FaceDetectorOptions.CLASSIFICATION_MODE_ALL)
                        .build(),
                )
            }
            val analysisExecutor = remember { Executors.newSingleThreadExecutor() }
            DisposableEffect(Unit) {
                onDispose {
                    analysisExecutor.shutdown()
                    detector?.close()
                }
            }
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
                    val selector = if (front) CameraSelector.DEFAULT_FRONT_CAMERA else CameraSelector.DEFAULT_BACK_CAMERA
                    if (detector != null) {
                        val analysis = ImageAnalysis.Builder().setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST).build()
                        analysis.setAnalyzer(analysisExecutor) { proxy -> analyseFace(proxy, detector, blink) { step = it } }
                        runCatching { provider.bindToLifecycle(owner, selector, preview, capture, analysis) }
                            .onFailure { provider.bindToLifecycle(owner, selector, preview, capture) }
                    } else {
                        provider.bindToLifecycle(owner, selector, preview, capture)
                    }
                }, ContextCompat.getMainExecutor(ctx))
                view
            }, modifier = Modifier.fillMaxWidth().height(320.dp))
            error?.let { Text(it) }
            val passed = step == BlinkCheck.Step.PASSED
            if (checking) {
                Text(
                    blink.message,
                    fontSize = 20.sp,
                    fontWeight = FontWeight.Bold,
                    color = if (passed) Color(0xFF1B7F3B) else Color(0xFF8A5A00),
                )
            }
            val takeIt: () -> Unit = {
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
            }
            Button(
                onClick = {
                    onLiveness?.invoke("passed")
                    takeIt()
                },
                enabled = !checking || passed,
                modifier = Modifier.fillMaxWidth().height(56.dp),
            ) { Text(if (front) "Take selfie" else "Take photo") }
            if (checking && !passed && waited >= BlinkCheck.ALLOW_SKIP_AFTER_SECONDS) {
                OutlinedButton(onClick = {
                    onLiveness?.invoke("not_passed")
                    takeIt()
                }, modifier = Modifier.fillMaxWidth()) { Text("The blink check does not work: take the selfie anyway") }
                Text("Your supervisor will check this selfie.", color = Color.Gray, fontSize = 13.sp)
            }
        }
    }
}

/** One camera frame through the face finder, into the blink check. Always releases the frame. */
@OptIn(ExperimentalGetImage::class)
private fun analyseFace(proxy: ImageProxy, detector: FaceDetector, blink: BlinkCheck, onStep: (BlinkCheck.Step) -> Unit) {
    val media = proxy.image
    if (media == null) {
        proxy.close()
        return
    }
    detector.process(InputImage.fromMediaImage(media, proxy.imageInfo.rotationDegrees))
        .addOnSuccessListener { faces ->
            val f = faces.firstOrNull()
            onStep(blink.frame(faces.size, f?.leftEyeOpenProbability, f?.rightEyeOpenProbability))
        }
        .addOnCompleteListener { proxy.close() }
}
