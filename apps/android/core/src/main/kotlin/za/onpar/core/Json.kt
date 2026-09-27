package za.onpar.core

import kotlinx.serialization.json.Json

/** The JSON settings used everywhere: tolerant of new fields the server adds later. */
val OnParJson = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    encodeDefaults = true
}
