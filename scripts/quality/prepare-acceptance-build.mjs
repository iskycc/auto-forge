import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { verifyAcceptanceBuild } from "./acceptance-build.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const [scope = "web"] = process.argv.slice(2);
const commands = {
  all: ["build"],
  web: ["--filter", "@autoforge/web", "build"],
  worker: ["--filter", "@autoforge/worker", "build"],
  threads: ["--filter", "@autoforge/web", "build:work-thread"],
  agents: ["build:agent-resources"],
};
if (scope !== "resources" && !commands[scope])
  throw new Error(`Unknown acceptance build scope: ${scope}`);
if (process.env.AUTOFORGE_ACCEPTANCE_PREBUILT === "1") {
  await verifyAcceptanceBuild(root, scope);
  process.stdout.write(`Reusing verified ${scope} outputs for this exact source.\n`);
} else if (scope === "resources") {
  for (const name of ["jenkins", "log-viewer"])
    execFileSync(process.execPath, [`scripts/release/ensure-${name}-resources.mjs`], {
      cwd: root,
      stdio: "inherit",
    });
} else {
  execFileSync("pnpm", commands[scope], { cwd: root, stdio: "inherit" });
}
