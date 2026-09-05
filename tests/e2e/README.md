# AutoForge E2E coverage matrix

`coverage-matrix.json` is the machine-readable source of truth for M11 browser and production acceptance coverage. A row is only `covered` when its evidence enters through the real user, Agent, or operations boundary and observes the final business result. Unit tests, direct repository calls, readiness-only probes, and a Playwright process impersonating Runner Agent may remain useful evidence, but are marked `partial`.

The suite is divided by failure domain so each scenario can run alone with an isolated platform data directory:

| Owner                     | Entrypoint                                               | Scope                                                                                                   |
| ------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `functional-matrix`       | `node scripts/quality/validate-e2e-matrix.mjs`           | Matrix completeness and evidence integrity                                                              |
| `identity-rbac`           | `playwright test tests/e2e/identity-rbac.spec.ts`        | Local identity, forced password, sessions and RBAC                                                      |
| `case-suite-lifecycle`    | `playwright test tests/e2e/case-suite-lifecycle.spec.ts` | Case/source/suite versioning, conflict, policy and archive lifecycle                                    |
| `asset-lifecycle`         | `playwright test tests/e2e/jar-import.spec.ts`           | Current legacy asset/control-plane execution flow; split further as coverage grows                      |
| `single-case-run`         | `playwright test tests/e2e/single-case-run.spec.ts`      | Global execution dialog, Runner Group selection, single-case scheduling and Adapter address propagation |
| `ui-layout`               | `playwright test tests/e2e/ui-layout.spec.ts`            | 1024px+ layout guards, global project context, full-viewport dialogs and review screenshots             |
| `scheduling-refill`       | `playwright test tests/e2e/scheduling-refill.spec.ts`    | Immediate slot refill, overlapping retry and idempotent completion replay                               |
| `round-summary`           | `playwright test tests/e2e/all-rounds.spec.ts`           | Final summary, running-case filter, parallel Jenkins recovery timeline and fixed-layout geometry        |
| `runner-real-lite`        | `scripts/quality/test-real-agent.sh`                     | Release-built Go Agent, offline Java/TestNG and real PTY lifecycle in Lite                              |
| `batch-input-sharing`     | `scripts/quality/test-batch-input-sharing.sh`            | Real Agent JAR/JDK reuse across refill/restart and terminal cleanup                                     |
| `ldap-real`               | `scripts/quality/test-ldap-e2e.sh`                       | Private-CA LDAPS and plain LDAP URL-driven authentication in an internal container network              |
| `runner-ssh-install`      | `scripts/quality/test-runner-install-e2e.sh`             | Password/PAM SSH, encrypted connection profiles, batch update and real systemd                          |
| `container-executor`      | `scripts/quality/test-container-executor.sh`             | Immutable offline executor image, isolation and cancellation cleanup                                    |
| `platform-retention`      | `playwright test tests/e2e/platform-operations.spec.ts`  | Configuration conflicts, diagnostics and retention previews                                             |
| `full-business-recovery`  | `scripts/quality/test-full-business-recovery.sh`         | Fault injection during active Full business stages                                                      |
| `full-distributed`        | `pnpm test:distributed`                                  | Two platforms behind Nginx, shared login, node address management, authenticated owner-local logs and replay rejection |
| `release-offline-upgrade` | `scripts/quality/test-release-offline.sh`                | Signed immutable release, disconnected install, upgrade and rollback                                    |

Entrypoints that are not yet present remain `planned` in the JSON and must not be described as passing. High-CPU and privileged entrypoints run only in GitHub Actions. Local development is limited to formatting, static validation and explicitly selected lightweight tests. `pnpm test:distributed` is also available locally with Docker and a preinstalled Chromium. Its log fixture verifies peer transport and browser access; it does not replace real Runner Agent business recovery acceptance.
