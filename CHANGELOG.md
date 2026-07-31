# Changelog

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
