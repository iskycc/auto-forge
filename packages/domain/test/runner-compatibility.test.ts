import { describe, expect, it } from "vitest";

import { assessRunnerCompatibility } from "../src/runner-compatibility";

describe("Runner compatibility", () => {
  it("accepts a versioned Linux Agent with the required executor and isolation", () => {
    expect(
      assessRunnerCompatibility({
        os: "linux",
        architecture: "amd64",
        agentVersion: "0.2.2",
        protocolVersion: 1,
        capabilities: ["executor:testng-v1", "isolation:cgroup-v2", "java:24.0.2", "testng:7.11.0"],
      }),
    ).toEqual({
      compatible: true,
      status: "compatible",
      issues: [],
      javaVersion: "24.0.2",
      testNgVersion: "7.11.0",
    });
  });

  it("blocks unsupported protocol, platform and execution capabilities", () => {
    expect(
      assessRunnerCompatibility({
        os: "windows",
        architecture: "amd64",
        agentVersion: "dev",
        protocolVersion: 0,
        capabilities: [],
      }),
    ).toMatchObject({
      compatible: false,
      status: "incompatible",
      issues: [
        "protocol_unsupported",
        "platform_unsupported",
        "testng_executor_missing",
        "resource_isolation_missing",
        "java_version_unknown",
        "testng_version_unknown",
        "agent_version_unversioned",
      ],
    });
  });

  it("blocks Agents with incomplete toolchain metadata", () => {
    expect(
      assessRunnerCompatibility({
        os: "linux",
        architecture: "arm64",
        agentVersion: "dev",
        protocolVersion: 1,
        capabilities: ["executor:testng-v1", "isolation:cgroup-v2"],
      }),
    ).toMatchObject({
      compatible: false,
      status: "incompatible",
      issues: ["java_version_unknown", "testng_version_unknown", "agent_version_unversioned"],
    });
  });

  it("rejects Java and TestNG versions outside the offline execution baseline", () => {
    expect(
      assessRunnerCompatibility({
        os: "linux",
        architecture: "amd64",
        agentVersion: "0.2.2",
        protocolVersion: 1,
        capabilities: [
          "executor:testng-v1",
          "isolation:cgroup-v2",
          "java:1.8.0_452",
          "testng:7.10.2",
        ],
      }),
    ).toMatchObject({
      compatible: false,
      issues: ["java_version_unsupported", "testng_version_unsupported"],
    });
  });
});
