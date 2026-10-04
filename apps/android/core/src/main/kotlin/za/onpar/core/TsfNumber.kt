package za.onpar.core

/**
 * The guard's TSF number, styled on SA number plates ("BCD 123 GP"). Same rules as the website
 * (packages/rules/src/tsf-number.ts). The guard's ID card holds it in a QR code; the PIN is
 * still typed every time.
 */
object TsfNumber {
    const val ID_QR_PREFIX = "ONPAR-ID:"
    private const val LETTERS = "BCDFGHJKLMNPRSTVWXYZ"
    private val PATTERN = Regex("^([$LETTERS]{3})(\\d{3})(GP|WC|KZN|EC|FS|LP|MP|NW|NC)$")

    /** "bcd 123-gp" → "BCD123GP", or null if it is not a TSF number. */
    fun normalise(input: String): String? {
        val s = input.uppercase().replace(Regex("[\\s-]"), "")
        val m = PATTERN.matchEntire(s) ?: return null
        return if (m.groupValues[2] == "000") null else s
    }

    /** The TSF number from a scanned ID card, or null for any other QR code (a checkpoint, a setup code). */
    fun fromIdCard(text: String): String? {
        val t = text.trim()
        if (!t.uppercase().startsWith(ID_QR_PREFIX)) return null
        return normalise(t.substring(ID_QR_PREFIX.length))
    }

    /** The three parts for showing it as a plate: letters, digits, province. */
    fun parts(n: String): Triple<String, String, String>? =
        PATTERN.matchEntire(n)?.groupValues?.let { Triple(it[1], it[2], it[3]) }

    fun format(n: String): String = parts(n)?.let { "${it.first} ${it.second} ${it.third}" } ?: n
}
