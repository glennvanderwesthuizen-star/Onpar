package za.onpar.core

/**
 * The declaration wording shown on the phone (brief section 6.2). The server keeps
 * the same text by version and records it with each declaration; a test checks the
 * two match. Used when the phone has no signal to ask the server.
 */
object DeclarationText {
    val DUTY_ON = DeclarationWording(
        1,
        listOf(
            "I am fit and free of injury and ready to commence and complete my shift",
            "I have read the OB and understand the tasks for the day",
            "I have taken receipt of all equipment handed over from the previous shift, all in good order",
        ),
    )
    val DUTY_FROM = DeclarationWording(
        1,
        listOf(
            "I am fit and free of injury and departing from duty, I have handed over all assigned equipment and handed over any information required by the incoming shift",
        ),
    )

    fun forKind(kind: String): DeclarationWording = if (kind == "duty_from") DUTY_FROM else DUTY_ON
}
