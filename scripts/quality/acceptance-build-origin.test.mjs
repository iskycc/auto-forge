import assert from "node:assert/strict";
import test from "node:test";
import { assertAcceptanceBuildOrigin } from "./acceptance-build-origin.mjs";

const expected = { repository: "example/auto-forge", revision: "a".repeat(40) };
function fixture() {
  return {
    run: {
      id: 123,
      repository: { full_name: expected.repository },
      head_sha: expected.revision,
      path: ".github/workflows/ci.yml",
      status: "in_progress",
    },
    jobs: [
      {
        name: "Build shared production outputs / Production platform and Agent build",
        conclusion: "success",
      },
    ],
    artifacts: [
      {
        name: "acceptance-runtime",
        expired: false,
        size_in_bytes: 1234,
        digest: `sha256:${"b".repeat(64)}`,
      },
    ],
  };
}

test("reuses the exact successful build while other CI checks are still running", () => {
  assert.equal(assertAcceptanceBuildOrigin(fixture(), expected), "123");
});

test("accepts the exact tagged Release's successful native amd64 producer", () => {
  const proof = fixture();
  proof.run.path = ".github/workflows/release.yml";
  proof.jobs = [{ name: "Backend amd64", conclusion: "success" }];
  assert.equal(assertAcceptanceBuildOrigin(proof, expected), "123");
});

test("rejects other repositories, commits, workflows and unfinished producers", () => {
  for (const mutate of [
    (proof) => {
      proof.run.head_sha = "c".repeat(40);
    },
    (proof) => {
      proof.run.repository.full_name = "another/repository";
    },
    (proof) => {
      proof.run.path = ".github/workflows/untrusted.yml";
    },
    (proof) => {
      proof.jobs[0].conclusion = "failure";
    },
    (proof) => {
      proof.jobs = [];
    },
  ]) {
    const proof = fixture();
    mutate(proof);
    assert.throws(() => assertAcceptanceBuildOrigin(proof, expected));
  }
});

test("rejects missing, expired or unverified artifacts", () => {
  for (const mutate of [
    (proof) => {
      proof.artifacts = [];
    },
    (proof) => {
      proof.artifacts[0].expired = true;
    },
    (proof) => {
      proof.artifacts[0].digest = "";
    },
    (proof) => {
      proof.artifacts[0].size_in_bytes = 0;
    },
  ]) {
    const proof = fixture();
    mutate(proof);
    assert.throws(() => assertAcceptanceBuildOrigin(proof, expected), /artifact/);
  }
});
