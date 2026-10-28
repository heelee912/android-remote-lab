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

android {
    namespace = "com.codex.nightscreenguard"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.codex.nightscreenguard"
        minSdk = 30
        targetSdk = 35
        versionCode = 1
        versionName = "1.0.0"
    }

    signingConfigs {
        if (signingPropertiesFile?.isFile == true) {
            create("guardRelease") {
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
                signingConfig = signingConfigs.getByName("guardRelease")
            }
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"))
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    testImplementation("junit:junit:4.13.2")
}
