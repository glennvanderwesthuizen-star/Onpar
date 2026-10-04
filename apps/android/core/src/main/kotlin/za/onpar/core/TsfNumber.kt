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

    private val BADGE = Regex("^https?://[^/\\s]+/b/([A-Za-z0-9_-]{24})/?$")

    /**
     * ID badge v2: the QR code is a link with a random card code (no personal information).
     * True for a badge link from any address, or an older ONPAR-ID card. The server reads it.
     */
    fun isIdCard(text: String): Boolean = BADGE.matches(text.trim()) || fromIdCard(text) != null

    /** The three parts for showing it as a plate: letters, digits, province. */
    fun parts(n: String): Triple<String, String, String>? =
        PATTERN.matchEntire(n)?.groupValues?.let { Triple(it[1], it[2], it[3]) }

    fun format(n: String): String = parts(n)?.let { "${it.first} ${it.second} ${it.third}" } ?: n
}
