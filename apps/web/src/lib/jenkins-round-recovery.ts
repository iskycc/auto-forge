import "server-only";

import type { JenkinsRebuildState, JenkinsRoundRecoveryTransport } from "@autoforge/application";
import type { JenkinsJobInspection } from "@autoforge/contracts";

type FetchLike = typeof fetch;

export class JenkinsRebuildTransport implements JenkinsRoundRecoveryTransport {
  constructor(private readonly request: FetchLike = fetch) {}

  async inspectJob(input: { jobUrl: string; credential: string }): Promise<JenkinsJobInspection> {
    const jobUrl = normalizedJobUrl(input.jobUrl);
    const query = new URLSearchParams({
      tree: "name,fullName,url,buildable,inQueue,lastBuild[number,url,building,result,timestamp,duration]",
    });
    const job = await this.readJson(
      childUrl(jobUrl, `api/json?${query.toString()}`),
      input.credential,
    );
    const inspectedUrl = safeBuildUrl(
      jobUrl,
      stringField(job, "url", "Jenkins 任务链接缺失。"),
    ).toString();
    const lastBuild = isRecord(job.lastBuild)
      ? inspectedLastBuild(job.lastBuild, jobUrl)
      : undefined;
    return {
      name: stringField(job, "name", "Jenkins 任务名称缺失。"),
      ...(typeof job.fullName === "string" && job.fullName ? { fullName: job.fullName } : {}),
      url: inspectedUrl,
      buildable: booleanField(job, "buildable", "Jenkins 任务可构建状态无效。"),
      inQueue: booleanField(job, "inQueue", "Jenkins 任务排队状态无效。"),
      ...(lastBuild ? { lastBuild } : {}),
    };
  }

  async rebuildLast(input: {
    jobUrl: string;
    credential: string;
  }): Promise<{ sourceBuildNumber: number }> {
    const jobUrl = normalizedJobUrl(input.jobUrl);
    const source = await this.readJson(
      childUrl(jobUrl, "lastBuild/api/json?tree=number"),
      input.credential,
    );
    const sourceBuildNumber = integerField(source, "number", "Jenkins 最近构建编号无效。");
    const response = await this.request(childUrl(jobUrl, "lastBuild/rebuild/?autorebuild=1"), {
      method: "POST",
      headers: authenticationHeaders(input.credential),
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    await response.body?.cancel();
    if (response.status < 200 || response.status >= 400) {
      throw new Error(`Jenkins Rebuild 请求返回 HTTP ${response.status}。`);
    }
    return { sourceBuildNumber };
  }

  async inspectRebuild(input: {
    jobUrl: string;
    credential: string;
    sourceBuildNumber: number;
    rebuildNumber?: number;
    rebuildUrl?: string;
  }): Promise<JenkinsRebuildState> {
    const jobUrl = normalizedJobUrl(input.jobUrl);
    if (input.rebuildNumber !== undefined && input.rebuildUrl) {
      const buildUrl = safeBuildUrl(jobUrl, input.rebuildUrl);
      const build = await this.readJson(
        childUrl(buildUrl, "api/json?tree=number,url,building,result"),
        input.credential,
      );
      return buildState(build, jobUrl);
    }
    const query = new URLSearchParams({
      tree: "builds[number,url,building,result,actions[causes[_class,upstreamBuild]]]{0,20}",
    });
    const response = await this.readJson(
      childUrl(jobUrl, `api/json?${query.toString()}`),
      input.credential,
    );
    const builds = Array.isArray(response.builds) ? response.builds : [];
    const rebuild = builds
      .filter((candidate): candidate is Record<string, unknown> => isRecord(candidate))
      .filter((candidate) => rebuildOf(candidate, input.sourceBuildNumber))
      .sort((left, right) => numericValue(right.number) - numericValue(left.number))[0];
    return rebuild ? buildState(rebuild, jobUrl) : { status: "discovering" };
  }

  private async readJson(url: URL, credential: string): Promise<Record<string, unknown>> {
    const response = await this.request(url, {
      headers: authenticationHeaders(credential),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Jenkins API 返回 HTTP ${response.status}。`);
    }
    const value: unknown = await response.json();
    if (!isRecord(value)) throw new Error("Jenkins API 返回了无效 JSON 对象。");
    return value;
  }
}

function rebuildOf(build: Record<string, unknown>, sourceBuildNumber: number): boolean {
  const number = numericValue(build.number);
  if (!Number.isInteger(number) || number <= sourceBuildNumber) return false;
  const actions = Array.isArray(build.actions) ? build.actions : [];
  return actions.some((action) => {
    if (!isRecord(action) || !Array.isArray(action.causes)) return false;
    return action.causes.some(
      (cause) =>
        isRecord(cause) &&
        typeof cause._class === "string" &&
        cause._class.endsWith(".RebuildCause") &&
        numericValue(cause.upstreamBuild) === sourceBuildNumber,
    );
  });
}

function buildState(build: Record<string, unknown>, jobUrl: URL): JenkinsRebuildState {
  const buildNumber = integerField(build, "number", "Jenkins Rebuild 构建编号无效。");
  if (typeof build.url !== "string") throw new Error("Jenkins Rebuild 构建链接缺失。");
  const buildUrl = safeBuildUrl(jobUrl, build.url).toString();
  if (build.building === true || build.result === null || build.result === undefined) {
    return { status: "running", buildNumber, buildUrl };
  }
  if (build.result === "SUCCESS") return { status: "succeeded", buildNumber, buildUrl };
  if (typeof build.result !== "string") throw new Error("Jenkins Rebuild 构建结果无效。");
  return { status: "failed", buildNumber, buildUrl, result: build.result };
}

function inspectedLastBuild(
  build: Record<string, unknown>,
  jobUrl: URL,
): NonNullable<JenkinsJobInspection["lastBuild"]> {
  const timestamp = numericValue(build.timestamp);
  const duration = numericValue(build.duration);
  return {
    number: integerField(build, "number", "Jenkins 最近构建编号无效。"),
    url: safeBuildUrl(jobUrl, stringField(build, "url", "Jenkins 最近构建链接缺失。")).toString(),
    building: booleanField(build, "building", "Jenkins 最近构建状态无效。"),
    ...(typeof build.result === "string" && build.result ? { result: build.result } : {}),
    ...(Number.isFinite(timestamp) && timestamp >= 0
      ? { startedAt: new Date(timestamp).toISOString() }
      : {}),
    ...(Number.isInteger(duration) && duration >= 0 ? { durationMs: duration } : {}),
  };
}

function normalizedJobUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Jenkins 任务链接必须使用 HTTP(S)。");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Jenkins 任务链接不能包含凭据、查询参数或片段。");
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

function childUrl(base: URL, relative: string): URL {
  return new URL(relative, base);
}

function safeBuildUrl(jobUrl: URL, value: string): URL {
  const url = new URL(value, jobUrl);
  if (url.origin !== jobUrl.origin || !url.pathname.startsWith(jobUrl.pathname)) {
    throw new Error("Jenkins 返回了任务范围外的构建链接。");
  }
  return url;
}

function authenticationHeaders(credential: string): Headers {
  const headers = new Headers();
  headers.set("accept", "application/json");
  headers.set("authorization", `Basic ${Buffer.from(credential, "utf8").toString("base64")}`);
  return headers;
}

function integerField(value: Record<string, unknown>, field: string, message: string): number {
  const number = numericValue(value[field]);
  if (!Number.isInteger(number) || number < 0) throw new Error(message);
  return number;
}

function stringField(value: Record<string, unknown>, field: string, message: string): string {
  const text = value[field];
  if (typeof text !== "string" || !text) throw new Error(message);
  return text;
}

function booleanField(value: Record<string, unknown>, field: string, message: string): boolean {
  const flag = value[field];
  if (typeof flag !== "boolean") throw new Error(message);
  return flag;
}

function numericValue(value: unknown): number {
  return typeof value === "number" ? value : Number.NaN;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
