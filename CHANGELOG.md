# Changelog

All user-visible changes are recorded here. AutoForge follows semantic versioning; release notes must
also list database migrations, persisted-configuration changes, compatibility changes, offline assets,
and known limitations.

## 0.6.6 - 2026-08-18

### Fixed

- All-rounds virtual round layout: the panel reused the two-column `round-detail-body` grid whose
  first column is reserved for the donut charts, so the case table was squeezed into a ~320px
  column — the 轮次 cell wrapped vertically and the status/runner/duration/action columns were
  clipped. The all-rounds panel now renders the table full width and the 轮次 cell is
  `nowrap`. A new end-to-end spec (`tests/e2e/all-rounds.spec.ts`) drives a real two-round batch
  through the Runner Protocol and asserts the per-round annotations, the status filters, the
  “previously passed cases disappear from later rounds” behaviour, the `scope=all` export, and a
  table-width layout regression check.

### Compatibility

- Style/test-only change on top of 0.6.5; no migrations, configuration, or API changes.

## 0.6.5 - 2026-08-18

### Features

- Batch details gains an “全部轮次” virtual round (`?round=all`): every attempt of every case is
  listed as its own row with a 轮次 column, so cases with records in several rounds are explicitly
  annotated. The view supports the existing status filter, name search, sorting, pagination, log
  viewing, and inline details, and its export dialog defaults to the new export scope.
- New result-export scope `all` (“全部轮次，逐条记录，标注轮次”): the Excel workbook contains one
  row per terminal attempt across all rounds with a leading 轮次 column and a
  `...-all-rounds.xlsx` filename. The previous “全部轮次（每个用例最终结果）” option is renamed
  “最终结果”; never-executed cases remain excluded, consistent with the existing scopes.

### Fixed

- Later rounds no longer list cases that already passed in an earlier round as “未执行”: per the
  scheduling semantics those cases never re-enter subsequent rounds, so the per-round case table
  now filters them out and only shows cases genuinely waiting for the selected round.
- JAR import scan preview and the case-source persisted preview no longer degrade into a long
  strip of blank-looking rows for large imports: above 100 test classes the list is replaced by a
  count summary pointing at the scan warnings (import progress still comes from the background
  job status), and duplicate `className` candidates are de-duplicated before rendering to avoid
  duplicate React keys.

### Compatibility

- No migrations, no persisted-configuration changes. The export API gains `scope=all` as an
  additive value; existing `round`/`final` exports are unchanged.

## 0.6.4 - 2026-08-18

### Changed

- The public log-access page (`/share/attempt-log/...`) is now fully dark themed: the page
  previously mixed a white chrome with the dark log panel, which was straining to read. The
  page overrides the semantic color tokens (canvas, surfaces, text, borders, status colors,
  shadows) locally, so the info card, status badges, truncation warning, and the
  invalid-link view all follow the same dark palette as the log output. No markup or API
  changes.

### Compatibility

- Style-only change; no migrations, configuration, or API changes.

## 0.6.3 - 2026-08-18

### Features

- Execution-records page size selection: the filter form gains a “每页条数” dropdown with
  10 / 50 / 100 / 500 options (URL `limit` parameter; unsupported values fall back to 50).
  The page-size choice survives pagination and refresh links, which keep `limit` and `cursor`
  in the query.
- Runner names on the batch details page: the case-table runner column, the 执行机 sub-tab
  card headings, and the scheduling-log viewer title now show the registered runner name
  (typically `runner-<ip>`) instead of a bare UUID prefix. The full UUID remains in the
  tooltip; runners that cannot be resolved (no `runner.read` permission, purged runners)
  fall back to the UUID short code. The directory is loaded server-side under `runner.read`
  and never leaks the runner list to accounts without that permission.
- Runner cards in the 执行机 sub-tab now show the latest resource snapshot
  (`CPU x% · 内存 y% · 负载/CPU z`, load normalized per core, collection time in the
  tooltip, same format as the runners page). Active batches already refresh server data
  every 5 seconds, so the snapshot stays current while a batch runs; “暂无资源快照” is
  shown before the first heartbeat reports metrics.

### Fixed

- 0.6.2 regression: `AGENT_RESTARTED_DURING_EXECUTION` disappeared from the batch details
  page (the failure-summary enrichment replaced the agent-reported summary with a heuristic
  log line, and the status column then preferred the summary over the reason code).
  Reconcile-replayed completions (`AGENT_RESTARTED_DURING_EXECUTION`,
  `EXECUTION_CANCELLED_DURING_RECONCILE`) no longer undergo log-tail summary enrichment —
  their logs belong to the killed process — and the case-table failure hint now follows the
  blocked taxonomy: normal adapter failures keep the stack-line summary, blocked terminations
  (restart, timeout, adapter never started, …) show the reason code.

### Compatibility

- No migrations, no persisted-configuration changes, no API field changes; upgrades are
  drop-in.

## 0.6.2 - 2026-08-18

### Features

- Global artifact-collection switch: a new platform setting `limits.artifactCollectionEnabled`
  (default `true`, editable in 平台设置 as “启用产物收集”). When disabled, execution specs are
  generated without artifact rules, so the Runner Agent skips artifact scanning and upload entirely
  (no agent change — it only scans when rules are present), and the batch details page no longer
  renders or fetches the artifacts block. The switch applies to batches created after saving;
  already-scheduled batches keep the spec they were created with.
- Natural-incrementing batch display numbers: `run_batches` gains a `sequence_number` column
  (migrations `sqlite/0031`, `postgresql/0030`; existing rows backfilled densely in
  `(created_at, id)` creation order). The execution-records table now shows the full `#N` instead
  of a truncated UUID, the batch details hero shows `批次 #N` (UUID in the tooltip), and the
  public log-access page shows `批次 #N`. UUIDs remain the authoritative identifiers everywhere
  (URLs, Runner Protocol, foreign keys, dedup keys); list ordering/cursors are unchanged.

### Changed

- Failure summaries show the concrete stack line instead of result codes or class-path prefixes.
  When the completion log tail contains the adapter failure marker
  (`TestCase Run Failed Stack: [...]`) — or, without structured results, a heuristic exception
  line — the attempt summary is replaced by that line rather than concatenated as
  `类路径#方法 | 堆栈`. This affects the batch details status column (which now renders the
  summary instead of codes like `TESTNG_ASSERTIONS_FAILED`, falling back to the code only when no
  summary exists), the public log-access page “错误描述”, and the exported spreadsheet error
  column. The `类#方法 执行失败` placeholder remains as fallback when no stack line is found.

### Compatibility

- Persisted configuration gains `limits.artifactCollectionEnabled`; older configuration files
  parse with the default `true`, keeping current behavior.
- Batch API responses and the shared log view gain `sequenceNumber` / `batchSequenceNumber`
  fields (additive only).

## 0.6.1 - 2026-08-18

### Fixed

- Artifact collection no longer fails a test attempt. After an execution finishes (logs already
  collected), the Runner Agent scans the attempt workspace for files matching the execution spec's
  artifact rules — by default the TestNG report tree `reports/testng/**` — and uploads them as
  downloadable artifacts. Previously any matched symbolic link or special file, more than 256
  matched files, or a size/byte-budget breach rejected the whole scan and overrode the attempt's
  real result with `ARTIFACT_DISCOVERY_REJECTED`, so a passed case could be reported as failed.
  The scan is now best-effort: uncollectable files are skipped (symbolic links are never followed
  or read), healthy files are still collected, and the attempt result stays authoritative — it is
  determined by the parsed TestNG report and the process exit code. Only a missing `required: true`
  artifact still fails the attempt (`REQUIRED_ARTIFACT_MISSING`). Case result classification,
  scheduling semantics and custom artifact rules (for example `artifacts/*.txt`) are unchanged.

## 0.6.0 - 2026-08-18

### Features

- Case execution timeout, managed by the adapter itself: a new platform setting
  `limits.caseExecutionTimeoutSeconds` (default 600s, editable in 平台设置 as
  “用例执行超时（秒）”) flows through `executionSpec.adapter.caseTimeoutSeconds` into a new
  optional CoTest adapter CLI flag `--case-timeout-seconds`. The adapter runs TestNG on a daemon
  worker thread with a bounded wait; when the case exceeds the limit it prints the machine-readable
  marker `TestCase Execution Timeout: ...` and exits with code 3 (exit-code contract: 0 success,
  1 failure/adapter error, 2 argument error, 3 case timeout). The Runner Agent maps exit code 3 to
  `timed_out` with the new result code `ADAPTER_CASE_TIMEOUT`, which stays authoritative even if a
  partial TestNG report exists. Omitting the flag keeps the adapter's own 600s default, so older
  control planes remain compatible; the agent and adapter ship together in the agent resources,
  so the new flag never reaches an adapter build that predates it.

### Changed

- Blocked redefined per the operational rule “any non-normal exit is blocked”: only adapter-normal
  success (`TESTNG_SUCCEEDED`, `TESTNG_SUCCEEDED_WITH_SKIPS`, `TESTNG_ALL_SKIPPED`, legacy
  `PASSED`) and adapter-normal failure (`TESTNG_ASSERTIONS_FAILED`,
  `TESTNG_CONFIGURATION_FAILED`, legacy `TEST_ASSERTION_FAILED`) result codes count as
  succeeded/failed; every other terminal outcome — timeout kills (including
  `ADAPTER_CASE_TIMEOUT`), cancellations, adapter never started or crashed, log-limit breaches,
  unknown or missing result codes — is classified blocked via a whitelist
  (`packages/domain/src/attempt-result.ts`). The new classification drives the case-list
  selection statistics (总数/成功/失败/阻塞 with success/failure/blocked rates), the case-list
  “最近执行结果” filter and badges (超时/取消 latest runs now render as 最近阻塞), the quality
  insights project/version case-outcome report, and the Excel export.
- Export semantics follow the new blocked rule: rows always come from a real attempt — cases that
  never executed have no terminal result and are no longer exported (they used to appear as
  “阻塞（未执行）” rows with empty timestamps); use the round table or the 未执行 case filter to
  list them. The `timed_out`/`cancelled` export filters remain as narrow aliases of blocked
  (timeout-family vs cancellation-family result codes), the blocked option is now labeled
  “阻塞（异常结束）”, and the default checked outcomes changed from 失败+超时 to 失败+阻塞 so a
  first export covers every non-normal exit.
- Batch round table column 阻塞数 renamed to 未执行数: it counts runs still held by that round
  (scheduling semantics) and is a different concept from the result-classification blocked above.

### Fixed

- Access management (用户管理/会话管理) rendered timestamps with locale-dependent
  `toLocaleString()`, producing a React hydration mismatch whenever the server locale differed
  from the browser locale. Under load the hydration rebuild could replace a half-filled form input
  and swallow the create-user submit. All affected timestamp cells now use the locale-pinned
  `formatLocalDateTime` shared by the rest of the UI.

### Compatibility

- Persisted platform configuration gains `limits.caseExecutionTimeoutSeconds`; missing values in
  older configuration files fall back to 600s on load (no migration).
- Execution specs gain `adapter.caseTimeoutSeconds` (optional, defaults to 600 when absent), an
  additive contract change; agents older than this release keep running without the flag.

## 0.5.0 - 2026-08-18

### Features

- Run batch detail: each round panel now offers 导出结果, exporting that round's (or every round's
  final) case results to Excel. Columns are 用例路径、名称、执行结果、错误描述（一行堆栈，仅失败/超时）、
  执行开始时间、执行结束时间、执行耗时(s)、日志链接. The 日志链接 column points at a new
  login-free log public-access page `/share/attempt-log/[token]` that renders the adapter's full
  execution log with the same keyword highlighting as the in-app log viewer; tokens are random
  32-byte values of which only the SHA-256 hash is stored. Links are **permanent**: the
  `expires_at` column keeps its NOT NULL contract and new records carry the sentinel expiry
  `9999-12-31T23:59:59.999Z`, replacing the former 30-day TTL (records signed by older releases
  expire naturally and are replaced by permanent links on re-export). Blocked (not-yet-executed)
  cases export without timestamps or links. Export performance is sized for 50k+ rows within one
  minute: link issuance runs through a batched existence-check / lookup / single-transaction
  `createMany` path and the workbook is streamed (measured ~11s for 50,000 rows in the performance
  suite).
  - Migrations: `sqlite/0030_attempt_log_shares.sql`, `postgresql/0029_attempt_log_shares.sql`
    (new `attempt_log_shares` table, cascade-deleted with attempts/batches).
  - API: `GET /api/v1/run-batches/[batchId]/export?scope=round|final&round=<n>&outcomes=...`
    (auth + `run.read`; returns the xlsx attachment; errors use stable codes BATCH_NOT_FOUND /
    INVALID_SCOPE / INVALID_ROUND / INVALID_OUTCOMES), plus
    `POST /api/v1/run-attempts/[attemptId]/log-share` for issuing a single public-access link
    from the batch detail page (audited as `attempt_log.share`).
  - Known limitation: permanent links have no revocation channel; deleting the attempt/batch
    (cascade) is currently the only way to retire one. There is no manual revocation UI yet.
- Case management list: cases can be filtered by their latest terminal run outcome
  (成功 / 失败（含超时与取消）/ 从未执行), and selecting cases shows aggregate statistics —
  总数、成功数、失败数、阻塞率（未执行占比）— in the selection toolbar.
- Quality insights: a new 项目 / 版本用例执行情况 report lists every case of the chosen project
  version with its latest outcome and execution time, bounded to 500 detail rows.
- Runner Agent data directory: the SSH installer and the post-install update flow both accept a
  custom absolute working directory (default remains `/var/lib/autoforge-agent`); the installer
  validates the path (absolute, no `..`) and the 8th script argument stays optional, so older
  control planes that omit it keep the default. Updating without a directory reads the remote
  config back and keeps the current value. Existing data under the old directory is not migrated.
- Execution records page: every column can be resized by dragging; widths persist per browser in
  localStorage (`autoforge.execution-records.column-widths.v1`) with per-column minimums, and
  batch details open through a dedicated 详情 button instead of clicking the batch id.
- Run batch detail: rows no longer auto-expand; page size is selectable up to 500 with a
  single-load per-attempt detail cache (artifacts/events are fetched once per session), a refresh
  button, name/status/runner/duration sorting, and a 公开日志 button on finished attempts that
  opens the permanent public log page in a new tab.
- Layout: page content width now follows the viewport — `clamp(1540px, 90vw, 2160px)` for
  `.page-stack` and `clamp(1280px, 82vw, 1920px)` for the case detail page — so large screens use
  their space while viewports below the old caps render exactly as before; mobile breakpoints are
  untouched.

### Fixed

- Case suite detail page: the 离线计划触发 enable checkbox no longer clips against the card edge; it
  now sits in the schedule actions row instead of a squeezed fourth grid column, so the label stays
  fully visible at any viewport width and with any platform CJK font.
- Sidebar navigation: opening a run batch detail (`/run-batches/[id]`) now keeps 执行记录 active
  instead of jumping to 用例批跑, matching the detail page's 返回执行记录 back link.

## 0.4.18 - 2026-08-17

### Fixed

- Scheduling logs (both the batch-wide 调度日志 and the per-runner log) now explain failures that
  happen outside the test case itself. Completion events for failed/timed-out attempts include the
  result code and a compact single-line failure summary (for example
  `ARTIFACT_DISCOVERY_REJECTED：discover artifacts: ...`) directly in the event message, and the
  recovery sweep now writes scheduling events for attempts reclaimed after lease expiry, execution
  timeout, upload/completion timeout, or assignment claim timeout, so a dropped or offline runner no
  longer leaves the schedule log silent.

## 0.4.17 - 2026-08-17

### Fixed

- Runner artifact discovery no longer fails the whole attempt when the workspace contains symbolic
  links or special files that match no artifact rule (for example the in-bounds symlinks inside an
  extracted JDK `legal/` directory). Only symlinks or non-regular files matched by an artifact
  pattern are still rejected, which keeps the upload safety contract; unmatched entries are skipped.
  Previously a successful test run could be reported as failed with
  `discover artifacts: artifact scan rejected symbolic link ...`.

## 0.4.16 - 2026-08-17

### Fixed

- TestNG adapter exit code no longer derives from TestNG's raw status bitmap, which includes the
  skip bit: executions with skipped-but-no-failed tests exited 1 and were reported as failed even
  though the case log showed success. The adapter now fails the process only when failed or
  configuration-failure counts are non-zero; skipped-only executions are classified from
  `testng-results.xml` as succeeded (all-skipped / with-skips). The raw status bitmap is still
  printed to the case log for diagnostics.
- Run batch detail round case table now shows the terminal result code (for example
  `AGENT_RESTARTED_DURING_EXECUTION` or `TESTNG_ASSERTIONS_FAILED`) directly under the status badge,
  so scheduling-level failures are visible without expanding the row; this also restores the
  real-Agent acceptance expectation that the restart reason is visible on the batch page.

## 0.4.15 - 2026-08-17

### Added

- Case library bulk import by table: the 用例管理 page now offers an 导入用例 dialog that
  accepts a single-column 用例路径 table from a .csv/.tsv/.txt file or pasted text (one path
  per line, optional header), parses and previews exact path matches against the case library
  (including an unmatched-path report), and checks all matched cases in one action. Paths are
  accepted in both directory form (`com/example/CheckoutTest`) and dotted class-name form
  (`com.example.CheckoutTest`). Matching runs entirely in the browser; no server API changes.

### Changed

- Run batch detail page redesigned around retry rounds: a metrics band (status, overall pass rate,
  case counts, start time, ticking elapsed time, current round) followed by a rounds table with
  per-round status, totals, pass rates (round and cumulative), passed/failed/blocked counts, start
  time and duration. Selecting a round (persisted in the `?round=` URL parameter) opens a detail
  panel with self-drawn SVG donut charts (round outcome distribution and cumulative pass progress),
  a filterable paginated case table with per-case live log viewer and inline TestNG/artifact/event
  details, a per-runner tab with runner scheduling log access, and an overall scheduling log
  button. Active batches refresh every 5 seconds.

### Fixed

- Failed attempt summaries now use the adapter's machine-readable marker line
  (`TestCase Run Failed Stack: [...]`, content equals the first line after `Stack Trace:` in the
  adapter report, i.e. `exception class: message`) instead of a heuristic scan for the last
  exception-like line in the log tail, which could pick up unrelated later lines such as
  `Exception in thread "main" ...`. The marker is appended even when a structured TestNG summary
  exists; the log-tail heuristic remains as fallback when no marker is present.
- Run batch detail page no longer overflows horizontally at narrow widths: the detail layout's
  single grid column now allows shrinking (`minmax(0, 1fr)`), so wide round/case tables scroll
  inside their own containers instead of stretching the page.

## 0.4.14 - 2026-08-17

### Changed

- Sidebar information architecture: the workbench entry is renamed to 工作概览, and 文件来源 moves
  from the top level into the 执行与平台 management group. The dashboard bento cards now use a
  uniform 3×2 equal-width grid (and equal two-column widths on medium screens) instead of mixed
  5/4/3 column spans.

### Fixed

- Runner agent workspace preparation now accepts in-bounds relative symlinks in JDK tar archives
  (some JDK repacks use symlinks instead of hard links for duplicated legal files); absolute or
  escaping symlink targets are still rejected, and the forbidden-type error now reports the actual
  tar entry type to make future archive incompatibilities diagnosable.
- Run batch detail page: the attempt selector in the output section no longer stretches across the
  full width (the width rule targeted the hidden native control instead of the drawn select), and
  terminal attempts no longer open a live log stream or show a stale "updating live" badge.
- Case suite detail page: the schedule form's enable checkbox renders as a single row aligned with
  the other controls, and the copy-as-new-suite row uses the same field styling as the rest of the
  form. The `--shadow-elevated` design token is now declared in `:root`.

## 0.4.13 - 2026-08-17

### Added

- One-click in-place runner agent updates: the runners page marks nodes whose agent is older than
  the bundled build and offers an update dialog (SSH probe, fingerprint confirmation, backup and
  rollback via the existing installer chain) that keeps the runner identity, credentials,
  configuration and execution history. Deregistered runners cannot be updated in place.

### Fixed

- Runners without the `isolation:cgroup-v2` capability (for example openSUSE nodes without cgroup
  v2 delegation) are no longer rejected by execution preflight; the agent executes with its
  documented degraded isolation (rlimits, process-group cleanup, timeouts) instead.
- The runner agent now extracts hard link entries from JDK tar.gz archives instead of rejecting
  them as forbidden types; OpenJDK distributions reuse duplicated legal files via hard links, so
  JDK workspace preparation failed on those archives. Link targets must stay inside the attempt
  workspace and must already be extracted.

## 0.4.12 - 2026-08-17

### Added

- Deregistered runners can now be deleted from the runners page: a tombstone purge clears the
  credential permanently, removes the record from listings, keeps historical execution references,
  and writes an audit event. Deleting a runner that has not been deregistered is rejected.

### Changed

- JDK and dependency JAR archive uploads are staged inside the platform data directory
  (`upload-staging/`) instead of the OS temp dir, so uploads no longer fail with ENOSPC on hosts
  where /tmp is a small tmpfs; a full data disk now returns an explicit storage error (HTTP 507).

### Database

- SQLite migration 0029 and PostgreSQL migration 0028 add the `runners.purged_at` column.

## 0.4.11 - 2026-08-17

### Added

- Introduce a dedicated execution records page: every batch is listed with suite/test name,
  status, pass rate, passed/failed counts, current round, retry mode, runner count, creation
  time and duration, with the project/suite/status/runner/time filters moved there from the
  batch planner page.
- Add a selectable round-based retry mode alongside immediate retry: failed runs can now wait
  for the next round so the whole suite re-runs together, with the current round tracked on the
  batch and shown in records and batch details.
- Split execution logs into three scoped terminal-style viewers: batch scheduling log with
  per-round assignments and low-frequency runner resource snapshots, per-runner scheduling log,
  and the per-attempt stdout/stderr/agent output log.
- Add the java-cases fixture module plus a full E2E pipeline covering JAR import, task creation,
  case selection, runner assignment, execution and log/artifact verification, including a
  concurrent multi-attempt log isolation check.

### Changed

- Store attempt log chunks in a per-batch SQLite file (`attempt-logs/<batch>.sqlite`) instead of
  the primary database in both lite and full modes; the primary database now keeps only the file
  path, run results and the failure summary, so heavy log volume can no longer pressure the main
  store. Retention and batch deletion remove the log file.
- Enrich failure summaries with the last exception or stack line from the attempt log tail when
  no structured TestNG report exists, and show that line directly in the batch runs table.
- Regroup the sidebar administration entries into collapsible two-level groups （项目与权限 /
  执行与平台） collapsed by default, rename 用例库 to 用例管理 and LDAP 目录 to 目录配置， and move
  运维审计 under administration.
- Replace native selects, date-time inputs and related form controls with shared self-drawn UI
  components across the app.

### Fixed

- Restore exact-text matching for the run result code by rendering it in its own element, and
  keep navigation group expansion robust across the post-login second page load.

### Database migrations

- SQLite: `0026_retry_mode_round`, `0027_scheduling_events`, `0028_attempt_logs_external`.
- PostgreSQL: `0025_retry_mode_round`, `0026_scheduling_events`, `0027_attempt_logs_external`.
- Upgrade note: `attempt_log_chunks` in the SQLite primary database is dropped; attempt logs
  recorded before this version are removed during migration, run/attempt results are kept.

## 0.4.10 - 2026-08-14

### Changed

- Load the complete selected case hierarchy instead of stopping at 50 records, keep directories
  collapsed by default, and add an in-page search plus a scrollable split workspace that shows case
  details, history, source and actions without leaving the case library.
- Promote administration modules with their own sections to permission-aware primary navigation
  entries instead of nesting them under a crowded management center.
- Move CoTest Suite/Test/environment settings from project configuration into versioned case-task
  policy, add an explicit Adapter switch, and assign multiple environment addresses to cases in
  stable round-robin order when the batch snapshot is created.
- Stream uploaded JDK and dependency archives to object storage without a fixed business-size cap;
  execution still enforces protocol, workspace-disk, extracted-byte and file-count safety budgets.
- Remove the remaining 5000-class `testng.xml` selection ceiling so it cannot reintroduce a test
  discovery count limit; validated JAR entry, expansion, per-class and warning budgets remain.
- Discover every dependency JAR up to three directories below `test-jars`, remove the separate JAR
  count ceiling, and verify the distributed Adapter plus nested dependency archive in the
  network-blocked real-Agent GitHub Actions acceptance path.

### Fixed

- Stabilize the file-source filters and tables, insight success/failure metrics, Runner inventory,
  project execution configuration and compact top bar across desktop viewport widths.
- Add browser layout regression coverage for every primary product and administration route at
  multiple viewport widths, including minimum text/control sizes, boundary overflow, page overflow
  and overlapping interactive controls.

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
- Preserve fast publication by keeping the tagged `Release` workflow independent from
  `Release checks`; only required Adapter, backend image, SBOM, manifest, signature and provenance failures
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
