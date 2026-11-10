# Changelog

## Unreleased

### Changed

- Creating or saving an activity now opens its overview; failed saves retain the form.
- Simplified activity navigation and registration to two progress stages. Organizers see
  management entries only; registration uses a compact action beside the activity details.
- Merged rejection into editable returns, including historical records, counts and exports.
  Roster details expand exclusively while preserving unsaved review drafts.
- Streamlined the full activity flow with invitation-aware discovery, contextual next actions,
  completion checks, tab-scoped draft recovery, organizer templates and sequential review.
  Removed explanatory fine print and simplified the desktop/mobile layouts.
- Activity descriptions now use the shared Markdown editor. Registration management uses
  compact status filters, aligned rows, member switching and an adjacent review form.
- Rosters, status counts, searches and CSV exports show each person's current registration
  only; superseded withdrawn memberships remain stored but no longer duplicate the roster.
- Redesigned activity discovery, personal registration, team readiness, organizer setup,
  form previews and registration review for desktop and mobile.
- Personal registration now supports one-step atomic submission; captains can save their
  visible answers and submit a ready team together without a separate save operation.

### Added

- Activity registration automatically includes the account email in private identity details,
  organizer searches and CSV exports, with account-email fallback for older registrations.
- Activity lists and overview details show the number of registered people, including
  pending and approved submissions and counting team members individually.
- Activity system notifications now cover submissions, automatic registration success,
  approval, return, invitations and accepted invitations. Team results notify
  all confirmed members; acceptance notifies the captain. Delivery is transactional.
- Added activity search/status filters, roster counts, locked-rule indicators, and activity
  deletion with permission, revision and exact-title checks. Deleted activities are hidden
  and closed to all operations while registration records remain retained.

### Fixed

- Activity configuration actions now match the surrounding page background in both themes.
- Restored visible outlines for copying activities and withdrawing registrations.
- Hour/minute selections remain open for consecutive choices.
- Kept hour/minute options in a bounded, scrollable popup that opens from the entire control
  and exposes minutes 58 and 59 at the bottom of the list.
- Restored the activity-registration icon in the sidebar and quick navigation.

## 2.4.0 - 2026-11-09

### Added

- Added independent activity registration with personal and team modes, configurable forms,
  confirmed invitations, review, withdrawal, roster search, CSV export and activity copying.
- Added a global activity-management permission; all activity settings and rosters live on
  the public-facing activity pages. Individual identity and answers remain private.
- Added transaction and concurrency checks for duplicate participation, stale reviews and
  deadline enforcement; updated the help page and synchronized the displayed release version.

### Upgrade

- This release updates Web only. Rebuild and recreate Web; judge images remain at v2.3.0.
- Activity tables are created additively. See [activity registration](docs/activities.md).

### Fixed

- Bulk problem ZIP imports now match existing tags by the names in `problem.json` `tag_names`.
  Older archives using `tag_ids` remain supported.

## 2.3.0 - 2026-11-08

### Added

- Added two-round communication problems: the same submitted program runs twice in isolated
  sandboxes, with a problem-supplied transformer producing the second input from the first output.
- Added communication configuration, downloadable example data, and permission-controlled
  per-round diagnostics. Existing languages, time multipliers, snapshots and Special Judges work
  with the new problem type.
- Bulk problem ZIP imports now apply existing tags listed in each `problem.json` `tag_ids` array.

### Fixed

- Included extra compilation files in judge cache keys so different testdata snapshots cannot
  reuse binaries built with outdated headers.

### Upgrade

- Deploy updated runners before daemons and Web. Web schema synchronization adds the
  `communication` problem enum value without changing existing problem types.
- See [communication problem documentation](docs/communication-problems.md) for the transformer
  contract, combined time budget and deployment/rollback requirements.

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
