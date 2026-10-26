import java.util.Properties

plugins {
    id("com.android.application")
}

val signingPropertiesPath = providers.gradleProperty("signingProperties").orNull
    ?: System.getenv("ANDROID_REMOTE_LAB_SIGNING_PROPERTIES")
val signingPropertiesFile = signingPropertiesPath?.let(::file)
val signingProperties = Properties().apply {
    if (signingPropertiesFile?.isFile == true) {
        signingPropertiesFile.inputStream().use { load(it) }
    }
}
val defaultRelayHost = providers.gradleProperty("relayHost").orNull ?: ""

android {
    namespace = "com.codex.remotecompanion"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.codex.remotecompanion"
        minSdk = 30
        targetSdk = 35
        testInstrumentationRunner = "com.codex.remotecompanion.WakeProbeInstrumentation"
        versionCode = 29
        versionName = "1.2.13"
        buildConfigField("String", "DEFAULT_RELAY_HOST", "\"${defaultRelayHost.replace("\"", "\\\"")}\"")
    }

    buildFeatures {
        buildConfig = true
    }

    signingConfigs {
        if (signingPropertiesFile?.isFile == true) {
            create("companionRelease") {
                storeFile = file(signingProperties.getProperty("storeFile"))
                storePassword = signingProperties.getProperty("storePassword")
                keyAlias = signingProperties.getProperty("keyAlias")
                keyPassword = signingProperties.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            if (signingPropertiesFile?.isFile == true) {
                signingConfig = signingConfigs.getByName("companionRelease")
            }
            isMinifyEnabled = true
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
}
