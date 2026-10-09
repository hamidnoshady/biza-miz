import groovy.json.JsonSlurper
import java.net.URI
import org.gradle.api.GradleException

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
}

// ---------------------------------------------------------------------------------------------
// Shared, non-secret configuration. The web app and the JVM tests read the same two files, so
// the bridge version, the allowlists and the applicationIds cannot drift between sides.
// ---------------------------------------------------------------------------------------------
val bridgeContractFile = file("../../config/native-bridge-contract.json")
val environmentsFile = file("../../config/android-environments.json")

@Suppress("UNCHECKED_CAST")
fun readJsonObject(source: File): Map<String, Any?> = JsonSlurper().parse(source) as Map<String, Any?>

val bridgeContract = readJsonObject(bridgeContractFile)
val environmentTable = readJsonObject(environmentsFile)

@Suppress("UNCHECKED_CAST")
val environments = environmentTable["environments"] as Map<String, Map<String, Any?>>
val bridgeVersion = (bridgeContract["bridgeVersion"] as Number).toInt()

// The web origin the TWA opens. It is never guessed for staging or production: it must come from
// the environment, a Gradle property, or (for development only) the committed config.
val originPattern = Regex("^https://[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$")

fun webOriginFor(flavorName: String): String {
    val candidates = listOf(
        System.getenv("BIZA_ANDROID_WEB_ORIGIN_${flavorName.uppercase()}"),
        findProperty("biza.webOrigin.$flavorName") as String?,
        environments.getValue(flavorName)["webOrigin"] as String?,
    )
    return candidates.firstOrNull { !it.isNullOrBlank() }?.trim().orEmpty()
}

// Used as the App Link host. An unset origin gets a placeholder that can never resolve, so the
// manifest still merges; the release check below stops such a build from being produced.
fun hostFor(origin: String): String = if (origin.isEmpty()) "unset.invalid" else URI(origin).host

// Signing material is read from the environment only. It is never committed.
val keystorePath: String? = System.getenv("BIZA_ANDROID_KEYSTORE_PATH")?.takeIf { it.isNotBlank() }
val releaseTaskPattern = Regex("^(assemble|bundle)(Staging|Production)Release$")

android {
    namespace = "com.bizamiz.android"
    compileSdk = 36

    defaultConfig {
        minSdk = 24
        targetSdk = 36
        versionCode = (findProperty("bizaVersionCode") as String?)?.toIntOrNull() ?: 1
        versionName = (findProperty("bizaVersionName") as String?) ?: "0.1.0"
    }

    flavorDimensions += "environment"
    productFlavors {
        listOf("development", "staging", "production").forEach { flavorName ->
            create(flavorName) {
                dimension = "environment"
                val spec = environments.getValue(flavorName)
                val origin = webOriginFor(flavorName)
                applicationId = spec["applicationId"] as String
                resValue("string", "app_name", spec["label"] as String)
                buildConfigField("String", "WEB_ORIGIN", "\"$origin\"")
                buildConfigField("String", "APP_ENVIRONMENT", "\"$flavorName\"")
                buildConfigField("int", "NATIVE_BRIDGE_VERSION", bridgeVersion.toString())
                manifestPlaceholders["appLinkHost"] = hostFor(origin)
            }
        }
    }

    signingConfigs {
        if (keystorePath != null) {
            create("release") {
                storeFile = file(keystorePath)
                storePassword = System.getenv("BIZA_ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("BIZA_ANDROID_KEY_ALIAS")
                keyPassword = System.getenv("BIZA_ANDROID_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (keystorePath != null) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    lint {
        abortOnError = true
    }
}

dependencies {
    implementation(libs.androidx.browser)

    testImplementation(libs.junit)
    // Unit tests run on the JVM, where android.jar's org.json is only a stub. The real parser is
    // needed for the protocol tests. It is not packaged into the app.
    testImplementation(libs.org.json)
}

// Release tasks must not run with a guessed origin or without signing. The check runs once the
// task graph is known, so it fails before any compilation starts.
gradle.taskGraph.whenReady { graph ->
    val flavorsBeingReleased = graph.allTasks
        .mapNotNull { task -> releaseTaskPattern.find(task.name)?.groupValues?.get(2)?.lowercase() }
        .distinct()

    for (flavorName in flavorsBeingReleased) {
        val problems = mutableListOf<String>()
        val origin = webOriginFor(flavorName)
        if (!originPattern.matches(origin)) {
            problems += "The web origin for '$flavorName' is missing or is not a bare https origin. " +
                "Set BIZA_ANDROID_WEB_ORIGIN_${flavorName.uppercase()} or -Pbiza.webOrigin.$flavorName=https://<host>."
        }
        if (keystorePath == null) {
            problems += "Release signing is not configured. Set BIZA_ANDROID_KEYSTORE_PATH, " +
                "BIZA_ANDROID_KEYSTORE_PASSWORD, BIZA_ANDROID_KEY_ALIAS and BIZA_ANDROID_KEY_PASSWORD."
        } else if (!file(keystorePath).isFile) {
            problems += "BIZA_ANDROID_KEYSTORE_PATH does not point to a readable file."
        }
        if (problems.isNotEmpty()) {
            throw GradleException("Cannot build $flavorName release:\n - " + problems.joinToString("\n - "))
        }
    }
}
