package za.onpar.core

import kotlinx.serialization.Serializable
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.PBEKeySpec

/** A guard signed in on this phone. The PIN is kept only as a salted hash, to unlock without signal. */
@Serializable
data class GuardSession(
    val number: String,
    val name: String,
    val token: String,
    val pinSalt: String = "",
    val pinHash: String = "",
    val failedUnlocks: Int = 0,
)

/** Checks a PIN against the salted hash kept on the phone. */
object PinCheck {
    const val MAX_TRIES = 5
    private const val ITERATIONS = 20_000

    fun newSalt(): String = Base64.getEncoder().encodeToString(ByteArray(16).also { SecureRandom().nextBytes(it) })

    fun hash(pin: String, salt: String): String {
        val spec = PBEKeySpec(pin.toCharArray(), Base64.getDecoder().decode(salt), ITERATIONS, 256)
        return Base64.getEncoder().encodeToString(SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).encoded)
    }

    fun matches(pin: String, salt: String, hash: String): Boolean =
        MessageDigest.isEqual(hash(pin, salt).toByteArray(), hash.toByteArray())
}
