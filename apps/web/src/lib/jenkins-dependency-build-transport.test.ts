import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { JenkinsDependencyBuildTransport } from "./jenkins-dependency-build-transport";
const connection = {
  jobUrl: "https://jenkins.test/jenkins/job/folder/job/dependencies/",
  username: "builder",
  apiToken: "secret",
  parameters: [
    { name: "VERSION", value: "中文 &+" },
    { name: "EMPTY", value: "" },
  ],
};
const queued = {
  id: "id",
  jobUrl: connection.jobUrl,
  status: "queued" as const,
  queueUrl: "https://jenkins.test/jenkins/queue/item/7/",
  triggeredBy: "operator",
  triggeredAt: "2026-11-06T10:00:00Z",
};
const json = (value: unknown) => Response.json(value);
const build = {
  number: 42,
  url: `${connection.jobUrl}42/`,
  queueId: 7,
  building: false,
  result: "SUCCESS",
  timestamp: 1700000000000,
  duration: 100,
};

describe("parameterized Jenkins transport", () => {
  it("POSTs UTF-8 parameters including empty values with Basic API token auth, retaining the exact queue", async () => {
    const request = vi
      .fn()
      .mockResolvedValue(
        new Response(null, { status: 201, headers: { location: "/jenkins/queue/item/7/" } }),
      );
    const transport = new JenkinsDependencyBuildTransport(request);
    expect(await transport.trigger(connection)).toEqual({ queueUrl: queued.queueUrl });
    const [url, options] = request.mock.calls[0]!;
    expect(String(url)).toBe(`${connection.jobUrl}buildWithParameters`);
    expect(new URLSearchParams(options.body).get("VERSION")).toBe("中文 &+");
    expect(new URLSearchParams(options.body).has("EMPTY")).toBe(true);
    expect(options).toMatchObject({
      method: "POST",
      redirect: "manual",
      headers: { authorization: `Basic ${Buffer.from("builder:secret").toString("base64")}` },
    });
  });
  it.each([
    "https://evil.test/queue/item/7/",
    "/jenkins/job/other/42/",
    "https://user:pass@jenkins.test/jenkins/queue/item/7/",
  ])("refuses credential leakage to unexpected Location %s", async (location) => {
    const request = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 201, headers: { location } }));
    await expect(
      new JenkinsDependencyBuildTransport(request).trigger(connection),
    ).rejects.toMatchObject({ code: "JENKINS_RESPONSE_INVALID" });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("polls queue then exact executable and maps completed timestamps", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(json({ executable: { number: 42, url: build.url } }))
      .mockResolvedValueOnce(json(build));
    expect(
      await new JenkinsDependencyBuildTransport(request).poll(connection, queued),
    ).toMatchObject({
      status: "succeeded",
      buildNumber: 42,
      result: "SUCCESS",
      finishedAt: new Date(build.timestamp + 100).toISOString(),
    });
  });
  it("recovers expired queue using queueId, never uses another concurrent last build", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(json({ builds: [{ ...build, number: 43, queueId: 8 }, build] }));
    expect(
      await new JenkinsDependencyBuildTransport(request).poll(connection, queued),
    ).toMatchObject({ buildNumber: 42 });
  });
  it("reports cancelled queues and rejects redirects and auth failures without retry", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(json({ cancelled: true }))
      .mockResolvedValueOnce(new Response(null, { status: 403 }));
    const transport = new JenkinsDependencyBuildTransport(request);
    expect(await transport.poll(connection, queued)).toMatchObject({ status: "cancelled" });
    await expect(transport.trigger(connection)).rejects.toMatchObject({
      code: "JENKINS_BUILD_REJECTED",
    });
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("rejects oversized API responses", async () => {
    const transport = new JenkinsDependencyBuildTransport(
      vi.fn().mockResolvedValue(new Response("x".repeat(300000))),
    );
    await expect(transport.inspect(connection)).rejects.toMatchObject({
      code: "JENKINS_RESPONSE_INVALID",
    });
  });
});
