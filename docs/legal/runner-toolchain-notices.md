# Runner toolchain notices

When an operator builds an optional offline Runner toolchain from the versions below, the resulting
bundle contains Eclipse Temurin OpenJDK 21 and the listed Java libraries. Formal AutoForge releases
do not currently ship this toolchain bundle. Source distributions, licenses and notices remain
inside the JRE or upstream JAR files. AutoForge does not modify these components and disables runtime
downloads.

| Component                   | Version  | Upstream                | License                               |
| --------------------------- | -------- | ----------------------- | ------------------------------------- |
| Eclipse Temurin OpenJDK JRE | 21.0.8+9 | https://adoptium.net/   | GPL-2.0-only with Classpath Exception |
| TestNG                      | 7.11.0   | https://testng.org/     | Apache-2.0                            |
| JCommander                  | 1.83     | https://jcommander.org/ | Apache-2.0                            |
| SLF4J API                   | 2.0.16   | https://www.slf4j.org/  | MIT                                   |
| jQuery WebJar               | 3.7.1    | https://jquery.com/     | MIT                                   |

Before redistribution, generate and review an SPDX SBOM for each architecture-specific toolchain and
the `legal/` directory inside its JRE. Verify the archive with the `.sha256` file produced by
`build-runner-toolchain.sh`; the archive's `file-sha256sums` authenticates each unpacked JRE and
library file.
