plugins {
    id("org.jetbrains.kotlin.jvm")
}


dependencies {
    // Provided by the Android framework at runtime; only needed on the JVM for tests.
    compileOnly("org.json:json:20240303")
    testImplementation("org.json:json:20240303")
    testImplementation(kotlin("test"))
}

tasks.test { useJUnitPlatform() }
