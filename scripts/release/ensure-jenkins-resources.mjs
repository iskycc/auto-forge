import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { jenkinsSourceDigest } from "./jenkins-source-digest.mjs";
import { verifyJenkinsResources } from "./verify-jenkins-resources.mjs";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const sourceDigest = await jenkinsSourceDigest(root);
let manifest;
try {
  manifest = await verifyJenkinsResources(resolve(root, "resources/jenkins"));
} catch (cause) {
  // Build-time repair only. Downloads at runtime never invoke Maven or the network.
  if (!(cause instanceof Error)) throw cause;
  process.stderr.write(`Preparing embedded Jenkins plugins: ${cause.message}\n`);
}
if (manifest?.sourceDigest !== sourceDigest) {
  execFileSync(
    "mvn",
    [
      "--batch-mode",
      "--no-transfer-progress",
      "--file",
      "integrations/jenkins/pom.xml",
      "-DskipTests",
      "clean",
      "package",
    ],
    { cwd: root, stdio: "inherit" },
  );
  execFileSync("bash", ["scripts/verify-jenkins-hpis.sh", "1.2.0-SNAPSHOT"], {
    cwd: root,
    stdio: "inherit",
  });
  execFileSync(
    process.execPath,
    ["scripts/release/stage-jenkins-resources.mjs", "1.2.0-SNAPSHOT"],
    { cwd: root, stdio: "inherit" },
  );
}
