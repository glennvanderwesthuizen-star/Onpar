package za.onpar.core

/** The server refused a request (4xx) or failed (5xx). The message is written for the guard to read. */
class ApiException(val status: Int, override val message: String, val errors: Map<String, String> = emptyMap()) : Exception(message) {
    /** Worth trying again later: server trouble, timeouts or too many requests. A refusal (other 4xx) will not change. */
    val retryable: Boolean get() = status >= 500 || status == 408 || status == 429
    val unauthorised: Boolean get() = status == 401
}

/** No connection to the server. Actions wait in the outbox. */
class OfflineException(cause: Throwable) : Exception("No signal. Saved on the phone; it will send when the phone is back online.", cause)
