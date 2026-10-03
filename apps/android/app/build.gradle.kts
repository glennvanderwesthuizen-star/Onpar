plugins {
    id("com.android.application")
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
}

android {
    namespace = "za.onpar.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "za.onpar.app"
        // Android 10 or newer (brief: managed Android device; kiosk and security updates need it).
        minSdk = 29
        targetSdk = 35
        // The GitHub build number, so each build is newer than the last and shows which one is installed.
        val build = System.getenv("GITHUB_RUN_NUMBER")?.toIntOrNull() ?: 1
        versionCode = build
        versionName = "0.1.$build"
    }

    // Test builds are all signed with the same key, so a new test app installs over the old one
    // (with a different key Android refuses the update). This key is for testing only; the
    // pilot and live app will be signed with a private key kept outside the code.
    signingConfigs {
        getByName("debug") {
            storeFile = file("onpar-test.keystore")
            storePassword = "onpar-test"
            keyAlias = "onpar-test"
            keyPassword = "onpar-test"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { compose = true }
    packaging { resources { excludes += "/META-INF/{AL2.0,LGPL2.1}" } }
}

dependencies {
    implementation(project(":core"))
    implementation(libs.coroutines.android)
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.material3)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.camerax.camera2)
    implementation(libs.camerax.lifecycle)
    implementation(libs.camerax.view)
    implementation(libs.camerax.video)
    implementation(libs.zxing.core)
}
