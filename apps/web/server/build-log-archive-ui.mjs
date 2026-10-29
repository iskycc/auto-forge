import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
const output = new URL("../../log-archive-viewer/cmd/viewer/assets/", import.meta.url);
const result = await build({
  entryPoints: [new URL("../src/archive-viewer/main.tsx", import.meta.url).pathname],
  bundle: true,
  platform: "browser",
  format: "iife",
  target: ["es2022"],
  minify: true,
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
  outfile: new URL("viewer.js", output).pathname,
  legalComments: "linked",
  metafile: true,
  logLevel: "info",
});
const repository = resolve(new URL("../../..", import.meta.url).pathname);
const packages = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
  let directory = dirname(resolve(input));
  while (directory !== dirname(directory)) {
    try {
      const metadata = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
      if (metadata.name && !metadata.name.startsWith("@autoforge/")) {
        packages.set(`${metadata.name}@${metadata.version}`, directory);
      }
      break;
    } catch (cause) {
      if (cause.code !== "ENOENT") throw cause;
      directory = dirname(directory);
    }
  }
}
const licenses = [];
for (const [name, directory] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
  let license;
  for (const filename of [
    "LICENSE",
    "LICENSE.txt",
    "LICENSE.md",
    "license",
    "license.md",
    "LICENCE",
    "License",
  ]) {
    try {
      license = await readFile(join(directory, filename), "utf8");
      break;
    } catch (cause) {
      if (cause.code !== "ENOENT") throw cause;
    }
  }
  if (!license && name.startsWith("@ant-design/icons-svg@"))
    license = await readFile(join(repository, "docs/licenses/ant-design-icons.txt"), "utf8");
  if (!license) {
    try {
      const readme = await readFile(join(directory, "README.md"), "utf8");
      const section = readme.match(/^#+\s+Licen[cs]e[^\n]*\n([\s\S]+)$/im)?.[1];
      if (section && /Permission is hereby granted|Redistribution and use/.test(section))
        license = section;
    } catch (cause) {
      if (cause.code !== "ENOENT") throw cause;
    }
  }
  if (!license) throw new Error(`Bundled viewer dependency has no license text: ${name}`);
  licenses.push(`${name}\n${license}`);
}
const goRoot = execFileSync("go", ["env", "GOROOT"], {
  encoding: "utf8",
  env: { ...process.env, GOTOOLCHAIN: "go1.26.5" },
}).trim();
licenses.unshift(
  `AutoForge\n${await readFile(join(repository, "LICENSE"), "utf8")}`,
  `Go standard library\n${await readFile(join(goRoot, "LICENSE"), "utf8")}`,
);
await writeFile(
  new URL("licenses.txt", output),
  licenses.join("\n\n========================================\n\n"),
);
