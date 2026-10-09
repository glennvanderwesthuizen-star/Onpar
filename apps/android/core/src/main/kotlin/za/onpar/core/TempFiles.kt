package za.onpar.core

import java.io.File

/**
 * Photos, voice notes and videos taken for a task, report or BOLO wait in the app's temporary
 * folder until they are copied into the outbox. Any left behind (a screen closed half-way) are
 * removed after a day (optimisation review, phase 1).
 */
object TempFiles {
    private val MEDIA = Regex(""".*\.(jpg|jpeg|png|webp|m4a|mp4|3gp)$""", RegexOption.IGNORE_CASE)
    const val MAX_AGE_MS = 24L * 60 * 60 * 1000

    fun purge(dir: File, nowMs: Long = System.currentTimeMillis(), maxAgeMs: Long = MAX_AGE_MS): Int {
        var removed = 0
        dir.listFiles()?.forEach { f ->
            if (f.isFile && MEDIA.matches(f.name) && nowMs - f.lastModified() > maxAgeMs && f.delete()) removed++
        }
        return removed
    }
}
