package za.onpar.core

import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.common.GlobalHistogramBinarizer
import com.google.zxing.common.HybridBinarizer

/** What a barcode scanned at the gate turned out to be. Only the fields the spec lists are read. */
sealed interface Scanned {
    /** A vehicle licence disc. */
    data class Disc(val registration: String, val make: String, val model: String, val colour: String, val vin: String, val expiry: String?) : Scanned

    /** An ID card (names and number) or an ID book (number only: the guard types the name). */
    data class Identity(val idNumber: String, val surname: String, val names: String, val document: String) : Scanned

    /** A driver's licence card. Its barcode is locked, so the guard photographs it and types the details. */
    data object DriversLicence : Scanned

    /** A barcode On Par does not know. */
    data object Unknown : Scanned
}

/** South African ID numbers: 13 digits with a check digit. */
object SaId {
    fun valid(id: String): Boolean {
        if (id.length != 13 || !id.all { it.isDigit() }) return false
        var sum = 0
        for (i in 0 until 13) {
            var d = id[i] - '0'
            // Every second digit from the right is doubled (the Luhn check).
            if ((13 - i) % 2 == 0) {
                d *= 2
                if (d > 9) d -= 9
            }
            sum += d
        }
        return sum % 10 == 0
    }
}

/** Reads what the barcodes on South African licence discs and ID documents say. */
object VisitorScan {
    private val DATE = Regex("""\d{4}-\d{2}-\d{2}""")

    fun read(text: String): Scanned = disc(text) ?: identity(text) ?: if (text.length > 200) Scanned.DriversLicence else Scanned.Unknown

    /**
     * A licence disc: fields separated by "%", starting "%MVL…". Counted from the expiry date at
     * the end: number plate, register number, description, make, model, colour, VIN, engine
     * number, expiry. Descriptions and colours come in two languages ("White / Wit").
     */
    fun disc(text: String): Scanned.Disc? {
        val t = text.trim()
        if (!t.startsWith("%MVL")) return null
        val f = t.split('%').map { it.trim() }
        val e = f.indexOfLast { DATE.matches(it) }
        val english = { s: String -> s.substringBefore('/').trim() }
        val disc = when {
            e >= 9 -> Scanned.Disc(plate(f[e - 8]), english(f[e - 5]), english(f[e - 4]), english(f[e - 3]), f[e - 2].uppercase(), f[e])
            f.size >= 13 -> Scanned.Disc(plate(f[6]), english(f[9]), english(f[10]), english(f[11]), f[12].uppercase(), null)
            else -> return null
        }
        return disc.takeIf { it.registration.length >= 2 }
    }

    /**
     * An ID card: fields separated by "|", surname first, names second, the ID number further on.
     * An ID book: just the 13-digit number.
     */
    fun identity(text: String): Scanned.Identity? {
        val t = text.trim()
        if ('|' in t) {
            val f = t.split('|').map { it.trim() }
            val i = f.indexOfFirst { SaId.valid(it) }
            if (i >= 2) return Scanned.Identity(f[i], f[0], f[1], "id_card")
            if (i >= 0) return Scanned.Identity(f[i], "", "", "id_card")
            return null
        }
        val digits = t.filter { it.isDigit() }
        return if (t.length <= 20 && SaId.valid(digits)) Scanned.Identity(digits, "", "", "id_book") else null
    }

    /** A number plate as it is compared: capitals and digits only. */
    fun plate(text: String): String = text.uppercase().filter { it in 'A'..'Z' || it in '0'..'9' }

    /** An ID or passport number as it is compared: capitals and digits only. */
    fun idNumber(text: String): String = plate(text)
}

/**
 * Finds a barcode in a camera picture. The picture arrives as the camera sees it, which is on
 * its side when the phone is held upright, so it is tried both ways.
 */
class BarcodeReader(formats: List<BarcodeFormat> = DOCUMENT_FORMATS) {
    private val reader = MultiFormatReader().apply {
        setHints(mapOf(DecodeHintType.POSSIBLE_FORMATS to formats, DecodeHintType.TRY_HARDER to true))
    }

    /** `luma`: one brightness byte per pixel, `stride` bytes to a row. Returns the barcode's text, or null. */
    fun read(luma: ByteArray, stride: Int, width: Int, height: Int): String? =
        attempt(luma, stride, width, height) ?: attempt(turn(luma, stride, width, height), height, height, width)

    private fun attempt(data: ByteArray, stride: Int, width: Int, height: Int): String? {
        val source = PlanarYUVLuminanceSource(data, stride, height, 0, 0, width, height, false)
        for (bitmap in listOf(BinaryBitmap(HybridBinarizer(source)), BinaryBitmap(GlobalHistogramBinarizer(source)))) {
            try {
                return reader.decodeWithState(bitmap).text
            } catch (e: Exception) {
                // No barcode found this way: try the next.
            } finally {
                reader.reset()
            }
        }
        return null
    }

    companion object {
        /** Licence discs and ID cards (PDF417), ID books (Code 39 or Code 128). */
        val DOCUMENT_FORMATS = listOf(BarcodeFormat.PDF_417, BarcodeFormat.CODE_39, BarcodeFormat.CODE_128)

        /** The picture turned a quarter turn clockwise: it becomes `height` wide and `width` high. */
        fun turn(data: ByteArray, stride: Int, width: Int, height: Int): ByteArray {
            val out = ByteArray(width * height)
            for (y in 0 until height) {
                val row = y * stride
                for (x in 0 until width) out[x * height + (height - 1 - y)] = data[row + x]
            }
            return out
        }
    }
}
