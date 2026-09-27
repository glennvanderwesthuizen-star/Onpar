// The Android build plugin is only loaded where the Android SDK exists (see settings.gradle.kts),
// because it is downloaded from Google's servers, which not every build machine can reach.
buildscript {
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        if (rootProject.findProject(":app") != null) classpath(libs.android.gradle.plugin)
    }
}

plugins {
    alias(libs.plugins.kotlin.jvm) apply false
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.kotlin.serialization) apply false
    alias(libs.plugins.kotlin.compose) apply false
}
