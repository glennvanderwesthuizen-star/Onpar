package za.onpar.core

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

/** The blink check before the selfie (D-36). */
class BlinkCheckTest {
    @Test
    fun `a real blink passes - eyes open, closed, open again`() {
        val c = BlinkCheck()
        assertEquals(BlinkCheck.Step.FIND_FACE, c.frame(0, null, null))
        assertEquals(BlinkCheck.Step.BLINK, c.frame(1, 0.95f, 0.9f))
        assertEquals(BlinkCheck.Step.BLINK, c.frame(1, 0.1f, 0.05f))
        assertEquals(BlinkCheck.Step.PASSED, c.frame(1, 0.92f, 0.9f))
        // Once passed it stays passed.
        assertEquals(BlinkCheck.Step.PASSED, c.frame(0, null, null))
    }

    @Test
    fun `a still photo never passes`() {
        val c = BlinkCheck()
        repeat(200) { c.frame(1, 0.9f, 0.88f) }
        assertEquals(BlinkCheck.Step.BLINK, c.step)
    }

    @Test
    fun `closed eyes alone, or one eye (a wink), do not pass`() {
        val c = BlinkCheck()
        c.frame(1, 0.1f, 0.1f)
        c.frame(1, 0.9f, 0.9f)
        assertEquals(BlinkCheck.Step.BLINK, c.step) // closed first, then open: not a blink yet
        c.frame(1, 0.1f, 0.9f) // a wink
        c.frame(1, 0.9f, 0.9f)
        assertEquals(BlinkCheck.Step.BLINK, c.step)
    }

    @Test
    fun `a second face in the picture starts the check again`() {
        val c = BlinkCheck()
        c.frame(1, 0.9f, 0.9f)
        c.frame(1, 0.1f, 0.1f)
        assertEquals(BlinkCheck.Step.ONE_FACE_ONLY, c.frame(2, 0.9f, 0.9f))
        assertEquals(BlinkCheck.Step.BLINK, c.frame(1, 0.9f, 0.9f))
        assertEquals("Now blink slowly.", c.message)
    }
}
