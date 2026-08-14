# Changelog

All user-visible changes are recorded here. AutoForge follows semantic versioning; release notes must
also list database migrations, persisted-configuration changes, compatibility changes, offline assets,
and known limitations.

## Unreleased

## 0.4.9 - 2026-08-14

### Added

- Add the standard Maven CoTest TestNG Adapter and embed its verified JAR into every backend image so
  Runner attempts can execute selected classes with an isolated class loader and project-level
  suite, test and environment-IP parameters.
- Add project versions and test stages, project-scoped Adapter configuration, and JDK plus dependency
  archive runtime assets supplied by upload or an integrity-pinned Runner-accessible HTTP(S) URL.
- Add resumable Runner log streaming through the existing acknowledged log-chunk protocol and an
  authenticated same-origin WebSocket relay for live attempt output in the platform.
- Add directory-based case navigation and project hierarchy management while keeping case execution
  and analysis history available from each case detail page.

### Changed

- Run Runner installation and attempt scripts with Bash, allow an administrator to force the
  openSUSE installation profile when operating-system detection is ambiguous, and execute the Agent
  from its configured working directory.
- Remove the separately published Java/TestNG Runner toolchain archives. Administrators now provide
  the exact JDK and complete test-dependency archive required by each project; the Agent verifies and
  unpacks those assets before starting the embedded Adapter.
- Reorganize the management center, operations/audit area and platform settings into route-backed
  tabs, replace the native project selector, and stabilize the case detail, audit and insights layouts
  at desktop and compact viewport widths.
- Preserve fast publication by keeping the tagged `Release` workflow independent from `Release
  checks`; only required Adapter, backend image, SBOM, manifest, signature and provenance failures
  block publication.

### Fixed

- Return resolved project hierarchy DTOs from the project structure API instead of serializing a
  pending repository promise.
- Preserve Runner log ordering and replay semantics while relaying live stdout/stderr updates, and
  keep class paths isolated between Adapter invocations with potentially conflicting dependency
  classes.

### Database migrations and compatibility

- Add PostgreSQL migration `0024_project_version_test_stage.sql` and SQLite migration
  `0025_project_version_test_stage.sql` for project versions, test stages, Adapter configuration,
  runtime assets and case hierarchy references. Existing cases are intentionally not migrated into
  the new project/version/stage hierarchy.
- Extend Runner Protocol v1 additively with Adapter execution and runtime-asset fields. Existing
  command assignments remain valid; upgraded Agents are required for CoTest Adapter assignments.

### Offline assets

- Rebuild all four immutable backend variants with the updated static amd64/arm64 Agents and embedded
  CoTest Adapter JAR, plus SPDX SBOMs, deployment bundle, signed checksums, release manifest and
  provenance for `0.4.9`. JDK and test dependency archives are intentionally project-managed inputs
  rather than Release assets.

### Known limitations

- Runtime-asset URL downloads require network reachability from the selected Runner; fully offline
  deployments should upload the JDK and dependency archives to the platform instead.
- Previously imported cases remain outside the new hierarchy by design and should be re-imported into
  an explicit project version and test stage.

## 0.4.8 - 2026-08-14

### Changed

- Remove the independent 5,000 TestNG test-class discovery ceiling while retaining bounded JAR size,
  archive entry, uncompressed byte and per-class byte limits.
- Treat cgroup v2 as an optional Runner capability: supported hosts keep full cgroup enforcement,
  while hosts without it remain schedulable with visible degraded-isolation status, rlimits,
  process-group cleanup, timeouts and workspace monitoring.
- Allow Runner Agent control-plane URLs to use HTTP for trusted internal IP connectivity and add an
  explicit installer option to run the systemd service as root. HTTPS and the dedicated non-root
  service account remain the recommended defaults.
- Normalize the retired `isolation:cgroup-v2` requirement out of persisted Runner Protocol v1
  execution specifications so assignments queued before upgrade can still be claimed.

### Fixed

- Use unambiguous accessible roles when asserting project-scoped execution environments in browser
  isolation coverage.
- Request a stable authenticated document after first-administrator bootstrap or login so upgrade
  acceptance can test older Releases that navigate with a public root document prefetched before the
  session cookie without racing the current Release's landing hand-off.
- Let manually dispatched Release checks use the selected branch's current acceptance harness while
  retaining tagged-source quality checks and immutable published assets.
- Wait for the real Agent's durable attempt state before simulating an abrupt restart in acceptance,
  preventing lease expiry from winning a harness-only race.
- Resolve the migration-integrity fixture from the packaged Web workspace so Release upgrade checks
  use the production pnpm dependency layout.

### Database migrations and compatibility

- No database migration or Runner Protocol schema-version change is required. HTTP and root mode
  weaken transport or host isolation and should be limited to dedicated trusted networks and hosts.

### Offline assets

- Rebuild all four immutable backend variants with the updated embedded amd64/arm64 Agents, both
  offline Java/TestNG Runner toolchains, SPDX SBOMs, deployment bundle, signed checksums, release
  manifest and provenance for `0.4.8`.

### Known limitations

- Without cgroup v2, CPU, memory and descendant-process counts do not have hard cgroup enforcement;
  HTTP and root Agent modes are intended only for dedicated trusted networks and hosts.

## 0.4.7 - 2026-08-14

### Changed

- Split tagged Release publication from quality and Gate E checks. The Release workflow now publishes
  as soon as all required platform assets, SBOMs, manifests, signatures and provenance are complete;
  the independent Release checks workflow preserves visible failures without blocking or withdrawing
  the published version.
- Start all four backend variants and both Runner toolchains immediately after tag validation, reuse
  per-variant BuildKit caches, avoid the signed-candidate artifact upload/download round trip and use
  parallel medium-level zstd compression for the offline Docker archives.
- Stop ordinary CI and dependency-security workflows from rerunning on tag pushes, leaving Release
  capacity to the publication and its two independent checks.
- Allow a Release workflow retry to update the same tag's existing draft or published assets
  idempotently.

### Database migrations and compatibility

- No SQLite or PostgreSQL migration, persisted configuration change or Runner Protocol change is
  included. Runtime compatibility is unchanged from `0.4.6`.

### Offline assets

- Rebuild the four immutable backend variants with embedded amd64/arm64 Agents, both offline
  Java/TestNG Runner toolchains, SPDX SBOMs, the deployment bundle, signed checksums, release manifest
  and provenance for `0.4.7`.
- Quality and Gate E failures remain visible on the tag but are post-publication signals; asset build,
  integrity, signing or manifest failures still prevent an incomplete Release from being published.

### Known limitations

- The first Release after enabling BuildKit caching has an empty cache; subsequent releases can reuse
  compatible layers. Actual duration still depends on GitHub-hosted runner and artifact service load.

## 0.4.6 - 2026-08-14

### Added

- Support bounded TestNG discovery from Java `*-sources.jar` archives, preserve per-class source
  references and show integrity-checked UTF-8 source content on the case detail page. Source-only cases
  are explicitly read-only and blocked from Agent execution; bytecode JAR imports remain executable.
- Add a visible management center with direct entries for users, roles, projects, LDAP, sessions,
  execution environments, secrets and platform configuration.
- Add real SSH protocol regression coverage for both Password and Keyboard-Interactive/PAM
  authentication, rejected credentials and Runner host prerequisite diagnostics.
- Add an account security self-service page: local users change their own password, review and
  terminate their own sessions, and accounts flagged for a mandatory password change are redirected
  until they comply; LDAP-managed users see a read-only explanation instead of a local password form.
- Generate the main navigation and management center entries from the caller's real RBAC permissions
  (`case.*`, `run.*`, `runner.*`, `environment.*`, `audit.*`, `settings.*`) instead of showing every
  entry to every signed-in user.
- Scope the case library, JAR import, file sources and case suite pages to an authorized project
  selected via URL filter, and block cross-project case/suite mixing in both UI and application
  services.
- Complete the user, project membership and role binding management UI: member listings, assigned
  role review and revocation, owner transfer, and impact confirmation for last-administrator and
  last-project-owner protections.
- Add a standalone audit page governed by `audit.read`/`audit.export` with actor, action, resource,
  result and UTC time filters, cursor pagination, per-event details and bounded CSV export.
- Complete the service account lifecycle UI: edit name, description, permissions and project scope,
  disable/restore accounts with impact hints, and mark tokens of disabled accounts as invalidated.
- Add a per-`ExecutionRun` cancel action with reason capture on the batch details page, alongside the
  existing whole-batch cancellation.
- Add an automation operations view listing all authorized schedules (enable/disable, last/next
  trigger, miss policy, related batches) and LDAP synchronization history (progress, checkpoint,
  processed/disabled counts, error summaries, retry).
- Extend the case version history with read-only snapshot details, adjacent or arbitrary version
  diffs, source information, related execution links and a pre-restore change summary.
- Add a maintained functional E2E coverage matrix (`tests/e2e/coverage-matrix.json`) validated in CI,
  and split browser coverage into isolated suites for identity/RBAC, project isolation, case suite
  lifecycle, execution recovery, management operations, platform operations and JAR import.
- Add acceptance suites that run only on GitHub Actions: real Go Runner Agent Lite/Full loop with the
  offline Java/TestNG toolchain, real offline LDAP directory flows, SSH-based Runner install and
  rollback, container executor isolation, Full dependency business recovery and release-asset offline
  upgrade acceptance.

### Changed

- Raise the new-install JAR upload default from 32 MiB to 256 MiB and present the persisted 1–256 MiB
  limit as an administrator-friendly setting instead of a raw byte count. Existing installations keep
  their configured value until an administrator changes it and restarts Web and worker.
- Gate the Release workflow's publish step behind an offline-acceptance job that verifies signatures,
  checksums, SBOMs and licenses, installs from the immutable assets without outbound network, runs the
  core business loop with the embedded Agent, and exercises upgrade, failed-migration rejection and
  rollback from the previous stable release.

### Fixed

- Exclude the deployment-specific public-statistics refresh interval from Release backup/restore
  comparisons while continuing to require every persisted business count and rate to match.
- Compare stable persisted business statistics after Release backup/restore instead of requiring the
  regenerated observation timestamp and time-window Runner presence fields to remain byte-identical.
- Route the immutable Release fixture's real Agent connection through a host-loopback TCP proxy, so
  offline container acceptance retains the Agent's HTTPS-or-loopback transport policy.
- Generate analytics export idempotency keys with the Web Crypto primitive available on remote HTTP
  origins, where the secure-context-only `crypto.randomUUID()` API is unavailable.
- Give each Release acceptance Runner registration a short-lived token derived from the fixture master
  key instead of reusing the persisted one-time bootstrap token across browser suites.
- Create the immutable Release acceptance data directory as the non-root runner before mounting it
  into the migration container, preserving the production image's non-root write-permission check.
- Pin the production PostCSS dependency chain to `nanoid` 3.3.18, the first patched 3.x release for
  `GHSA-2v37-7h3g-55p8`, and keep the version locked for offline builds and SBOM generation.
- Initialize the immutable Release acceptance fixture with a bounded aggregate login allowance so its
  deliberate account-lock checks do not exhaust the shared container-address limiter; production
  installations retain the secure default of 10 login attempts per 15-minute window.
- Reload the server-rendered root layout after login, initial administrator creation and logout so the
  authenticated home page always remains inside the same navigation shell as the other console pages.
- Keep API uploads outside the Next.js page proxy's 10 MiB request-body limit, bound both declared and
  chunked multipart bodies at the configured JAR limit, return HTTP 413 for oversized uploads and map
  malformed or invalid JAR input to stable client errors instead of 500 responses.
- Support Runner hosts whose OpenSSH/PAM password flow is exposed through Keyboard-Interactive rather
  than the legacy password method, and allow host probing before the Agent control-plane URL is set.
- Distinguish SSH authentication, DNS, refused connection, timeout and handshake failures, and report
  missing systemd, cgroup v2 or sudo prerequisites with actionable messages.

### Database migrations and compatibility

- SQLite migration `0024` and PostgreSQL migration `0023` backfill every immutable `CaseVersion` with
  its owning source, add the required source foreign key and index, and prevent deletion of a source
  still referenced by version history.
- Persisted platform configuration schema v1 and Runner Protocol v1 remain unchanged. Control plane
  `0.4.x` accepts protocol-compatible `0.3.x` Agents subject to capability checks, although upgrading
  to the Agent embedded in the control-plane image is recommended.
- Existing JAR upload limits are preserved during upgrade; the 256 MiB default applies only to new
  installations until an administrator explicitly changes and restarts an existing deployment.

### Offline assets

- Rebuild the four immutable backend variants with embedded amd64/arm64 Agents, both offline
  Java/TestNG Runner toolchains, SPDX SBOMs, the deployment bundle, signed checksums, release manifest
  and provenance for `0.4.6`.
- No new runtime CDN, telemetry service or automatically downloaded dependency is introduced.
- The signed `v0.4.0` through `v0.4.5` candidates did not pass Gate E and were not published;
  `v0.4.6` rebuilds the full immutable asset set from the corrected acceptance revision.

### Known limitations

- The process executor remains a constrained process boundary rather than a complete sandbox; the
  optional container executor requires a locally installed OCI runtime and pinned policy.
- Direct terminal sessions require load-balancer affinity to the Web replica that issued the ticket.
- The management UI targets desktop screens. Browser/driver toolchains remain administrator-supplied
  offline resources and are never downloaded at runtime.
- Database downgrade is unsupported after the new case-version source migrations; rollback requires
  restoring the matching pre-upgrade database and object backup with the previous immutable image.

## 0.3.4 - 2026-08-12

### Fixed

- Preserve administrator bootstrap and login sessions when the production server is accessed directly
  over HTTP by deriving the session cookie's `Secure` attribute from the external request protocol;
  HTTPS reverse-proxy requests remain protected with secure cookies.
- Keep form focus indication on the active input, select or text area instead of drawing a second large
  outline around the entire label container.

### Database migrations and compatibility

- No SQLite or PostgreSQL migration is added by this release.
- Persisted platform configuration schema v1, Runner Protocol v1 and embedded Agent compatibility are
  unchanged from `0.3.3`; the existing `0.3.x` compatibility matrix remains authoritative.

### Offline assets

- Rebuild the four immutable backend variants and their embedded amd64/arm64 Agent resources, SPDX
  SBOMs, deployment bundle, signed checksums, release manifest and provenance for `0.3.4`.

### Known limitations

- The process executor remains a constrained process boundary rather than a complete sandbox; the
  optional container executor still requires a locally installed OCI runtime and pinned policy.
- Direct terminal sessions still require load-balancer affinity to the Web replica that issued the
  ticket.
- The management UI targets desktop screens; JDK/TestNG/browser toolchains must still be assembled
  from approved offline artifacts and are never downloaded at runtime.

## 0.3.3 - 2026-08-12

### Added

- Added an offline-bundled AutoForge application icon without introducing a remote asset dependency.
- Added automated visual consistency coverage across the public dashboard, setup, case, task, object,
  execution, Runner and settings workflows, including desktop overflow, zoom, readable text and control
  target checks.

### Changed

- Unified page surfaces, typography, spacing, controls, settings navigation, execution-environment and
  secret-management workspaces through shared semantic visual tokens and layout styles.
- Raised explicit interface text to a 12 px minimum, increased compact action targets to at least 32 px
  and refined the first-start headline and desktop scaling for clearer hierarchy.

### Fixed

- Replaced legacy button and color-token references that could render inconsistent forbidden, import and
  run-history controls.
- Stabilized the browser layout audit after zoom restoration and kept the authenticated session available
  until the secondary Full replica readiness check completes.

### Database migrations and compatibility

- No SQLite or PostgreSQL migration is added by this release.
- Persisted platform configuration schema v1, Runner Protocol v1 and embedded Agent compatibility are
  unchanged from `0.3.2`; the existing `0.3.x` compatibility matrix remains authoritative.

### Offline assets

- Rebuild the four immutable backend variants and their embedded amd64/arm64 Agent resources, SPDX
  SBOMs, deployment bundle, signed checksums, release manifest and provenance for `0.3.3`.

### Known limitations

- The process executor remains a constrained process boundary rather than a complete sandbox; the
  optional container executor still requires a locally installed OCI runtime and pinned policy.
- Direct terminal sessions still require load-balancer affinity to the Web replica that issued the
  ticket.
- The management UI targets desktop screens; JDK/TestNG/browser toolchains must still be assembled
  from approved offline artifacts and are never downloaded at runtime.

## 0.3.2 - 2026-08-11

### Changed

- Redesigned the first-start experience as a two-step deployment and administrator setup flow with
  clearer Lite/Full guidance, offline/security context and desktop layout.
- Routed all Web buttons, text/number/file/choice inputs, text areas and select controls through shared
  UI components, including consistent focus, disabled and scrollbar styling.

### Fixed

- Preserve and display field-specific validation details during platform and administrator bootstrap
  instead of reducing invalid usernames, passwords, tokens or URLs to a generic request error.
- Validate bootstrap forms before sending requests and document the accepted username and credential
  formats next to their fields.

### Database migrations and compatibility

- No SQLite or PostgreSQL migration is added by this release.
- Persisted platform configuration schema v1, Runner Protocol v1 and embedded Agent compatibility are
  unchanged from `0.3.1`.

### Offline assets

- Rebuild the four immutable backend variants and their embedded amd64/arm64 Agent resources, SPDX
  SBOMs, deployment bundle, signed checksums, release manifest and provenance for `0.3.2`.

### Known limitations

- The process executor remains a constrained process boundary rather than a complete sandbox; the
  optional container executor still requires a locally installed OCI runtime and pinned policy.
- Direct terminal sessions still require load-balancer affinity to the Web replica that issued the
  ticket.
- The management UI targets desktop screens; JDK/TestNG/browser toolchains must still be assembled
  from approved offline artifacts and are never downloaded at runtime.

## 0.3.1 - 2026-08-11

### Added

- Persisted first-start and administrator-managed platform configuration; application settings are no
  longer supplied through environment variables.
- Public live statistics dashboard and desktop-responsive management pages.
- Internal Linux amd64/arm64 Runner Agent resources with SSH installation for Ubuntu and openSUSE.
- Service accounts/API tokens, scheduled suites, notifications, global search, retention operations,
  analytics and asynchronous bounded analytics exports.
- Background JAR imports with progress, cancellation, diagnostics and retry.
- Optional constrained OCI container executor and Agent liveness/readiness commands.
- Offline backup, restore, migration preflight and Runner toolchain packaging helpers.

### Changed

- GitHub Releases publish four backend image variants with embedded Agent resources and no standalone
  Agent binaries.
- JAR and execution-artifact object keys are explicitly scoped by project.

### Fixed

- Package the production workspace dependencies required by the custom Next.js server and verify the
  database migration entry point inside every release image.

### Database migrations

- SQLite `0015`–`0022`; PostgreSQL `0014`–`0021` add product completion, Runner credential lifecycle,
  execution policy, source comparison metadata, schedule claims, LDAP sync claims, JAR import jobs and
  analytics export jobs.

### Known limitations

- The process executor is not a complete sandbox. The optional container executor depends on a locally
  installed OCI runtime and an administrator-pinned image/seccomp profile.
- Direct terminal sessions require load-balancer affinity to the Web replica that issued the ticket.
- Browser/mobile layouts are not supported; the UI targets desktop screens and narrow desktop windows.
- JDK/TestNG/browser toolchains must be assembled from approved offline artifacts; AutoForge and Agent
  never download them at runtime.
