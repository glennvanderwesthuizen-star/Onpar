package za.onpar.core

import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import java.io.File

/** Small saved settings (setup, the signed-in guard). A file in the app's private storage. */
class Store(private val file: File) {
    private var values: MutableMap<String, String> =
        if (file.exists()) OnParJson.decodeFromString(MapSerializer(String.serializer(), String.serializer()), file.readText()).toMutableMap()
        else mutableMapOf()

    @Synchronized
    operator fun get(key: String): String? = values[key]

    @Synchronized
    operator fun set(key: String, value: String?) {
        if (value == null) values.remove(key) else values[key] = value
        file.parentFile?.mkdirs()
        val tmp = File(file.parentFile, file.name + ".tmp")
        tmp.writeText(OnParJson.encodeToString(MapSerializer(String.serializer(), String.serializer()), values))
        tmp.renameTo(file)
    }
}
