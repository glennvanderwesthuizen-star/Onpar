package za.onpar.app.ui

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.media.MediaRecorder
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.video.FallbackStrategy
import androidx.camera.video.FileOutputOptions
import androidx.camera.video.Quality
import androidx.camera.video.QualitySelector
import androidx.camera.video.Recorder
import androidx.camera.video.Recording
import androidx.camera.video.VideoCapture
import androidx.camera.video.VideoRecordEvent
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.delay
import java.io.File

/** The longest BOLO video (owner, 3 Oct 2026) and voice note. */
const val BOLO_VIDEO_SECONDS = 30
const val VOICE_NOTE_MAX_SECONDS = 120

private val RecordRed = Color(0xFFB3261E)

private fun hasMic(context: Context) = ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

/**
 * A voice note: press and hold to record, let go to stop. Recorded only while the button is
 * held. Saved as an M4A (AAC) file. Calls [onDone] with the file, or null when deleted.
 */
@Composable
fun VoiceRecorder(file: File, onDone: (File?) -> Unit) {
    val context = LocalContext.current
    var allowed by remember { mutableStateOf(hasMic(context)) }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { allowed = it }
    LaunchedEffect(Unit) { if (!allowed) ask.launch(Manifest.permission.RECORD_AUDIO) }
    var recording by remember { mutableStateOf(false) }
    var seconds by remember { mutableIntStateOf(0) }
    var have by remember { mutableStateOf(file.exists() && file.length() > 0) }
    var problem by remember { mutableStateOf<String?>(null) }

    if (!allowed) {
        Button(onClick = { ask.launch(Manifest.permission.RECORD_AUDIO) }) { Text("Allow the microphone") }
        return
    }
    LaunchedEffect(recording) {
        seconds = 0
        while (recording) {
            delay(1000)
            seconds++
        }
    }
    Column {
        Box(
            Modifier
                .fillMaxWidth()
                .height(110.dp)
                .clip(RoundedCornerShape(16.dp))
                .background(if (recording) RecordRed else Color(0xFF1D4F91))
                .pointerInput(Unit) {
                    detectTapGestures(onPress = {
                        val rec = startVoice(context, file)
                        if (rec == null) {
                            problem = "The microphone could not start. Try again."
                            return@detectTapGestures
                        }
                        problem = null
                        recording = true
                        val started = System.currentTimeMillis()
                        tryAwaitRelease()
                        recording = false
                        val ok = runCatching { rec.stop() }.isSuccess
                        rec.release()
                        if (ok && System.currentTimeMillis() - started >= 1000) {
                            have = true
                            onDone(file)
                        } else {
                            file.delete()
                            problem = "Too short. Hold the button while you speak."
                        }
                    })
                },
            contentAlignment = Alignment.Center,
        ) {
            Text(
                if (recording) "🎤 Recording… ${seconds}s  (let go to stop)" else if (have) "🎤 Hold to record again" else "🎤 HOLD TO RECORD",
                color = Color.White, fontSize = 20.sp, fontWeight = FontWeight.Bold,
            )
        }
        problem?.let { Text(it, color = RecordRed) }
        if (have && !recording) {
            Text("Voice note recorded ✓", color = Green, fontWeight = FontWeight.Bold)
            OutlinedButton(onClick = { file.delete(); have = false; onDone(null) }, modifier = Modifier.fillMaxWidth()) { Text("Delete voice note") }
        }
    }
}

@SuppressLint("MissingPermission")
private fun startVoice(context: Context, file: File): MediaRecorder? = runCatching {
    file.parentFile?.mkdirs()
    file.delete()
    val r = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) MediaRecorder(context) else @Suppress("DEPRECATION") MediaRecorder()
    r.setAudioSource(MediaRecorder.AudioSource.MIC)
    r.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
    r.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
    r.setAudioSamplingRate(44_100)
    r.setAudioEncodingBitRate(64_000)
    r.setMaxDuration(VOICE_NOTE_MAX_SECONDS * 1000)
    r.setOutputFile(file.absolutePath)
    r.prepare()
    r.start()
    r
}.getOrNull()

/**
 * A short video with the back camera: up to 30 seconds, then it stops by itself. Low
 * resolution keeps the upload small on a weak signal. Sound is recorded if the microphone
 * is allowed. Calls [onDone] with the file, or null when deleted.
 */
@SuppressLint("MissingPermission")
@Composable
fun VideoTaker(file: File, onDone: (File?) -> Unit) {
    val context = LocalContext.current
    val owner = LocalLifecycleOwner.current
    var cameraAllowed by remember { mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { r ->
        cameraAllowed = r[Manifest.permission.CAMERA] ?: cameraAllowed
    }
    LaunchedEffect(Unit) {
        val needed = listOf(Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO)
            .filter { ContextCompat.checkSelfPermission(context, it) != PackageManager.PERMISSION_GRANTED }
        if (needed.isNotEmpty()) ask.launch(needed.toTypedArray())
    }
    var have by remember { mutableStateOf(file.exists() && file.length() > 0) }
    var active by remember { mutableStateOf<Recording?>(null) }
    var seconds by remember { mutableIntStateOf(0) }
    var problem by remember { mutableStateOf<String?>(null) }
    val capture = remember {
        VideoCapture.withOutput(
            Recorder.Builder()
                .setQualitySelector(QualitySelector.from(Quality.SD, FallbackStrategy.lowerQualityOrHigherThan(Quality.SD)))
                .build(),
        )
    }
    DisposableEffect(Unit) { onDispose { active?.stop() } }
    LaunchedEffect(active) {
        seconds = 0
        while (active != null) {
            delay(1000)
            seconds++
        }
    }

    if (!cameraAllowed) {
        Button(onClick = { ask.launch(arrayOf(Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO)) }) { Text("Allow the camera") }
        return
    }
    Column {
        if (!have || active != null) {
            AndroidView(factory = { ctx ->
                val view = PreviewView(ctx)
                val future = ProcessCameraProvider.getInstance(ctx)
                future.addListener({
                    val provider = future.get()
                    val preview = Preview.Builder().build().also { it.setSurfaceProvider(view.surfaceProvider) }
                    provider.unbindAll()
                    provider.bindToLifecycle(owner, CameraSelector.DEFAULT_BACK_CAMERA, preview, capture)
                }, ContextCompat.getMainExecutor(ctx))
                view
            }, modifier = Modifier.fillMaxWidth().height(300.dp))
        }
        problem?.let { Text(it, color = RecordRed) }
        when {
            active != null -> Button(
                onClick = { active?.stop() },
                modifier = Modifier.fillMaxWidth().height(64.dp),
                colors = ButtonDefaults.buttonColors(containerColor = RecordRed),
            ) { Text("■ STOP  (${seconds}s of $BOLO_VIDEO_SECONDS)", fontSize = 20.sp, fontWeight = FontWeight.Bold) }
            have -> {
                Text("Video recorded ✓", color = Green, fontWeight = FontWeight.Bold)
                OutlinedButton(onClick = { file.delete(); have = false; onDone(null) }, modifier = Modifier.fillMaxWidth()) { Text("Delete and film again") }
            }
            else -> Button(
                onClick = {
                    file.parentFile?.mkdirs()
                    file.delete()
                    problem = null
                    val options = FileOutputOptions.Builder(file).setDurationLimitMillis(BOLO_VIDEO_SECONDS * 1000L).build()
                    var pending = capture.output.prepareRecording(context, options)
                    if (hasMic(context)) pending = pending.withAudioEnabled()
                    active = pending.start(ContextCompat.getMainExecutor(context)) { event ->
                        if (event is VideoRecordEvent.Finalize) {
                            active = null
                            val ok = event.error == VideoRecordEvent.Finalize.ERROR_NONE ||
                                event.error == VideoRecordEvent.Finalize.ERROR_DURATION_LIMIT_REACHED
                            if (ok && file.exists() && file.length() > 0) {
                                have = true
                                onDone(file)
                            } else {
                                file.delete()
                                problem = "The video could not be saved. Try again."
                            }
                        }
                    }
                },
                modifier = Modifier.fillMaxWidth().height(64.dp),
                colors = ButtonDefaults.buttonColors(containerColor = RecordRed),
            ) { Text("● RECORD (up to $BOLO_VIDEO_SECONDS s)", fontSize = 20.sp, fontWeight = FontWeight.Bold) }
        }
    }
}
