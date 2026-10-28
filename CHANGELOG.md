# Changelog

## 2.2.0 - 2026-10-28

### Added

- Added private training-base workspaces with member, problem, contest, submission, and
  problem-migration management.
- Added weekly standings, contest source-code export, and JPlag-based plagiarism review.
- Added locally bundled Vditor editing, Markdown table rendering, and statement code copying.
- Added editable legal documents, registration consent, user signatures, and remembered login.
- Added a categorized algorithm-tag catalog and improved tag selection and problem filtering.
- Added scheduled contest standings freezes, live contest notices, and independent Java time limits.

### Fixed

- Refreshed immutable testdata snapshots and judge-side materialization after data changes so new
  submissions and rejudges use the current published testdata.
- Improved fixed-group scoring, Java sandbox resource limits, and submission-detail permissions.
- Preserved participants' own verdicts while masking frozen standings and restricted submissions.
- Improved contest problem ordering, temporary-account renaming, Rating administration, and
  notification delivery and read-state handling.
- Fixed Markdown editor drafts, file-upload feedback, clipboard links, and responsive list filters.
- Fixed clean dependency installation on npm 10 by skipping upstream development-peer resolution
  when preparing the mounted Markdown runtime; locked packages use the official npm registry.
- Declared the YAML parser used by testdata uploads so clean installations do not depend on
  system-wide Node.js packages.

### Changed

- Refined the shared application shell, contest workspaces, problem pages, and administration UI.
- Pinned the upstream Web image and updated deployment, maintenance, and feature documentation.
- Excluded local exports, backups, and private problem-import workspaces from the source release.

### Removed

- Removed VJudge remote-provider integrations and their routes, workers, and obsolete configuration;
  this release uses local judging.

### Upgrade Notes

- Rebuild the Web and Judge images when deploying this version; the source release does not
  include production data, local credentials, or prebuilt application images.
- Install the optional plagiarism runtime with `bash custom/scripts/install-jplag.sh` before
  enabling code-comparison jobs; see `docs/contest-plagiarism.md` for runtime and backup details.
- Installations with existing VJudge data must plan its retirement before upgrading. The cleanup
  script `custom/scripts/remove-vjudge.js` defaults to a dry run; execution requires a verified
  database backup and stopped Web service, and removes remote problems and their related records.

## 2.1.0 - 2026-09-12

### Added

- Contest workspaces and judging now synchronize to the latest published problem statement and
  testdata snapshot while the contest is still running.
- External-proxy-safe ETag writes accept both the `If-Match` header and JSON `if_match` value across
  problem, contest, content, administration, tag, and profile workflows.
- Added durable AI contest run records, problem-set/class/tag/image-host workflows, and bulk upload
  recovery paths already present in the 2.0 development line.

### Security

- Added production deployment guidance for private Web binding, rotated application secrets, and
  restricted judge-control access.

## 2.0.1 - 2026-08-02

### Fixed

- Kept problem detail and editing views synchronized with the current immutable statement version,
  including draft visibility and post-save cache behavior.
- Advanced the active immutable testdata snapshot after ZIP upload, individual file upload, and
  deletion so subsequent submissions are judged against the newly saved data.
- Made testdata upload pages wait for durable processing and report parsed testcase status before
  refreshing the management view.
- Applied route-aware multipart request limits to testdata and additional-file uploads while
  retaining the 1 MiB gateway limit for JSON and unknown endpoints.
- Preserved verdict palette colors for linked problem progress statuses.
- Kept contest problem statements, titles, and testdata synchronized with the current problem
  version before and after the contest starts.
- Made new submissions and rejudges materialize and record the latest problem/testdata snapshot
  instead of reusing the snapshot captured when the problem was first added to a contest.
- Displayed current problem titles throughout contest workspaces and submission lists/details,
  while retaining each submission's actual snapshot identifier for traceability.
- Documented ZIP layouts for traditional, interaction, and submit-answer problem testdata, including
  interactor language selection and required archive contents.
- Zero-padded contest schedule defaults as `YYYY-MM-DD HH:mm:ss` in the creation and editing form.

## 2.0.0 - 2026-08-01

### Added

- A white-first responsive application shell with a compact sidebar, dark mode, local icon bundle,
  keyboard navigation, stable scrollbar gutter, accessible dialogs, and shared page states.
- Versioned v2 domains for identity, authorization, problems, submissions, contests, Rating,
  content, administration, migration evidence, and VJudge workflows.
- Immutable problem/testdata snapshots, submission event replay, asynchronous job tracking,
  audit identifiers, scoped capabilities, ETag concurrency control, and idempotent writes.
- Rated contest calculation, chronological recalculation after contest deletion, Rating history
  charts, and participant Rating-change notifications.

### Changed

- Rebuilt all public and administration pages around the v2 design system while preserving OJ,
  contest, moderation, and Judge behavior.
- Unified problem statements and problem creation into one Markdown document and synchronized
  editor/preview scrolling.
- Standardized contest mode naming on ACM and separated public participant views from participant
  administration.
- Replaced migration/task dashboards with focused operational workspaces after migration completion.

### Removed

- All v1 API reads, v1 write routes, v1 form fallbacks, v1 client calls, and compatibility adapters.
- Dynamic activity publishing, saved problem views, ZIP problem import, obsolete migration controls,
  and unused legacy UI styles, scripts, templates, and Compose mounts.

### Security

- Added v2-only route enforcement, CSRF and same-origin checks, recent-login checks for high-risk
  operations, scoped authorization, immutable audit/event records, bounded uploads, and isolated
  Judge-control authentication.
