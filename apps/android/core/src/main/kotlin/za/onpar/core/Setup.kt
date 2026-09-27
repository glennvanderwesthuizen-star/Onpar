package za.onpar.core

import java.net.URI
import java.net.URLDecoder

/** Where this phone talks to, and its device key. Set once, by scanning the QR code on the Devices page. */
data class DeviceSetup(val serverUrl: String, val deviceToken: String) {
    companion object {
        /**
         * Reads the setup QR code: `onpar://setup?server=<https address>&token=<device key>`.
         * Returns null for anything else, so a patrol code or a stranger's QR never configures the phone.
         */
        fun fromQr(text: String): DeviceSetup? {
            val uri = runCatching { URI(text.trim()) }.getOrNull() ?: return null
            if (uri.scheme != "onpar" || uri.host != "setup") return null
            val params = (uri.rawQuery ?: "").split('&').mapNotNull {
                val i = it.indexOf('=')
                if (i <= 0) null else it.substring(0, i) to URLDecoder.decode(it.substring(i + 1), Charsets.UTF_8)
            }.toMap()
            val server = params["server"]?.trimEnd('/') ?: return null
            val token = params["token"]?.takeIf { it.length >= 20 } ?: return null
            if (!validServer(server)) return null
            return DeviceSetup(server, token)
        }

        /** HTTPS only, except a local test server. */
        fun validServer(url: String): Boolean {
            val u = runCatching { URI(url) }.getOrNull() ?: return false
            if (u.host.isNullOrBlank()) return false
            return u.scheme == "https" || (u.scheme == "http" && (u.host == "localhost" || u.host == "10.0.2.2" || u.host == "127.0.0.1"))
        }
    }
}
