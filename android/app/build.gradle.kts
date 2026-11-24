import groovy.json.JsonSlurper

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val rootPkgFile = file("../../package.json")
@Suppress("UNCHECKED_CAST")
val pwaVersion: String = if (rootPkgFile.exists()) {
    val pkg = JsonSlurper().parse(rootPkgFile) as Map<String, Any?>
    (pkg["version"] as? String)?.trim()?.takeIf { it.isNotEmpty() } ?: "1.0.0"
} else {
    "1.0.0"
}

val semverParts = pwaVersion.split(".").map { it.takeWhile(Char::isDigit).toIntOrNull() ?: 0 }
val computedVersionCode = (semverParts.getOrElse(0) { 0 } * 10000) +
    (semverParts.getOrElse(1) { 0 } * 100) +
    semverParts.getOrElse(2) { 0 }

android {
    namespace = "app.gameguidego.android"
    compileSdk = 35

    defaultConfig {
        applicationId = "app.gameguidego.android"
        minSdk = 26
        targetSdk = 35
        versionCode = computedVersionCode.coerceAtLeast(1)
        versionName = pwaVersion

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        viewBinding = true
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.constraintlayout:constraintlayout:2.2.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("androidx.browser:browser:1.8.0")

    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jsoup:jsoup:1.18.3")

    testImplementation("junit:junit:4.13.2")
}
