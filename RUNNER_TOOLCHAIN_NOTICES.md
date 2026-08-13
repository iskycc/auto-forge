# Runner toolchain notices

The optional offline Runner toolchain assets contain Eclipse Temurin OpenJDK 21 and the exact Java
libraries below. Their source distributions, licenses and notices remain included inside the JRE or
upstream JAR files. AutoForge does not modify these components and disables runtime downloads.

| Component | Version | Upstream | License |
| --- | --- | --- | --- |
| Eclipse Temurin OpenJDK JRE | 21.0.8+9 | https://adoptium.net/ | GPL-2.0-only with Classpath Exception |
| TestNG | 7.11.0 | https://testng.org/ | Apache-2.0 |
| JCommander | 1.83 | https://jcommander.org/ | Apache-2.0 |
| SLF4J API | 2.0.16 | https://www.slf4j.org/ | MIT |
| jQuery WebJar | 3.7.1 | https://jquery.com/ | MIT |

Before redistribution, review the SPDX SBOM shipped beside each architecture-specific toolchain and
the `legal/` directory inside its JRE. The outer `SHA256SUMS` signature authenticates the complete
toolchain archive; `file-sha256sums` authenticates every unpacked JRE and library file.
