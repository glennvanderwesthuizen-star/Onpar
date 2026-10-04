package za.onpar.core

/**
 * The liveness check before the Duty On / Duty From selfie (D-36): the guard blinks for the
 * camera, which a printed photo or a still picture on another phone cannot do. The camera's face
 * finder feeds each frame in; this decides. It never blocks the guard: if it cannot pass (too
 * dark, a faulty camera), he can still take the selfie, marked "not passed", for a person to look at.
 */
class BlinkCheck {
    enum class Step { FIND_FACE, ONE_FACE_ONLY, BLINK, PASSED }

    var step: Step = Step.FIND_FACE
        private set
    private var sawOpen = false
    private var sawClosed = false

    /**
     * One camera frame: how many faces, and for the face, how likely each eye is open (0 to 1,
     * null when the face finder cannot tell).
     */
    fun frame(faces: Int, leftOpen: Float?, rightOpen: Float?): Step {
        if (step == Step.PASSED) return step
        if (faces == 0) {
            step = Step.FIND_FACE
            return step
        }
        if (faces > 1) {
            // Someone else in the picture could blink for him.
            step = Step.ONE_FACE_ONLY
            sawOpen = false
            sawClosed = false
            return step
        }
        step = Step.BLINK
        if (leftOpen == null || rightOpen == null) return step
        val open = leftOpen > OPEN && rightOpen > OPEN
        val closed = leftOpen < CLOSED && rightOpen < CLOSED
        when {
            open && sawOpen && sawClosed -> step = Step.PASSED
            open -> sawOpen = true
            closed && sawOpen -> sawClosed = true
        }
        return step
    }

    val message: String
        get() = when (step) {
            Step.FIND_FACE -> "Look straight at the camera."
            Step.ONE_FACE_ONLY -> "Only you in the picture, please."
            Step.BLINK -> "Now blink slowly."
            Step.PASSED -> "Thank you. Take your selfie."
        }

    companion object {
        const val OPEN = 0.7f
        const val CLOSED = 0.25f
        /** After this long without passing, the guard may take the selfie anyway (marked not passed). */
        const val ALLOW_SKIP_AFTER_SECONDS = 20
    }
}
