package za.onpar.app.ui

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import java.io.File

/**
 * The camera saves the picture as the sensor sees it, with a note saying how to turn it.
 * Not every screen reads that note, so photos showed on their side. This turns the
 * picture itself upright and saves it again without the note, so it is upright
 * everywhere: on the phone, on the website and in downloads.
 */
fun makeUpright(file: File) {
    val exif = runCatching { ExifInterface(file.absolutePath) }.getOrNull() ?: return
    val orientation = exif.getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
    val m = Matrix()
    when (orientation) {
        ExifInterface.ORIENTATION_ROTATE_90 -> m.postRotate(90f)
        ExifInterface.ORIENTATION_ROTATE_180 -> m.postRotate(180f)
        ExifInterface.ORIENTATION_ROTATE_270 -> m.postRotate(270f)
        ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> m.postScale(-1f, 1f)
        ExifInterface.ORIENTATION_FLIP_VERTICAL -> m.postScale(1f, -1f)
        ExifInterface.ORIENTATION_TRANSPOSE -> { m.postRotate(90f); m.postScale(-1f, 1f) }
        ExifInterface.ORIENTATION_TRANSVERSE -> { m.postRotate(270f); m.postScale(-1f, 1f) }
        else -> return
    }
    val original = BitmapFactory.decodeFile(file.absolutePath) ?: return
    val upright = Bitmap.createBitmap(original, 0, 0, original.width, original.height, m, true)
    val tmp = File(file.parentFile, file.name + ".tmp")
    tmp.outputStream().use { upright.compress(Bitmap.CompressFormat.JPEG, 88, it) }
    if (upright !== original) upright.recycle()
    original.recycle()
    tmp.renameTo(file)
}
