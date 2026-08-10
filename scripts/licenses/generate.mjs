import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { format } from "prettier";

const root = resolve(import.meta.dirname, "../..");
const outputPath = resolve(root, "THIRD_PARTY_LICENSES.json");
const check = process.argv.includes("--check");

const pnpmResult = spawnSync("pnpm", ["licenses", "list", "--json", "--prod"], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
});
if (pnpmResult.status !== 0) {
  throw new Error(`pnpm license inventory failed: ${pnpmResult.stderr.trim()}`);
}

const grouped = JSON.parse(pnpmResult.stdout);
const packages = [];
for (const [license, entries] of Object.entries(grouped)) {
  for (const entry of entries) {
    for (const version of entry.versions) {
      packages.push({
        ecosystem: "npm",
        name: entry.name,
        version,
        license,
        ...(entry.homepage ? { homepage: entry.homepage } : {}),
      });
    }
  }
}

const goResult = spawnSync(
  "go",
  [
    "-C",
    "apps/runner-agent",
    "list",
    "-m",
    "-f",
    "{{if not .Main}}{{.Path}}\t{{.Version}}{{end}}",
    "all",
  ],
  { cwd: root, encoding: "utf8" },
);
if (goResult.status !== 0) {
  throw new Error(`Go module inventory failed: ${goResult.stderr.trim()}`);
}
const reviewedGoLicenses = new Map([
  ["github.com/coder/websocket", "ISC"],
  ["github.com/creack/pty", "MIT"],
]);
for (const line of goResult.stdout.split("\n").filter(Boolean)) {
  const [name, version] = line.split("\t");
  const license = reviewedGoLicenses.get(name);
  if (!license || !version) throw new Error(`Unreviewed Go module license: ${line}`);
  packages.push({ ecosystem: "go", name, version, license });
}

const unique = [
  ...new Map(
    packages.map((entry) => [`${entry.ecosystem}:${entry.name}@${entry.version}`, entry]),
  ).values(),
].sort((left, right) =>
  `${left.ecosystem}:${left.name}@${left.version}`.localeCompare(
    `${right.ecosystem}:${right.name}@${right.version}`,
  ),
);
const inventory = await format(
  JSON.stringify(
    {
      schemaVersion: 1,
      generatedFrom: ["pnpm-lock.yaml", "apps/runner-agent/go.sum"],
      warning:
        "This inventory is not legal advice. Release packaging must include license texts and source offers required by the binaries actually shipped.",
      packages: unique,
    },
    null,
    2,
  ),
  { parser: "json" },
);

if (check) {
  if (readFileSync(outputPath, "utf8") !== inventory) {
    throw new Error("THIRD_PARTY_LICENSES.json is stale; run pnpm licenses:generate.");
  }
} else {
  writeFileSync(outputPath, inventory, "utf8");
}
