package za.onpar.core

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test

class SetupTest {
    private val token = "abcdefghijklmnopqrstuvwxyz0123456789"

    @Test
    fun `reads the setup code from the Devices page`() {
        val s = DeviceSetup.fromQr("onpar://setup?server=https%3A%2F%2Fonpar.tsf.co.za%2F&token=$token")
        assertEquals(DeviceSetup("https://onpar.tsf.co.za", token), s)
    }

    @Test
    fun `ignores patrol codes, other QR codes and unsafe servers`() {
        assertNull(DeviceSetup.fromQr("QR-8f2c-1"))
        assertNull(DeviceSetup.fromQr("https://example.com"))
        assertNull(DeviceSetup.fromQr("onpar://setup?server=http%3A%2F%2Fevil.example&token=$token"))
        assertNull(DeviceSetup.fromQr("onpar://setup?server=https%3A%2F%2Fonpar.tsf.co.za&token=short"))
    }

    @Test
    fun `allows plain http only for a local test server`() {
        assertEquals("http://10.0.2.2:3000", DeviceSetup.fromQr("onpar://setup?server=http%3A%2F%2F10.0.2.2%3A3000&token=$token")?.serverUrl)
    }

    @Test
    fun `reads the code exactly as the website makes it`() {
        val s = DeviceSetup.fromQr("onpar://setup?server=http%3A%2F%2Flocalhost%3A3000&token=Xfy0Du-bzFoWOG2jL-gc74LJBclhJCSIvvv4EsS99l4")
        assertEquals(DeviceSetup("http://localhost:3000", "Xfy0Du-bzFoWOG2jL-gc74LJBclhJCSIvvv4EsS99l4"), s)
    }
}
