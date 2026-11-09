import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function assertAcceptanceBuildOrigin({ run, jobs, artifacts }, expected) {
  if (run.repository?.full_name !== expected.repository || run.head_sha !== expected.revision)
    throw new Error(
      `Shared build ${run.repository?.full_name}@${run.head_sha} does not match ${expected.repository}@${expected.revision}.`,
    );
  const producerName =
    run.path === ".github/workflows/ci.yml"
      ? "Build shared production outputs / Production platform and Agent build"
      : run.path === ".github/workflows/release.yml"
        ? "Backend amd64"
        : undefined;
  if (
    !producerName ||
    !jobs.some((job) => job.name === producerName && job.conclusion === "success")
  )
    throw new Error("The selected run has no successfully completed, trusted production build.");
  if (
    !artifacts.some(
      (artifact) =>
        artifact.name === "acceptance-runtime" &&
        !artifact.expired &&
        artifact.size_in_bytes > 0 &&
        /^sha256:[a-f0-9]{64}$/.test(artifact.digest),
    )
  )
    throw new Error("The selected run has no available verified acceptance-runtime artifact.");
  return String(run.id);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [runId, revision, repository] = process.argv.slice(2);
  if (
    !/^[1-9][0-9]*$/.test(runId ?? "") ||
    !/^[a-f0-9]{40}$/.test(revision ?? "") ||
    !/^[\w.-]+\/[\w.-]+$/.test(repository ?? "")
  )
    throw new Error(
      "Expected a numeric workflow run ID, full commit SHA and repository owner/name.",
    );
  const endpoint = `repos/${repository}/actions/runs/${runId}`;
  const read = (suffix) =>
    JSON.parse(
      execFileSync("gh", ["api", "--paginate", "--slurp", `${endpoint}${suffix}`], {
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        timeout: 30_000,
      }),
    );
  const [run] = read("");
  const jobs = read("/jobs?per_page=100").flatMap((page) => page.jobs);
  const artifacts = read("/artifacts?per_page=100").flatMap((page) => page.artifacts);
  process.stdout.write(
    assertAcceptanceBuildOrigin({ run, jobs, artifacts }, { repository, revision }) + "\n",
  );
}
