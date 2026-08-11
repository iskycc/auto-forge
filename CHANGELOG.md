# Changelog

All user-visible changes are recorded here. AutoForge follows semantic versioning; release notes must
also list database migrations, persisted-configuration changes, compatibility changes, offline assets,
and known limitations.

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
