pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "onpar-android"

// The phone app's logic: plain Kotlin, so it builds and is tested anywhere, including against a running On Par server.
include(":core")

// The Android screens need the Android SDK. Where it is missing (for example a build machine
// without it), only :core is built; GitHub's build machines have it and build the app.
val sdk = System.getenv("ANDROID_HOME") ?: System.getenv("ANDROID_SDK_ROOT")
    ?: file("local.properties").takeIf { it.exists() }?.readLines()?.firstOrNull { it.startsWith("sdk.dir=") }?.substringAfter("=")
if (sdk != null && file(sdk).exists()) include(":app")
