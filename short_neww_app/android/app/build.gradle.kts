plugins {
    id("com.android.application")
    id("kotlin-android")
    id("com.google.gms.google-services")
    id("com.onesignal.androidsdk.onesignal-gradle-plugin")
    id("dev.flutter.flutter-gradle-plugin")
}

android {
    namespace = "com.example.short_neww_app"
    compileSdk = 36

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
        isCoreLibraryDesugaringEnabled = true
    }

    kotlinOptions {
        jvmTarget = JavaVersion.VERSION_11.toString()
    }

    defaultConfig {
        applicationId = "com.example.short_neww_app"
        minSdk = flutter.minSdkVersion
        targetSdk = 34
        versionCode = flutter.versionCode
        versionName = flutter.versionName
        multiDexEnabled = true
    }

    buildTypes {
        release {
            signingConfig = signingConfigs.getByName("debug")
            isMinifyEnabled = false
            isShrinkResources = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
        debug {
            isMinifyEnabled = false
            isShrinkResources = false
        }
    }

    packaging {
        resources {
            excludes.add("/META-INF/{AL2.0,LGPL2.1}")
        }
    }
}

flutter {
    source = "../.."
}

dependencies {
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.0.4")
    
    // Multidex support
    implementation("androidx.multidex:multidex:2.0.1")

    // Firebase BOM for consistent versions
    implementation(platform("com.google.firebase:firebase-bom:32.7.0"))
    implementation("com.google.firebase:firebase-analytics")

    // Google Mobile Ads - use latest compatible version
    implementation("com.google.android.gms:play-services-ads:23.0.0")
}

// Force resolution of conflicting dependencies
configurations.all {
    resolutionStrategy {
        // Use compatible versions - ensure all Google Play Services use compatible versions
        // Updated to use newer compatible versions
        force("com.google.android.gms:play-services-basement:18.3.0")
        force("com.google.android.gms:play-services-ads:23.0.0")
        force("com.google.android.gms:play-services-ads-lite:23.0.0")
        force("com.google.android.gms:play-services-ads-base:23.0.0")
        force("com.google.android.gms:play-services-measurement:21.5.0")
        force("com.google.android.gms:play-services-measurement-api:21.5.0")
        force("com.google.android.gms:play-services-measurement-base:21.5.0")
        force("com.google.android.gms:play-services-measurement-impl:21.5.0")
        force("com.google.android.gms:play-services-tasks:18.0.2")
    }

    exclude(group = "com.google.android.gms", module = "play-services-measurement-sdk")
}