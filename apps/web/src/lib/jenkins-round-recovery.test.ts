import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { JenkinsRebuildTransport } from "./jenkins-round-recovery";

describe("JenkinsRebuildTransport", () => {
  it("inspects job metadata and the last build without sending a build request", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        name: "reset",
        fullName: "environments/reset",
        url: "https://jenkins.internal/job/reset/",
        buildable: true,
        inQueue: false,
        lastBuild: {
          number: 41,
          url: "https://jenkins.internal/job/reset/41/",
          building: false,
          result: "SUCCESS",
          timestamp: 1_785_974_400_000,
          duration: 12_500,
        },
      }),
    );
    const transport = new JenkinsRebuildTransport(request);

    await expect(
      transport.inspectJob({
        jobUrl: "https://jenkins.internal/job/reset/",
        credential: "jenkins-user:api-token",
      }),
    ).resolves.toMatchObject({
      name: "reset",
      fullName: "environments/reset",
      buildable: true,
      inQueue: false,
      lastBuild: { number: 41, result: "SUCCESS", durationMs: 12_500 },
    });

    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[1]?.method).toBeUndefined();
    expect(request.mock.calls[0]?.[1]?.redirect).toBe("error");
    const headers = request.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get("authorization")).toBe(
      `Basic ${Buffer.from("jenkins-user:api-token").toString("base64")}`,
    );
    expect(String(request.mock.calls[0]?.[0])).toContain("/api/json?tree=");
  });

  it("reads lastBuild then invokes the Rebuilder endpoint with preemptive Basic auth", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ number: 41 }))
      .mockResolvedValueOnce(new Response(null, { status: 302 }));
    const transport = new JenkinsRebuildTransport(request);

    await expect(
      transport.rebuildLast({
        jobUrl: "https://jenkins.internal/job/reset",
        credential: "jenkins-user:api-token",
      }),
    ).resolves.toEqual({ sourceBuildNumber: 41 });

    expect(String(request.mock.calls[0]?.[0])).toBe(
      "https://jenkins.internal/job/reset/lastBuild/api/json?tree=number",
    );
    expect(String(request.mock.calls[1]?.[0])).toBe(
      "https://jenkins.internal/job/reset/lastBuild/rebuild/?autorebuild=1",
    );
    expect(request.mock.calls[1]?.[1]).toMatchObject({ method: "POST", redirect: "manual" });
    const headers = request.mock.calls[1]?.[1]?.headers as Headers;
    expect(headers.get("authorization")).toBe(
      `Basic ${Buffer.from("jenkins-user:api-token").toString("base64")}`,
    );
  });

  it("selects only the RebuildCause linked to the captured source build", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        builds: [
          {
            number: 44,
            url: "https://jenkins.internal/job/reset/44/",
            building: false,
            result: "SUCCESS",
            actions: [{ causes: [{ _class: "hudson.model.Cause$UserIdCause" }] }],
          },
          {
            number: 42,
            url: "https://jenkins.internal/job/reset/42/",
            building: true,
            result: null,
            actions: [
              {
                causes: [
                  {
                    _class: "com.sonyericsson.rebuild.RebuildCause",
                    upstreamBuild: 41,
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    const transport = new JenkinsRebuildTransport(request);

    await expect(
      transport.inspectRebuild({
        jobUrl: "https://jenkins.internal/job/reset/",
        credential: "jenkins-user:api-token",
        sourceBuildNumber: 41,
      }),
    ).resolves.toEqual({
      status: "running",
      buildNumber: 42,
      buildUrl: "https://jenkins.internal/job/reset/42/",
    });
  });

  it("rejects a build URL outside the configured Jenkins job scope", async () => {
    const transport = new JenkinsRebuildTransport(
      vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse({
          number: 42,
          url: "https://attacker.invalid/job/reset/42/",
          building: false,
          result: "SUCCESS",
        }),
      ),
    );

    await expect(
      transport.inspectRebuild({
        jobUrl: "https://jenkins.internal/job/reset/",
        credential: "jenkins-user:api-token",
        sourceBuildNumber: 41,
        rebuildNumber: 42,
        rebuildUrl: "https://jenkins.internal/job/reset/42/",
      }),
    ).rejects.toThrow("任务范围外");
  });
});

function jsonResponse(value: unknown): Response {
  return Response.json(value);
}
