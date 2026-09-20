// ============================================================================
// @wekanz/baseforge-kotlin — SDK Kotlin untuk BaseForge (M69).
//
// JVM MURNI, bukan Android library: bisa diuji dengan `./gradlew test` tanpa
// emulator, dan dipakai dari Android (minSdk 26 aman lewat desugar AGP 8),
// Compose Desktop, atau server Kotlin. Tidak ada dependensi AndroidX di sini —
// persistence AuthStore adalah urusan aplikasi.
//
// Versi Kotlin disamakan dengan ExploreMaps (2.0.21) agar konsumen pertama
// tidak perlu menaikkan toolchain-nya.
// ============================================================================

plugins {
    kotlin("jvm") version "2.0.21"
    kotlin("plugin.serialization") version "2.0.21"
    `java-library`
    `maven-publish`
}

group = "id.wekanz.baseforge"
version = "0.3.0"

kotlin {
    jvmToolchain(17)
    explicitApi() // setiap deklarasi publik wajib eksplisit — mencegah API bocor tak sengaja
}

dependencies {
    api("com.squareup.okhttp3:okhttp:4.12.0")
    api("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    // `api`, BUKAN `implementation`: API publik SDK mengekspos fungsi `suspend` dan
    // tipe kotlinx.serialization (Map<String, JsonElement>). Konsumen WAJIB melihat
    // dependensi ini saat kompilasi — dibuktikan oleh proyek konsumen percobaan yang
    // gagal "Unresolved reference 'coroutines'" ketika ini masih `implementation`.
    api("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.9.0")

    testImplementation(kotlin("test"))
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.9.0")
}

tasks.test {
    useJUnitPlatform()
    // Integration test ke server lokal dikendalikan env — lihat LiveAuthTest.
    environment("BASEFORGE_TEST_URL", System.getenv("BASEFORGE_TEST_URL") ?: "")
    environment("BASEFORGE_ADMIN_EMAIL", System.getenv("BASEFORGE_ADMIN_EMAIL") ?: "")
    environment("BASEFORGE_ADMIN_PASSWORD", System.getenv("BASEFORGE_ADMIN_PASSWORD") ?: "")
    testLogging {
        events("passed", "skipped", "failed")
        showStandardStreams = false
    }
}

java {
    withSourcesJar()
}

publishing {
    publications {
        create<MavenPublication>("maven") {
            from(components["java"])
            artifactId = "kotlin-client"
            pom {
                name.set("BaseForge Kotlin Client")
                description.set("Kotlin/JVM SDK for the BaseForge backend (auth, records, files, realtime).")
                url.set("https://github.com/DeffaldoFarel/WekanzBaseForge")
            }
        }
    }
}
