import { createRequire } from "node:module";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const webBuildDirectory = join(repositoryRoot, "apps/web/.next");

const requiredFiles = [
  "LICENSE",
  "NOTICE",
  "THIRD_PARTY_LICENSES.json",
  "pnpm-workspace.yaml",
  "apps/web/package.json",
  "apps/worker/package.json",
];

const requiredDirectories = [
  "apps/web/.next",
  "apps/web/dist-server",
  "apps/worker/dist",
  "packages/db/drizzle",
  "resources/agents",
];

const explicitlyExternalModules = [
  "apps/web/node_modules/better-sqlite3",
  "apps/web/node_modules/next",
];

const externalModuleClosures = ["apps/web/node_modules/nats"];

export function isExcludedRuntimePath(relativePath) {
  const normalized = relativePath.replaceAll("\\", "/");
  const isNextBuildOutput = normalized.startsWith("apps/web/.next/");
  return (
    normalized.includes("/.next/cache/") ||
    normalized.endsWith("/.next/cache") ||
    normalized.includes("/apps/web/data/") ||
    normalized.startsWith("apps/web/data/") ||
    normalized === "apps/web/.next/trace" ||
    normalized === "apps/web/.next/trace-build" ||
    normalized === "apps/web/.next/turbopack" ||
    normalized.endsWith(".map") ||
    normalized.endsWith(".nft.json") ||
    normalized.endsWith(".tsbuildinfo") ||
    /(^|\/)coverage(\/|$)/.test(normalized) ||
    (!isNextBuildOutput && /(^|\/)(test|tests)(\/|$)/.test(normalized)) ||
    /\.(spec|test)\.[cm]?[jt]sx?$/.test(normalized)
  );
}

export function isNextTraceFile(fileName) {
  return fileName.endsWith(".nft.json");
}

export function assertSafeRuntimeDestination(destination) {
  const resolvedDestination = resolve(destination);
  const buildDestination = join(repositoryRoot, "backend-runtime");
  const temporaryRelativePath = relative(tmpdir(), resolvedDestination);
  const isTemporaryDestination =
    temporaryRelativePath.startsWith(`autoforge-runtime`) &&
    !temporaryRelativePath.includes(sep) &&
    !isAbsolute(temporaryRelativePath);
  if (resolvedDestination !== buildDestination && !isTemporaryDestination) {
    throw new Error(`Refusing to replace unsafe runtime destination: ${resolvedDestination}`);
  }
  return resolvedDestination;
}

export function selectedSqlitePrebuild() {
  if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch)) {
    throw new Error(`Unsupported backend runtime platform: ${process.platform}/${process.arch}`);
  }
  const glibcVersion = process.report?.getReport().header.glibcVersionRuntime;
  return `${glibcVersion ? "linux" : "linuxmusl"}-${process.arch}.node`;
}

export async function assertPackagedNextRoutes(destination) {
  const serverDirectory = join(destination, "apps/web/.next/server");
  const manifestPath = join(serverDirectory, "app-paths-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("Packaged Next.js app paths manifest is invalid.");
  }

  const routes = Object.entries(manifest);
  if (routes.length === 0) throw new Error("Packaged Next.js app paths manifest is empty.");

  const missingRoutes = [];
  for (const [route, modulePath] of routes) {
    if (typeof modulePath !== "string") {
      throw new Error(`Packaged Next.js route has an invalid module path: ${route}`);
    }
    const moduleFile = resolve(serverDirectory, modulePath);
    const relativeModulePath = relative(serverDirectory, moduleFile);
    if (
      isAbsolute(relativeModulePath) ||
      relativeModulePath === ".." ||
      relativeModulePath.startsWith(`..${sep}`)
    ) {
      throw new Error(`Packaged Next.js route escapes the server directory: ${route}`);
    }
    if (!(await exists(moduleFile))) missingRoutes.push(`${route} -> ${modulePath}`);
  }
  if (missingRoutes.length > 0) {
    throw new Error(
      `Packaged backend runtime is missing Next.js routes: ${missingRoutes.join(", ")}`,
    );
  }
}

async function packageRuntime(destination) {
  const runtimeDestination = assertSafeRuntimeDestination(destination);
  await assertBuildOutputsExist();

  const runtimeFiles = new Set();
  for (const path of requiredFiles) addRuntimePath(runtimeFiles, resolveRepositoryPath(path));
  for (const directory of requiredDirectories) {
    await addDirectory(runtimeFiles, resolveRepositoryPath(directory));
  }
  for (const traceFile of await findTraceFiles(webBuildDirectory)) {
    await addTraceFiles(runtimeFiles, traceFile);
  }
  const webRequire = createRequire(resolveRepositoryPath("apps/web/package.json"));
  // Next.js' generated traces describe route execution, but its custom-server
  // wrapper loads configuration modules dynamically before route dispatch. Keep
  // the framework package (without source maps) so those paths remain complete;
  // all other dependencies still come from exact trace files.
  await addDirectory(runtimeFiles, dirname(webRequire.resolve("next/package.json")));
  for (const modulePath of explicitlyExternalModules) {
    addRuntimePath(runtimeFiles, resolveRepositoryPath(modulePath));
  }
  for (const modulePath of externalModuleClosures) {
    await addExternalModuleClosure(runtimeFiles, resolveRepositoryPath(modulePath));
  }

  await rm(runtimeDestination, { recursive: true, force: true });
  await mkdir(runtimeDestination, { recursive: true });

  let totalBytes = 0;
  let copiedFiles = 0;
  const sqlitePrebuild = selectedSqlitePrebuild();
  for (const source of [...runtimeFiles].sort()) {
    const relativePath = repositoryRelativePath(source);
    if (isExcludedRuntimePath(relativePath)) continue;
    if (isUnselectedSqlitePrebuild(relativePath, sqlitePrebuild)) continue;
    const sourceMetadata = await lstat(source);
    const target = join(runtimeDestination, relativePath);
    await mkdir(dirname(target), { recursive: true });
    if (sourceMetadata.isSymbolicLink()) {
      await symlink(await readlink(source), target);
      continue;
    }
    if (!sourceMetadata.isFile()) continue;
    await copyFile(source, target);
    totalBytes += sourceMetadata.size;
    copiedFiles += 1;
  }

  await assertPackagedRuntime(runtimeDestination, sqlitePrebuild);
  process.stdout.write(
    `${JSON.stringify({
      destination: runtimeDestination,
      files: copiedFiles,
      sizeBytes: totalBytes,
      sqlitePrebuild,
    })}\n`,
  );
}

async function assertBuildOutputsExist() {
  for (const path of [
    "apps/web/.next/required-server-files.json",
    "apps/web/dist-server/server/index.js",
    "apps/web/dist-server/server/migrate.js",
    "apps/web/dist-server/server/work-thread.js",
    "apps/worker/dist/worker.mjs",
    "resources/agents/manifest.json",
  ]) {
    const source = resolveRepositoryPath(path);
    if (!(await exists(source)))
      throw new Error(`Required backend build output is missing: ${path}`);
  }
}

async function assertPackagedRuntime(destination, sqlitePrebuild) {
  const sqliteModule = await realpath(
    resolveRepositoryPath("apps/web/node_modules/better-sqlite3"),
  );
  const sqlitePrebuildPath = repositoryRelativePath(
    join(sqliteModule, "prebuilds", sqlitePrebuild),
  );
  for (const path of [
    "apps/web/.next/required-server-files.json",
    "apps/web/dist-server/server/index.js",
    "apps/web/dist-server/server/migrate.js",
    "apps/web/dist-server/server/work-thread.js",
    "apps/worker/dist/worker.mjs",
    "apps/web/node_modules/nats",
    sqlitePrebuildPath,
    "resources/agents/manifest.json",
  ]) {
    if (!(await exists(join(destination, path)))) {
      throw new Error(`Packaged backend runtime is missing: ${path}`);
    }
  }
  await assertPackagedNextRoutes(destination);
  if (await exists(join(destination, "apps/web/.next/cache"))) {
    throw new Error("Packaged backend runtime contains the Next.js build cache.");
  }
}

async function addExternalModuleClosure(runtimeFiles, moduleLink, visited = new Set()) {
  if (!(await exists(moduleLink))) {
    throw new Error(
      `Required external runtime module is missing: ${repositoryRelativePath(moduleLink)}`,
    );
  }
  addRuntimePath(runtimeFiles, moduleLink);

  const packageDirectory = await realpath(moduleLink);
  if (visited.has(packageDirectory)) return;
  visited.add(packageDirectory);
  await addDirectory(runtimeFiles, packageDirectory);

  const packageManifest = JSON.parse(
    await readFile(join(packageDirectory, "package.json"), "utf8"),
  );
  const requiredDependencyNames = new Set(Object.keys(packageManifest.dependencies ?? {}));
  const optionalDependencyNames = new Set(Object.keys(packageManifest.optionalDependencies ?? {}));
  const dependencyNames = new Set([...requiredDependencyNames, ...optionalDependencyNames]);
  for (const dependencyName of [...dependencyNames].sort()) {
    const dependencyLink = join(dirname(packageDirectory), dependencyName);
    if (!(await exists(dependencyLink))) {
      if (!requiredDependencyNames.has(dependencyName)) continue;
      throw new Error(
        `Runtime dependency ${dependencyName} is missing for ${repositoryRelativePath(packageDirectory)}`,
      );
    }
    await addExternalModuleClosure(runtimeFiles, dependencyLink, visited);
  }
}

async function addTraceFiles(runtimeFiles, traceFile) {
  const trace = JSON.parse(await readFile(traceFile, "utf8"));
  if (trace.version !== 1 || !Array.isArray(trace.files)) {
    throw new Error(`Unsupported Next.js trace format: ${repositoryRelativePath(traceFile)}`);
  }
  for (const tracedPath of trace.files) {
    if (typeof tracedPath !== "string") {
      throw new Error(`Invalid path in Next.js trace: ${repositoryRelativePath(traceFile)}`);
    }
    const source = resolve(dirname(traceFile), tracedPath);
    if (isExcludedRuntimePath(repositoryRelativePath(source))) continue;
    if (!(await exists(source))) {
      throw new Error(`Next.js trace references a missing file: ${repositoryRelativePath(source)}`);
    }
    addRuntimePath(runtimeFiles, source);
  }
}

async function addDirectory(runtimeFiles, directory) {
  if (!(await exists(directory))) throw new Error(`Required directory is missing: ${directory}`);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const source = join(directory, entry.name);
    const relativePath = repositoryRelativePath(source);
    if (isExcludedRuntimePath(relativePath)) continue;
    if (entry.isDirectory()) await addDirectory(runtimeFiles, source);
    else addRuntimePath(runtimeFiles, source);
  }
}

async function findTraceFiles(directory) {
  const traces = await collectTraceFiles(directory);
  if (traces.length === 0) throw new Error("Next.js did not produce dependency trace files.");
  return traces;
}

async function collectTraceFiles(directory) {
  const traces = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (isExcludedRuntimePath(repositoryRelativePath(path))) continue;
      traces.push(...(await collectTraceFiles(path)));
    } else if (isNextTraceFile(entry.name)) {
      traces.push(path);
    }
  }
  return traces;
}

function addRuntimePath(runtimeFiles, source) {
  repositoryRelativePath(source);
  runtimeFiles.add(source);
}

function resolveRepositoryPath(path) {
  return resolve(repositoryRoot, path);
}

function repositoryRelativePath(path) {
  const relativePath = relative(repositoryRoot, resolve(path));
  if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
    throw new Error(`Runtime path escapes the repository: ${path}`);
  }
  return relativePath;
}

function isUnselectedSqlitePrebuild(relativePath, selectedPrebuild) {
  const normalized = relativePath.replaceAll("\\", "/");
  return (
    normalized.includes("/better-sqlite3/prebuilds/") &&
    normalized.endsWith(".node") &&
    !normalized.endsWith(`/prebuilds/${selectedPrebuild}`)
  );
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && Reflect.get(error, "code") === "ENOENT") return false;
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const destination = process.argv[2];
  if (!destination || isAbsolute(destination) === false) {
    throw new Error("usage: package-backend-runtime.mjs ABSOLUTE_DESTINATION");
  }
  await packageRuntime(destination);
}
