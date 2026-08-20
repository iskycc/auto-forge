# Changelog

All user-visible changes are recorded here. AutoForge follows semantic versioning; release notes must
also list database migrations, persisted-configuration changes, compatibility changes, offline assets,
and known limitations.

## Unreleased

### Changed

- GitHub Actions now partitions Full, network-blocked Lite, tagged-source quality and published
  Release acceptance into independent state-isolated jobs. The longest browser and infrastructure
  paths no longer serialize unrelated scenarios behind one 10-17 minute job.
- Published-asset acceptance starts from the successful `Release` workflow completion instead of
  spending several minutes polling for a Release that is still being built. A manual dispatch still
  supports rechecking an existing immutable tag with the current acceptance harness.
- Lite browser coverage now reuses one production build within four duration-balanced scenario
  groups instead of consuming eleven concurrent runners on eleven duplicate builds.
- Main CI reuses one Full platform for adapter, Agent, LDAP and dependency-recovery checks, and folds
  deployment checks into Lite operations so the initial job wave stays within hosted concurrency.

### Tests

- Added workflow contract coverage that rejects reintroducing the unpartitioned Full and offline
  commands and verifies the post-publication acceptance matrix retains asset, Agent, LDAP, backup,
  rollback and upgrade coverage.
- Made the published backup/restore scenario seed and verify its own persisted settings instead of
  depending on another browser scenario to run first.
- Stabilized the batch-shared-input E2E by waiting for Agent workspace links to finish materializing
  after a later attempt reports `running`, removing a filesystem sampling race.

## 0.9.0 - 2026-08-20

### Changed

- Standardized every first- and second-level sidebar entry on a four-Chinese-character label and
  added a CI-enforced source test so navigation redesigns cannot silently regress the naming rule.
- Redesigned analytics trends, failure reasons and flaky-case presentation to use compact card
  proportions, method-level TestNG totals, human-readable error descriptions and case names.
- Expanded the dashboard fluid desktop width through 4K while keeping 1024px as the supported
  minimum; mobile layouts are explicitly outside the product and test baseline.
- Execution-record columns now use their 70th-percentile row content for initial sizing while
  retaining manual resize persistence. Failed rows sort by their human-readable failure description
  after the primary status category instead of falling back to case names under one shared code.

### Fixed

- Current top-level TestNG result counts are now aggregated correctly while legacy nested summaries
  remain readable. Successful result codes can no longer produce failure facts, and stale analytics
  facts are rebuilt automatically with the corrected schema version.
- The global execution dialog is mounted through a body portal so its backdrop covers the complete
  viewport and the dialog remains geometrically centered instead of being constrained by the topbar.
- Multiline power-assert diagnostics are recognized without an Adapter marker and compacted to one
  line without discarding their values. The CoTest Adapter installs explicit UTF-8 stdout/stderr
  streams before loading user classes, preserving mixed Chinese/English `Assert.assertTrue` messages.
- Runner log uploads now split batches by the actual encoded 2 MiB request limit and shrink/retry
  batches rejected by a lower proxy limit; transient failures retain bounded exponential retries.
- Pre-launch input failures now distinguish execution disk-policy overflow from actual Runner
  workspace disk exhaustion with `EXECUTION_INPUT_DISK_LIMIT_EXCEEDED` and
  `WORKSPACE_DISK_INSUFFICIENT` instead of the misleading `PROCESS_START_FAILED`.
- The JAR importer keeps its controls disabled until client hydration completes, preventing an early
  file selection from being discarded and leaving the scan action permanently disabled.

### Tests

- Added shared analytics unit and SQLite recovery coverage, a PostgreSQL success-fact assertion, a
  real completion-protocol browser scenario for 50% pass/fail analytics, and desktop viewport checks
  for dashboard scaling and full-screen dialog geometry.
- Added regressions for percentile column sizing, failure-description sorting, multiline
  power-assert extraction, encoded log-request splitting and transient retry, disk-capacity result
  classification, a real Adapter assertion carrying mixed Chinese/English text, and hydrated JAR
  upload readiness in the Full real-Agent recovery path.

### Database

- No database migration or persisted platform-configuration migration is required.

### Compatibility

- Runner Protocol schema v1 and the offline asset layout remain unchanged. The new workspace-disk
  result codes are additive; older stored result codes remain readable.
- Release images, deployment bundles, embedded static Runner binaries, SBOMs, checksums and build
  provenance are regenerated for `v0.9.0` by the tagged Release workflow.

### Known limitations

- The authenticated UI supports desktop browser widths of 1024 pixels and above; mobile layouts are
  intentionally outside the supported and tested interface baseline.

## 0.8.5 - 2026-08-20

### Added

- Added persistent Runner Groups for Lite/SQLite and Full/PostgreSQL, including optimistic updates,
  member management, dual-adapter contract tests and immutable member snapshots when an execution
  batch is created. Both suite and single-case execution can select either direct Runners or one
  Runner Group.
- Added a global “开始执行” dialog to the top bar on every authorized page. It supports suite and
  single-case execution, managed or inline environments, Runner Groups, retry policy, parameter
  overrides and CoTest Adapter Suite/Test/environment addresses.
- Added `Design.md` as the implementation-facing UI review and information-architecture guide.

### Changed

- Rebuilt the authenticated homepage around the six sections from the approved dashboard design:
  weekly quality, active execution, case library, Runner Groups, failure insight and recent
  activity. Empty states use real product actions instead of placeholder metrics.
- Removed the standalone batch planner from primary navigation and regrouped administration into
  project collaboration, identity/access, execution configuration and platform operations.

### Fixed

- Execution failure descriptions now preserve the complete multiline UTF-8 adapter summary instead
  of truncating it or falling back to `class#method 执行失败`. Runner JVM processes explicitly use
  UTF-8 console encodings, and oversized writes are split at the Runner Protocol chunk boundary.
  The internal Base64 summary control record remains in authoritative logs for extraction but is
  hidden from interactive and public log views.
- Round totals now use the cases eligible for each round: the initial round contains all cases and
  each retry round contains the preceding round's failures/timeouts. Not-executed counts update while
  a round is active, and the all-rounds row sums every displayed round consistently.
- Completed attempt rows no longer expose cancellation actions merely because their execution run is
  queued for a later retry. Execution detail tables use compact fixed layouts with 70th-percentile
  content widths so isolated long values wrap without stretching the whole column.
- Single-case execution now resolves the case's actual project instead of silently falling back to
  the default project, schedules through the shared batch state machine, and persists Adapter
  environment IP/address settings into the immutable execution specification.
- The global execution dialog now resolves each managed environment's current immutable version
  before rendering it. A non-empty environment list can no longer crash the dialog by treating
  environment summaries as version details.

### Tests

- Added multiline/long/Chinese failure-summary coverage across Adapter, control plane, UI and public
  log views, plus live round aggregation, retry eligibility, compact layout and terminal-row action
  E2E coverage. The existing all-rounds scenario is now part of the GitHub Actions browser matrix.
- Added a Lite browser scenario that creates a Runner Group, starts one case through the global
  dialog and verifies the claimed assignment contains the selected Runner, parameters and Adapter
  environment address.

### Database

- SQLite migration `0032_runner_groups.sql` and PostgreSQL migration `0031_runner_groups.sql` add
  `runner_groups` and `runner_group_members`. Existing execution data is unchanged.

### Compatibility

- Runner Protocol schema v1 and the offline asset layout are unchanged. The Base64 failure marker
  and Runner Group HTTP contracts are additive; control planes continue to accept the legacy
  plaintext marker during rolling upgrades.
- Existing Lite and Full installations must apply the new Runner Group migrations during upgrade.
  No persisted platform-configuration migration is required.

### Known limitations

- The authenticated desktop UI continues to require a viewport width of at least 1024 pixels;
  mobile layouts remain outside the supported interface baseline.

## 0.7.2 - 2026-08-19

### Fixed

- CoTest batch sharing now gives every attempt a real `test-jars` directory whose JAR files are
  hard-linked to the single batch-level extraction. This preserves inode-level reuse while allowing
  the Adapter's non-following Java directory walk to discover the JARs; the optional JDK remains a
  controlled directory symlink.
- Expiration recovery now ignores queued, active-lease and unclaimed records whose batch is already
  terminal, and verifies run/attempt/assignment states before recovery. Stale records can no longer
  make later Runner claims fail with an invalid terminal batch transition.
- The GitHub Actions batch-sharing acceptance packages a bounded `jlink` runtime instead of the
  hosted runner's complete JDK, keeping the real-JDK extraction scenario within execution disk and
  file budgets.
- Restart reconciliation now removes a killed attempt's obsolete workspace even when its old lease
  expired before the completion could be reported. The persisted completion and spools remain
  available for a later retry, while batch-input hard links and workspace disk are released. The
  Agent now persists the execution process-group leader with its Linux kernel start time; restart
  reconciliation verifies that identity, kills the surviving group without PID-reuse risk, and then
  performs a second orphan scan. Local attempt-state schema v2 remains able to read and automatically
  upgrade v1 records.
- Scheduler project and Runner capacity accounting now excludes stale active attempts whose run or
  batch is already terminal. Scheduling-refill adapter fixtures use isolated projects and clean up
  their PostgreSQL records, so Full-mode acceptance cannot be blocked by prior contract-test data.

### Compatibility

- No database migrations, platform persisted-configuration changes, Runner Protocol changes, or
  offline asset format changes. Runner local attempt state advances from schema v1 to v2; existing
  v1 records are read and upgraded automatically.

## 0.7.1 - 2026-08-19

### Fixed

- Batch sharing now materializes the CoTest `test-jars` tree and optional JDK once under
  `work/batches/<batchId>/runtime/cotest/`; attempts reuse the extracted dependency files through
  symlinks instead of extracting the same archive again.
- Batch workspace closure is remembered until the final local attempt exits. Idle cached batch IDs
  are reconciled through heartbeats and assignment claims, so every participating Runner cleans its
  copy in a multi-Runner batch, including draining or disabled Runners that no longer claim
  assignments; disabled heartbeat remains drain/cleanup-only and does not restore execution rights.
- Safe batch workspaces now survive Agent restart and are reused after reconcile while the batch is
  still active; terminal, deleted, foreign and malformed cache entries are cleaned deterministically.
- Reconcile completion now also removes crashed attempt workspaces, so hard links to batch inputs do
  not keep downloaded files alive after the batch cache is deleted.
- A failed terminal batch-directory deletion is retained for the next heartbeat/claim cleanup
  handshake instead of becoming an untracked leak.
- Completion-triggered scheduling failures now return an error so the Agent replays the persisted
  completion with the same ID and retries the idempotent slot-refill operation.
- Version-diff labels and historical snapshot presentation now use readable Chinese method
  signatures as well; raw JVM descriptors are no longer exposed through method tooltip text.

### Tests

- The scheduling-refill browser scenario now covers an immediate retry starting while a sibling
  first attempt remains in flight.
- The real-Agent batch-input-sharing scenario is wired into a dedicated GitHub Actions job and now
  verifies concurrent attempts, a later refill attempt and a post-crash attempt all reuse the same
  raw inputs and extracted dependency inode before terminal cleanup.

## 0.7.0 - 2026-08-19

### Features

- Batch-level shared execution inputs on the Runner Agent: all test-jar / dependency-jar /
  jar-bundle / jdk-archive inputs of one batch are downloaded and extracted exactly once per
  runner into `<agent data dir>/work/batches/<batchId>/`. Concurrent attempts of the same batch
  reference them through hard links (with a copy fallback across filesystems) and a shared
  `runtime/jdk` symlink, so five parallel attempts no longer download the same JAR five times.
  Existing inputs are re-validated by streaming SHA-256 and only re-downloaded on mismatch. The
  shared directory is removed once the control plane confirms the batch is terminal
  (`batchClosed`) and no local attempt of that batch is still running; agent startup reconcile
  now also removes orphaned `work/<attemptId>-*` leftovers and unreferenced `batches/*`
  directories left behind by crashes.
- Runner Protocol completion responses carry the optional `batchId` and `batchClosed` fields
  (additive change, schemaVersion unchanged) so agents can recycle batch workspaces and the
  control plane can trigger refill scheduling.

### Changed

- Scheduling now refills freed concurrency slots immediately: accepting an attempt completion
  re-runs batch scheduling at once, and batches in `running` status remain schedulable, so a
  runner with 10 slots starts the next case as soon as any case finishes instead of waiting for
  the whole wave of 10 to complete (previously assignments were only created at batch creation
  and on heartbeats, and `running` batches were excluded from scheduling).
- Method signatures in the UI are shown as Chinese readable text instead of raw JVM descriptors:
  the import scan preview, the case-source preview, the case details method table (column
  “描述符” renamed to “方法签名”) and the case-library selection table now render
  “入参：…，返回值：…” — `()V` reads as “入参：空，返回值：空”,
  `(Ljava/lang/String;I)Z` as “入参：String、int，返回值：boolean”. The raw descriptor
  moves to a hover tooltip so overloaded methods stay precisely identifiable. Data, contracts
  and execution matching are unchanged (still `methodName + descriptor`).

### Tests

- New dual-database contract suite `packages/db/test/scheduling-refill.integration.test.ts`:
  `running` batches stay schedulable, completions report the correct `batchId`/`batchClosed`,
  and a freed slot is refillable while sibling runs are still in flight.
- New end-to-end spec `tests/e2e/scheduling-refill.spec.ts`: five cases on a two-slot runner,
  each accepted completion immediately yields the next assignment without any heartbeat, and
  `batchClosed` only turns true on the final completion.
- New end-to-end spec `tests/e2e/batch-input-sharing.spec.ts` driving the real Go Agent: two
  concurrent attempts of one batch share the same downloaded inputs (identical inodes via hard
  links, stable mtimes proving no re-download), the batch workspace is removed after the
  terminal state, and a crashed-then-restarted agent cleans up the orphaned batch directory.
- `tests/e2e/all-rounds.spec.ts` export step hardened against the tab-navigation re-render race.

### Compatibility

- Runner Protocol change is additive and optional on both sides; older agents and servers
  interoperate unchanged (agents without batch sharing simply re-download per attempt).
- No database migrations, no persisted-configuration changes, no offline asset changes.

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
