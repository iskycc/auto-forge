import { execFileSync } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function summarizeJobCosts(jobs, nowMs) {
  const measured = jobs
    .filter((job) => job.started_at && job.status !== "queued")
    .map((job) => ({
      name: job.name,
      conclusion: job.conclusion ?? job.status,
      minutes: Math.max(
        0,
        ((job.completed_at ? Date.parse(job.completed_at) : nowMs) - Date.parse(job.started_at)) /
          60_000,
      ),
    }));
  return {
    totalMinutes: measured.reduce((total, job) => total + job.minutes, 0),
    slowest: measured.sort((left, right) => right.minutes - left.minutes).slice(0, 12),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pages = JSON.parse(
    execFileSync(
      "gh",
      [
        "api",
        "--paginate",
        "--slurp",
        `repos/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}/jobs?per_page=100`,
      ],
      { encoding: "utf8" },
    ),
  );
  const summary = summarizeJobCosts(
    pages.flatMap((page) => page.jobs),
    Date.now(),
  );
  const report = [
    "### CI 作业耗时",
    "",
    `累计作业运行时间：**${summary.totalMinutes.toFixed(1)} 分钟**（各并行作业之和，非账单金额）。`,
    "",
    "| 作业 | 分钟 | 结果 |",
    "| --- | ---: | --- |",
    ...summary.slowest.map(
      (job) =>
        `| ${job.name.replaceAll("|", "\\|")} | ${job.minutes.toFixed(1)} | ${job.conclusion} |`,
    ),
    "",
    "构建和下载阶段的详细耗时可在对应作业步骤中查看。",
    "",
  ].join("\n");
  await appendFile(process.env.GITHUB_STEP_SUMMARY, report);
}
