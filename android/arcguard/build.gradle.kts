plugins {
    id("com.android.application")
}

android {
    namespace = "lab.arcguard"
    compileSdk = 36

    defaultConfig {
        applicationId = "lab.arcguard"
        minSdk = 30
        targetSdk = 35
        versionCode = 9
        versionName = "2.3"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    testImplementation("junit:junit:4.13.2")
}
