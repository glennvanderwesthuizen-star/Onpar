package za.onpar.core

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.File
import java.io.IOException
import java.time.Instant
import java.util.concurrent.TimeUnit

/** A file sent with a request, for example a selfie or a patrol photo. */
data class Upload(val field: String, val file: File, val contentType: String)

/**
 * Talks to the On Par server as this device. Every request carries the device key;
 * guard requests also carry the guard's sign-in token.
 */
class ApiClient(
    private val setup: DeviceSetup,
    private val clock: TrustedClock,
    private val http: OkHttpClient = defaultHttp(),
) {
    fun get(path: String, guardToken: String? = null): JsonElement = send(request(path, guardToken).get().build())

    fun post(path: String, body: JsonElement, guardToken: String? = null): JsonElement =
        send(request(path, guardToken).post(body.toString().toRequestBody(JSON)).build())

    /** A file from the server, for example a photo. */
    fun getBytes(path: String, guardToken: String? = null): ByteArray {
        val res = try {
            http.newCall(request(path, guardToken).get().build()).execute()
        } catch (e: IOException) {
            throw OfflineException(e)
        }
        res.use {
            if (!it.isSuccessful) {
                val text = it.body?.string().orEmpty()
                throw toError(it.code, runCatching { OnParJson.parseToJsonElement(text) }.getOrElse { JsonPrimitive(text) })
            }
            return it.body?.bytes() ?: ByteArray(0)
        }
    }

    /** Multipart: the fields as JSON in `data`, plus files. */
    fun postMultipart(path: String, data: JsonElement, files: List<Upload>, guardToken: String? = null): JsonElement {
        val body = MultipartBody.Builder().setType(MultipartBody.FORM).addFormDataPart("data", data.toString())
        for (f in files) body.addFormDataPart(f.field, f.file.name, f.file.asRequestBody(f.contentType.toMediaType()))
        return send(request(path, guardToken).post(body.build()).build())
    }

    private fun request(path: String, guardToken: String?): Request.Builder {
        val b = Request.Builder().url("${setup.serverUrl}/api$path").header("X-Device-Token", setup.deviceToken)
        if (guardToken != null) b.header("Authorization", "Bearer $guardToken")
        return b
    }

    private fun send(req: Request): JsonElement {
        val res = try {
            http.newCall(req).execute()
        } catch (e: IOException) {
            throw OfflineException(e)
        }
        res.use {
            val text = it.body?.string().orEmpty()
            val json = if (text.isBlank()) JsonObject(emptyMap()) else runCatching { OnParJson.parseToJsonElement(text) }.getOrElse { JsonPrimitive(text) }
            if (!it.isSuccessful) throw toError(it.code, json)
            (json as? JsonObject)?.get("serverTime")?.jsonPrimitive?.contentOrNull?.let { t -> runCatching { clock.sync(Instant.parse(t)) } }
            return json
        }
    }

    private fun toError(status: Int, json: JsonElement): ApiException {
        val obj = json as? JsonObject
        val message = when (val m = obj?.get("message")) {
            is JsonPrimitive -> m.contentOrNull
            null -> null
            else -> m.toString()
        } ?: if (status >= 500) "The server had a problem. It will try again." else "Something went wrong ($status)."
        val errors = (obj?.get("errors") as? JsonObject)?.mapValues { (_, v) -> (v as? JsonPrimitive)?.contentOrNull ?: v.toString() } ?: emptyMap()
        return ApiException(status, message, errors)
    }

    companion object {
        private val JSON = "application/json".toMediaType()
        fun defaultHttp(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(60, TimeUnit.SECONDS)
            .build()
    }
}

/** Small helpers for reading JSON replies. */
fun JsonElement.obj(): JsonObject = jsonObject
fun JsonElement.str(key: String): String? = (jsonObject[key] as? JsonPrimitive)?.contentOrNull
