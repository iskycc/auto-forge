import "server-only";

import type { JenkinsDependencyTransport } from "@autoforge/application";
import type { JenkinsDependencyBuild, JenkinsDependencyConnection } from "@autoforge/contracts";
import { DomainError } from "@autoforge/domain";

const buildFields = "number,url,queueId,building,result,timestamp,duration";
const maximumResponseBytes = 256 * 1024;

export class JenkinsDependencyBuildTransport implements JenkinsDependencyTransport {
  constructor(private readonly request: typeof fetch = fetch) {}

  async inspect(connection: JenkinsDependencyConnection) {
    const job = await this.read(connection, apiUrl(connection.jobUrl, "name,buildable"));
    if (typeof job.name !== "string" || typeof job.buildable !== "boolean") throw invalidResponse();
    return { name: job.name, buildable: job.buildable };
  }

  async trigger(connection: JenkinsDependencyConnection): Promise<{ queueUrl: string }> {
    const body = new URLSearchParams();
    for (const parameter of connection.parameters) body.append(parameter.name, parameter.value);
    const response = await this.request(new URL("buildWithParameters", connection.jobUrl), {
      method: "POST",
      headers: {
        ...headers(connection),
        "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
      },
      body: body.toString(),
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    await response.body?.cancel();
    if ([400, 401, 403, 404, 405, 422].includes(response.status))
      throw new DomainError(
        "JENKINS_BUILD_REJECTED",
        `Jenkins 拒绝构建（HTTP ${response.status}），请检查任务地址、参数和账号的 Job/Build 权限；必须使用 API Token。`,
      );
    const location = response.headers.get("location");
    if (response.status !== 201 || !location) throw invalidResponse();
    return { queueUrl: safeQueueUrl(connection.jobUrl, location) };
  }

  async poll(connection: JenkinsDependencyConnection, build: JenkinsDependencyBuild) {
    if (build.buildUrl)
      return mapBuild(
        await this.read(
          connection,
          apiUrl(safeBuildUrl(connection.jobUrl, build.buildUrl), buildFields),
        ),
        connection.jobUrl,
      );
    if (!build.queueUrl) throw invalidResponse();
    const queueUrl = safeQueueUrl(connection.jobUrl, build.queueUrl);
    const queue = await this.read(
      connection,
      apiUrl(queueUrl, "cancelled,why,executable[number,url]"),
      true,
    );
    if (queue.missing === true) return this.recoverQueue(connection, queueUrl);
    if (queue.cancelled === true)
      return { status: "cancelled" as const, message: "Jenkins 已取消排队构建。" };
    if (isRecord(queue.executable)) {
      const url = safeBuildUrl(connection.jobUrl, String(queue.executable.url));
      return mapBuild(await this.read(connection, apiUrl(url, buildFields)), connection.jobUrl);
    }
    return { status: "queued" as const, message: "正在 Jenkins 队列中等待执行。" };
  }

  private async recoverQueue(connection: JenkinsDependencyConnection, queueUrl: string) {
    const queueId = Number(new URL(queueUrl).pathname.split("/").filter(Boolean).at(-1));
    const job = await this.read(
      connection,
      apiUrl(connection.jobUrl, `builds[${buildFields}]{0,20}`),
    );
    const build = Array.isArray(job.builds)
      ? job.builds.find((item: unknown) => isRecord(item) && item.queueId === queueId)
      : undefined;
    return isRecord(build)
      ? mapBuild(build, connection.jobUrl)
      : {
          status: "unknown" as const,
          message:
            "Jenkins 队列记录已过期，最近 20 次构建中未找到对应记录，请打开 Jenkins 核对后解除提交保护。",
        };
  }

  private async read(
    connection: JenkinsDependencyConnection,
    url: URL,
    allowMissing = false,
  ): Promise<Record<string, unknown>> {
    const response = await this.request(url, {
      headers: headers(connection),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (allowMissing && response.status === 404) return { missing: true };
      throw new DomainError(
        "JENKINS_API_UNAVAILABLE",
        `Jenkins API 返回 HTTP ${response.status}，请检查任务读取权限、API 密钥和网络连接。`,
      );
    }
    const reader = response.body?.getReader();
    if (!reader) throw invalidResponse();
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > maximumResponseBytes) throw invalidResponse();
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!isRecord(value)) throw invalidResponse();
    return value;
  }
}

function mapBuild(build: Record<string, unknown>, jobUrl: string) {
  if (
    !Number.isSafeInteger(build.number) ||
    Number(build.number) < 0 ||
    typeof build.url !== "string" ||
    typeof build.building !== "boolean"
  )
    throw invalidResponse();
  const buildUrl = safeBuildUrl(jobUrl, build.url);
  const running = build.building || build.result === null;
  if (!running && typeof build.result !== "string") throw invalidResponse();
  const timestamp =
    typeof build.timestamp === "number" &&
    Number.isSafeInteger(build.timestamp) &&
    build.timestamp >= 0 &&
    build.timestamp < 8.64e15
      ? build.timestamp
      : undefined;
  const duration =
    typeof build.duration === "number" &&
    Number.isSafeInteger(build.duration) &&
    build.duration >= 0
      ? build.duration
      : undefined;
  return {
    status: running
      ? ("running" as const)
      : build.result === "SUCCESS"
        ? ("succeeded" as const)
        : build.result === "ABORTED"
          ? ("cancelled" as const)
          : ("failed" as const),
    buildNumber: Number(build.number),
    buildUrl,
    message: running
      ? "Jenkins 正在执行构建。"
      : `Jenkins 构建结果：${String(build.result).slice(0, 128)}。`,
    ...(!running ? { result: String(build.result).slice(0, 128) } : {}),
    ...(timestamp !== undefined ? { startedAt: new Date(timestamp).toISOString() } : {}),
    ...(!running &&
    timestamp !== undefined &&
    duration !== undefined &&
    timestamp + duration < 8.64e15
      ? { finishedAt: new Date(timestamp + duration).toISOString() }
      : {}),
  };
}
function headers(connection: JenkinsDependencyConnection) {
  return {
    accept: "application/json",
    authorization: `Basic ${Buffer.from(`${connection.username}:${connection.apiToken}`, "utf8").toString("base64")}`,
  };
}
function apiUrl(base: string, tree: string) {
  const url = new URL("api/json", base);
  url.searchParams.set("tree", tree);
  return url;
}
function safeBuildUrl(jobUrl: string, value: string): string {
  const job = new URL(jobUrl);
  const url = new URL(value, job);
  const suffix = url.pathname.slice(job.pathname.length);
  if (
    url.origin !== job.origin ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname.startsWith(job.pathname) ||
    !/^\d+\/$/.test(suffix)
  )
    throw invalidResponse();
  return url.toString();
}
function safeQueueUrl(jobUrl: string, value: string): string {
  const job = new URL(jobUrl);
  const url = new URL(value, job);
  const contextPath = job.pathname.slice(0, job.pathname.indexOf("/job/"));
  const suffix = url.pathname.slice(contextPath.length);
  if (
    url.origin !== job.origin ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname.startsWith(contextPath) ||
    !/^\/queue\/item\/\d+\/$/.test(suffix)
  )
    throw invalidResponse();
  return url.toString();
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function invalidResponse() {
  return new DomainError(
    "JENKINS_RESPONSE_INVALID",
    "Jenkins 返回的数据或构建链接无效，请检查服务地址与反向代理配置。",
  );
}
