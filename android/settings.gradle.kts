// Biza Miz Android runtime (issue #884). The Gradle root is android/, which sits beside the
// Next.js app and reads the shared JSON in ../config. It is not a monorepo: the web app
// stays at the repository root.
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

rootProject.name = "biza-miz-android"
include(":app")
