plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.serialization)
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}
kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }

dependencies {
    api(libs.coroutines.core)
    api(libs.serialization.json)
    api(libs.okhttp)
    // Reads the barcodes on licence discs and ID cards (Apache 2.0, runs on the phone, no Google services).
    api(libs.zxing.core)
    testImplementation(libs.junit.jupiter)
    testImplementation(libs.coroutines.test)
    testImplementation(libs.okhttp.mockwebserver)
    testRuntimeOnly(libs.junit.launcher)
}

tasks.test {
    useJUnitPlatform()
    // Tests against a running On Par server run only when ONPAR_API_URL is set (see LiveServerTest).
    environment("ONPAR_API_URL", System.getenv("ONPAR_API_URL") ?: "")
    testLogging { events("passed", "failed", "skipped"); showStandardStreams = false }
}
