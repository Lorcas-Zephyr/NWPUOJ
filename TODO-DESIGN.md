# NWPUOJ 2.0 Design Implementation TODO

Source of truth: [DESIGN.md](./DESIGN.md)

Updated: 2026-07-31

This checklist tracks implementation of the full design proposal. The existing
`TODO.md` remains the UI remediation checklist; this file tracks the cross-domain
2.0 redesign. Do not mark an item complete until its implementation and tests exist.

Status: `[x]` complete, `[~]` partial/in progress, `[ ]` not started.

## 0. Project Baseline

- [x] Audit the complete design document and identify existing partial modules.
- [x] Create this traceable implementation checklist.
- [x] Keep the application as a modular monolith while domain boundaries are introduced.
- [x] Add a migration flag and rollout switch for each new domain.
- [x] Add design checklist status to release/deployment verification.

## 1. API Contract And Application Infrastructure

- [x] Keep `/api/v2` as the new API prefix.
- [x] Return `{ data, meta, error }` for every v2 response, including failures.
- [x] Generate and return a stable `request_id` and `X-Request-ID`.
- [x] Add a shared error catalog with stable codes and field-level details.
- [x] Add cursor/limit pagination with `next_cursor` for all list resources.
- [x] Add `Idempotency-Key` storage, replay, conflict, and expiry handling.
- [x] Add `ETag` and `If-Match` handling for editable resources.
- [x] Normalize all API timestamps to ISO 8601 UTC.
- [x] Return `operation_id` for every asynchronous write.
- [x] Add task-resource and SSE progress primitives.
- [x] Add API contract tests for anonymous, authenticated, and forbidden requests.
- [x] Add rate limiting and request body limits to the v2 gateway.
- [x] Add API version and capability metadata without exposing secrets.

## 2. Identity, Authorization, And Audit

- [x] Expose a v2 session and capability endpoint.
- [x] Add a shared `authorize(subject, action, resource, context)` entry point.
- [x] Add persistent Organization records and membership scopes.
- [x] Add persistent Team records and contest/training membership.
- [x] Add Role, Grant, Policy, and scope tables/models.
- [x] Seed guest, member, participant, problem_editor, problem_reviewer,
  contest_manager, judge_operator, content_moderator, rating_manager,
  vjudge_manager, site_admin, and owner roles.
- [x] Replace `is_admin` checks in write paths with capability authorization.
- [x] Enforce resource ownership and contest/problem scope boundaries.
- [x] Make permission changes immediately effective without permanent session caches.
- [x] Add recent-login and MFA gates for high-risk operations.
- [x] Add immutable authorization and high-risk `AuditEvent` records.
- [x] Return stable authorization error codes with actionable messages.
- [x] Add automated permission matrix tests for every built-in role.

## 3. Problem Domain

- [x] Add ProblemVersion records with author, status, diff, and publication metadata.
- [x] Add immutable ProblemSnapshot records for submissions and contests.
- [x] Add problem publish, archive, version, and review endpoints.
- [x] Add testdata validation/upload jobs with progress and cancellation.
- [x] Add tag management and bulk problem actions under scoped authorization.
- [x] Add solution/solution-review workflow and visibility policy.
- [x] Add source/provider metadata and migration of legacy problem references.
- [x] Ensure published contests and submissions reference snapshots, never mutable problems.
- [x] Add problem-domain API, model, transaction, and authorization tests.

## 4. Submission, Judge, And Events

- [x] Implement the submission state machine: created, queued, compiling, judging,
  accepted, wrong_answer, runtime_error, time_limit, memory_limit, system_error,
  and cancelled.
- [x] Add immutable SubmissionEvent records for every state transition.
- [x] Add Submission and code-version visibility fields matching the v2 contract.
- [x] Add idempotent normal and contest submission endpoints.
- [x] Add submission list/detail, rejudge, cancel, testpoint, and SSE endpoints.
- [x] Add a scheduler that considers contest priority, quotas, language resources,
  and queue age.
- [x] Bind signed judge tasks to language, limits, network, file policy, and data version.
- [x] Reject unsigned or browser-crafted worker task parameters.
- [x] Add isolated compile-cache keys and compiler image/version metadata.
- [x] Retry system failures only; never retry user-code failures automatically.
- [x] Preserve original results when administrators rejudge and generate the audit reason automatically.
- [x] Keep queued submissions intact during judge-service outages.
- [x] Add event replay/projection rebuild and judge failure recovery tests.

## 5. Contest Domain

- [x] Implement lifecycle: draft, review, scheduled, running, frozen, ended, rated, archived.
- [x] Enforce transition permissions, preconditions, and audit records.
- [x] Add contest configuration for timezone, rules, scoring, visibility, security,
  registration, teams, and Rated profile.
- [x] Add ContestProblemSnapshot with order, alias, score, penalty, and snapshot hash.
- [x] Lock problem set, scoring rules, and Rated state once a contest starts.
- [x] Add contest review/publish/start/freeze/end endpoints.
- [x] Add registration, participant, bulk-action, and event SSE endpoints.
- [x] Build event-projected realtime, frozen, unfrozen, and final standings.
- [x] Preserve standings versions and rebuild history for audit.
- [x] Apply field-level standings visibility by participant/manager/operator scope.
- [x] Add contest lifecycle, snapshot immutability, and standings tests.

## 6. Rating Domain

- [x] Add isolated RatingProfile records for icpc, ioi, practice, and vjudge.
- [x] Implement Glicko-2 parameters as explicit versioned configuration.
- [x] Add RatingPreview and approval workflow before publication.
- [x] Add immutable RatingEvent records; current rating is a projection only.
- [x] Handle cancellation, disqualification, cheating, and corrections with reverse events.
- [x] Add asynchronous recalculation jobs with preview diff, approval, and rollback.
- [x] Add profile, leaderboard, history, preview, publish, adjustment, and job endpoints.
- [x] Restrict Rating publication/recalculation to the dedicated capability.
- [x] Add historical replay and rating invariant tests.
- [x] Notify every affected participant after a contest Rating publication changes their Rating;
  include the contest, previous Rating, new Rating, and delta, and make recalculation notifications
  idempotent so retries never send duplicate or stale changes.

## 7. VJudge Domain

- [x] Define and validate the Provider Adapter contract for all supported platforms.
- [x] Store only encrypted credential references; never return plaintext secrets.
- [x] Add source connection test and provider policy endpoints.
- [x] Add resumable/cancellable single and batch import jobs.
- [x] Use `source + remote_id` as the remote problem uniqueness key.
- [x] Add preview, conflict, visibility, tag, retry, and progress stages to imports.
- [x] Add per-provider rate limits, retry policy, and credential isolation.
- [x] Add remote submission, upstream task ID, local submission ID, and sync events.
- [x] Distinguish upstream errors from local judge errors.
- [x] Add provider adapter contract, import recovery, and remote submission tests.

## 8. Content, Community, And Notifications

- [x] Add discussion, replies, locks, and moderation review endpoints.
- [x] Add solution submission/review and problem solution visibility policies.
- [x] Add notifications, read-all, messages, conversation, and message settings endpoints.
- [x] Add clipboard CRUD, sharing, and ownership checks.
- [x] Add ticket creation, replies, assignment, and closure workflow.
- [x] Add public announcements and active banners endpoints.
- [x] Add moderation queues and content audit events.
- [x] Add notification/message/ticket/discussion/clipboard transaction and permission tests.

## 9. Admin And Operations

- [x] Build admin overview, health, audit, users, jobs, workers, and risk endpoints.
- [x] Require `audit_event_id` on every administrative write.
- [x] Implement worker status, signed restart action, and restart audit trail.
- [x] Unify import, rejudge, rebuild, bulk-action, and recalculation jobs.
- [x] Support queued/running/paused/cancelling/completed/failed/cancelled states.
- [x] Add task detail, progress, current object, failure list, retry, and cancellation.
- [x] Add user disable, role grants, and scoped high-risk controls.
- [x] Add admin announcement/banner/content/help/link/config metadata workflows.
- [x] Return redacted values and change diffs; never expose credentials or environment values.
- [x] Add admin audit, job recovery, and secret-redaction tests.

## 10. Frontend Application Shell And Pages

- [x] Maintain the new white-first application shell and shared design tokens.
- [x] Implement context-aware left navigation, top context, profile, and notifications.
- [x] Add reusable tables, drawers, command panel, steps, status labels, and empty states.
- [x] Implement the home overview for contests, announcements, problem lookup, and site activity.
- [x] Implement problem search, filters, and bulk actions.
- [x] Implement problem detail as a single-flow statement with a separate stable submission workspace and live submission state.
- [x] Implement stable white submit editor with no minimap and failure fallback.
- [x] Implement contest workspace for problems, standings, submissions, and announcements.
- [x] Implement guided contest creation and publish confirmation steps.
- [x] Implement judge queue/worker monitoring with live states.
- [x] Implement VJudge tabs, connection, import progress, and failed-item retry.
- [x] Implement the operator-facing Rating status and chronological one-click calculation view; retain preview, history, and diff APIs for controlled recovery.
- [x] Implement admin operations workbench organized by alerts and tasks.
- [x] Implement all loading, empty, partial, unauthorized, missing, success,
  recoverable-error, unrecoverable-error, and offline states.
- [x] Ensure keyboard navigation, focus indicators, screen-reader labels, and mobile layouts.
- [x] Normalize username colors across public and administrative pages so identity,
  privilege, and Rating states remain legible in both light and dark themes.
- [x] Optimize the complete contest experience, including contest list, overview,
  problem workspace, submissions, standings, and management pages.
- [x] Use `ACM` for every user-facing contest-mode label and remove user-facing
  `ICPC` wording; retain compatibility-only internal identifiers where migrations require them.
- [x] Remove the complete home-page training workbench and recent-submission block,
  including `训练工作台`, `个人进度与最近评测`, `全部提交`, `CONTINUE`,
  `暂无待继续的题目`, `从题库选择下一题开始练习`, `选择下一题`, `最近评测`,
  and the `还没有提交记录` empty state, then rebalance the remaining page layout.
- [x] Rebuild the contest detail page as a visually distinct contest workspace rather
  than retaining the legacy problem table inside the new shell.
- [x] Make submission source-code copy work with both the Clipboard API and a safe
  compatibility fallback when clipboard permission or secure context is unavailable.
- [x] Keep the light/dark theme switch mutually exclusive so exactly one theme icon is visible.
- [x] Remove the problem-library saved-view feature, including its entry point, dialog,
  local-storage behavior, dedicated styles, and obsolete tests.
- [x] Normalize VJudge visibility and conflict controls and expose explicit selected-ID
  batch import and complete-provider import workflows through the resumable v2 job API.
- [x] Keep both Markdown panes at the same height and synchronize scrolling in both directions.
- [x] Keep the left Markdown source editor on draft/edit pages to one scroll container; remove the
  nested second scrollbar without breaking synchronized preview scrolling or editor resizing.
- [x] Clear submitted Markdown drafts so Help management does not repeatedly offer to
  recover content that was already published.
- [x] Replace the split problem-statement editor with one canonical Markdown field while
  retaining compatibility with existing problem data and submission/judging logic.
- [x] Remove the redundant `STANDINGS / 排行榜` and contest `JUDGE ACTIVITY / 提交记录`
  headings beneath the contest navigation while retaining live-state and filter controls.
- [x] Remove the redundant `PROBLEM SET / 比赛题目` heading beneath the contest problem tab
  while retaining problem count and progress in the workspace itself.
- [x] Add a first-position `详情` contest tab and a dedicated detail page for contest
  information and announcements, separate from the problem workspace.
- [x] Make the bare contest entry `/contest/:id` open the `详情` page by default while
  preserving direct links to problems, standings, submissions, and participants.
- [x] Unify the top-title format across every public contest subpage (`详情`, `题目`,
  `排行榜`, `提交记录`, and `参赛者`) so the contest name and current section use one
  consistent hierarchy, wording, spacing, and browser-title convention.
- [x] Allow ordinary accounts to view the contest participant list while keeping real-name,
  student-number, college, export, removal, and restoration controls manager-only.
- [x] Render the signed-in account avatar in the top-right header from the same canonical
  local avatar source as the user's profile page, with stable dimensions and fallback behavior.
- [x] Remove the community dynamic feature end to end, including its home feed, detail,
  publish/reply/read/delete routes, view templates, runtime mounts, models, and obsolete styles,
  while preserving historical database rows and uploaded files for non-destructive rollback.
- [x] Place home announcements above recent contests in the source order used at every breakpoint.
- [x] Split the public contest participant list from administrator registration management:
  every contest-navigation participant link uses a read-only username list, while export,
  profile fields, removal, and restoration remain available only inside contest management.
- [x] Remove the repeated participant heading below the public contest navigation and preserve
  the full manager workflow for deleting/restoring participants, exporting registrations,
  rebuilding standings, and batch-creating temporary contest users from CSV.
- [x] Keep the removed-participant restore action as a compact undo icon button with an
  accessible name instead of a text button that widens the management table.
- [x] Keep the active-participant removal action as a compact delete icon button with an
  accessible name, confirmation, keyboard focus state, and no text that widens the table.
- [x] Allow an authorized contest manager to delete a contest while it is running, and verify
  the transactional cleanup of participants, submissions, standings, snapshots, tasks, and the
  required chronological Rating recalculation for every affected later contest.
- [x] Allow a temporary contest account to reuse a student ID held by an ordinary account;
  enforce student-ID uniqueness only among temporary accounts for the same contest while keeping
  login usernames globally unique, and update bulk preflight plus conflict messages accordingly.
- [x] Keep legacy `manage_user` accounts inside the user-management workspace without
  granting the full site-administrator dashboard, navigation, or operations capabilities.
- [x] Sort public announcements with active items first by importance, upcoming items next,
  and ended items last by descending start time without applying importance to the archive.
- [x] Share the personal-profile verdict palette with submission lists and detail/testcase
  results, and preserve each verdict color for clickable and hovered result links.
- [x] Make submission source-code copy work from the real detail control by attempting the
  synchronous compatibility path within the click gesture before the Clipboard API fallback.
- [x] Use a light sidebar and light rendered-Markdown code blocks in light mode, with both
  surfaces switching to deep gray in dark mode while preserving readable state contrast.
- [x] Make every code-like surface on submission details follow the same theme-aware palette as
  rendered Markdown code blocks, including submitted source, compiler output, testpoint input,
  expected/actual output, stderr, checker messages, and diagnostic data; verify readable syntax,
  whitespace, verdict colors, overflow, copy/download controls, and light/dark transitions.
- [x] Verify desktop, tablet, mobile, 200% zoom, dark mode, and reduced-motion behavior.
- [x] Audit font sizes across every public and administrative workflow, raise undersized labels and
  actions such as testpoint download links to a readable minimum, and recheck desktop, mobile, and
  200% zoom without clipping, overlap, or unintended density changes.
- [x] Fix the VJudge batch-import visibility and conflict segmented controls so `暂不公开`,
  `导入后公开`, `跳过已有`, and `覆盖已有可见性` retain readable widths without clipping,
  wrapping, or icon/text overlap at every supported breakpoint.
- [x] Allow a newly created contest draft to contain no problems; keep the problem requirement
  only on publish/start transitions and preserve a clear empty-problem summary in the creation flow.
- [x] Fix the administration migration controls so migration creation, compatibility observation,
  rollback rehearsal, progress refresh, and actionable API errors all work from the rendered UI.
- [x] Remove the problem-library ZIP bulk-import entry point and make the `添加题目` action navigate
  directly to the new-problem editor without a menu or intermediate choice screen; retain VJudge
  remote batch import in its dedicated administration workspace.

## 11. Migration And Compatibility

- [x] Create new domain/event tables without destructive legacy changes.
- [x] Import users, problems, contests, submissions, and Rating history into projections.
- [x] Run old/new count and result consistency checks.
- [x] Add dual-write only where projection consistency is proven and reversible.
- [x] Switch new frontend flows to v2 endpoints behind rollout flags.
- [x] Keep old APIs read-compatible during one complete contest cycle.
- [x] Remove old write paths from the active runtime after migration verification and rollback rehearsal.
- [x] Document the compatibility inventory and archive the evidence-based release gate; no calendar-date hold is used.
- [x] Inventory every remaining v1 page route, form action, JSON endpoint, client call, and
  compatibility adapter, and map each one to a tested `/api/v2` replacement.
- [x] Switch every public and administrative workflow to v2-only writes behind the rollout gate.
  The runtime guard returns `410 V2_ROUTE_REQUIRED` for unsupported writes while retaining safe page reads
  and Judge callbacks; the complete role, contest, judge, Rating, VJudge, and recovery suites pass.
- [x] Retire v1 route/handler/client writes from the active runtime after projection consistency,
  100% rollout, one real complete contest cycle, verified rollback rehearsal, and review. Historical
  data and the auditable compatibility-cycle evidence remain available for rollback diagnosis.

## 12. Verification And Release Gates

- [x] Run unit tests for every domain state machine and authorization matrix.
- [x] Run API contract tests for response envelope, errors, pagination, idempotency, and ETags.
- [x] Run event replay and projection rebuild tests.
- [x] Run outage, retry, cancellation, and resume tests for judge and batch jobs.
- [x] Run contest snapshot lock and standings visibility tests.
- [x] Run Rating preview/publish/reverse/rebuild tests.
- [x] Run VJudge provider, import conflict, retry, and credential-redaction tests.
- [x] Render all modified EJS templates in the actual Web container.
- [x] Verify anonymous, member, participant, reviewer, manager, operator, admin, and owner branches.
- [x] Verify 360x800, 768x1024, 1024x768, and 1440x900 critical workflows.
- [x] Verify keyboard, screen reader, modal scroll lock, table scrolling, and offline recovery.
- [x] Verify Web/Judge Control/Worker health and restart behavior; the local production-shaped stack
  is healthy, the complete smoke contest cycle and rollback rehearsal are recorded, and all rollout
  domains are at 100%.
- [x] Update `DESIGN.md` status to implemented after every required item is green.

## Current Checkpoint

- The evidence gate is green without a calendar date: all eight rollout domains are enabled at 100%,
  the compatibility window started at `2026-07-31T13:06:15.577Z`, one real ACM contest completed
  with one accepted judged submission, its deletion retained a SHA-256 cycle summary, and rollback
  rehearsal verified disabled/restored rollout snapshots. The test contest and temporary accounts
  were then removed; only the immutable cycle evidence remains.
- `SYZOJ_V2_ONLY=true` is enabled in the Web service. Safe reads and `/judge` callbacks remain
  available, while non-v2 writes receive the stable `V2_ROUTE_REQUIRED` 410 response. This is
  the runtime retirement boundary and can be reverted by the release rollback procedure.

- The v2 gateway now provides the response envelope, request/operation IDs, persistent
  idempotency, cursor helpers, ETags, body/rate limits, SSE primitives, and capability metadata.
  Operation status and its SSE stream now share the same owner-or-job-manager authorization
  check, so logged-in users cannot subscribe to another user's operation events.
- Unknown v2 routes and uncaught v2 errors now terminate in the same JSON contract instead of
  falling through to legacy HTML. Anonymous idempotency keys are isolated by a non-null principal,
  expired keys are reusable, conflict/pending responses cannot overwrite the original operation,
  and every v2 `PUT`/`PATCH` editable resource exposes a matching read ETag and enforces `If-Match`
  against locked state, including rollout, site configuration, problem tags, and organization/team
  membership. Running-container
  checks cover 401, 403, 404, 409, 412, and 428 responses plus replayed response identity.
- Identity includes v2 login/logout/profile/password reset/email MFA and immediate account
  disable/session revocation. Ordinary self-service profile editing now includes the registration
  identity, rechecks the full resource ETag under row locks, preserves immutable completed identity
  fields, and commits account changes, audit, and domain event atomically; privileged cross-user
  editing retains its existing authorization boundary. Organization/team membership and scope APIs, transaction-backed
  role grant/revoke, built-in roles, scoped grants, recent-login gates, and database-enforced
  immutable audit events are active. Permission reads do not use permanent session caches, and
  authorization failures include a stable code and next action. Policy conditions use a bounded
  subject/request/resource/time DSL, explicit deny takes priority, changes are immediately visible,
  and policy writes are owner-gated, ETag-protected, transactional, audited, and event-backed.
  All administrative writes now authorize through the same capability service. Historical account
  flags remain durable data only and do not expose a v1 route or compatibility adapter.
- Problem, submission, contest, Rating, VJudge, content, admin, and migration v2 modules are
  present. Problem versions expose author/reviewer, review status, publication metadata, parent
  diff, ETag-protected review requests, and audited approval/rejection; draft versions remain
  visible only to scoped editors/reviewers. Problem snapshots include VJudge source metadata and
  problem reads expose a redacted local/VJudge source projection. Stable provider/remote-ID mappings
  are synchronized on create and publish, exposed through a visibility-gated lookup, and backfilled
  by the resumable problem migration. Consistency checks report missing, orphaned, mismatched,
  invalid, and duplicate historical source references. The completed production backfill evidence
  remains available for consistency checks. VJudge credential references use AES-256-GCM;
  connection tests execute against the submitted reference, import jobs bind the creating user's
  tested credential version, and provider cookies/login state are partitioned by credential fingerprint.
  Imports are resumable and provider operations use a shared per-provider rate limiter with bounded
  retries for transient upstream failures. Remote submissions persist upstream/local task linkage,
  publish redacted synchronization events, and have bounded outage, retry, cancellation, resume,
  and restart-recovery coverage without requiring production provider credentials.
- The admin domain exposes overview, health, risks, users, signed Worker control, and a unified
  task view for VJudge imports, testdata validation/uploads, scoped problem bulk archives,
  submission rejudge, Rating recalculation, and standings rebuild. Completed migration evidence is
  retained outside the normal administration navigation. The problem library
  queues bulk archives into this task model and reports live progress instead of blocking the page.
- Problem tags expose paginated list/detail, ETag-protected create/update/delete, assignment
  validation, in-use protection, scoped authorization, and domain events.
- The shared SSE helper now powers Rating task events and a capability-gated unified admin task
  stream. VJudge, problem validation, submission, Rating, standings rebuild, and migration jobs
  publish recoverable queue/control/terminal lifecycle events. Public practice-submission streams
  expose only the status projection; testpoint, audit, retry, and operator diagnostic fields stay
  limited to the submission owner or a judge operator.
- Rating Profile/Glicko-2 preview and immutable projection flow now includes persistent
  recalculation jobs that replay published contests in chronological order, re-read final
  standings, cascade corrected Glicko-2 inputs, require diff approval, and write immutable
  superseding events. Cancellation, disqualification, cheating, and correction requests create
  reverse events plus eligibility overrides and a follow-up preview. The reverse event, current
  projection, durable ICPC storage projection, eligibility override, recalculation job, audit record, and
  persisted domain event now commit atomically; all four reversal modes and audit failure rollback
  are covered by transaction tests.
- Rating publication now sends one transaction-backed participant notification containing the
  contest, previous Rating, new Rating, and delta. Delivery keys prevent duplicate retries;
  recalculation updates or removes stale notifications, rollback restores the previous notice, and
  contest-deletion cascades name the deleted contest while showing the final before/after Rating.
- Announcement and homepage-banner administration now use v2-first form interception with
  idempotency and ETags. The v2 banner upload accepts only validated JPG/PNG/WebP/GIF files up to
  5 MiB, and deletion removes a managed image without allowing arbitrary filesystem paths.
- Contest-list and contest-context registration controls use the scoped v2 registration
  contract. Registration management uses the audited bulk participant action for removal and
  restoration, while standings rebuild starts and follows the persistent v2 task. No form fallback
  remains.
- The four-step contest editor now creates and updates through ETag-protected, idempotent v2 writes
  with the established problem permission, VJudge availability, administrator, time, and
  ranking-weight validations preserved. Contest deletion uses one Rating-aware audited service from
  the v2 DELETE contract.
- Profile follow and unfollow controls use idempotent v2 writes backed by a follower-serialized
  transaction that atomically appends the relationship event.
- Profile avatar upload and removal now use a bounded, raster-validated v2 multipart contract. The
  managed file replacement, avatar row, administrator audit record, and domain event are committed
  together; no non-v2 avatar form action remains.
- Ordinary self-service account settings use `/api/v2/me` with idempotency and a fresh ETag.
  Email, password, preferences, and partial completion of the campus identity profile share one
  transaction, while completed identity fields remain locked for ordinary users.
- Privileged account editing uses the protected `/api/v2/admin/users/:id` resource. Target,
  site-owner, peer-administrator, grant, and recent-login checks are repeated around locked state;
  the account row, campus identity, privilege compatibility projection, email-verification reset,
  audit record, and domain event commit together. Personal Hit visibility now uses its own locked,
  ETag-protected `/api/v2/me/hit-settings` resource with an atomic audit and event. Neither workflow
  has a non-v2 form fallback.
- Contest standings now persist immutable realtime/frozen/unfrozen/final/rebuild versions,
  keep separate live/public/frozen/final pointers, advance from submission and correction
  events, redact judge diagnostics outside manager/operator scope, and expose audited rebuild
  history. An existing ended contest was projected successfully; lifecycle, visibility,
  configuration-lock, and immutable snapshot policies are covered by the role and domain matrices.
  The production rollout and migration gate are complete.
- Contest configuration is now a revisioned resource for timezone, rules, per-problem scoring,
  visibility, security, registration, teams, and Rated Profile. It seeds existing contests,
  synchronizes required durable storage fields, freezes immutable problem snapshots at publish and reuses
  their references for contest submissions, and rejects critical changes after running. Lifecycle
  routes use explicit paths and preconditions, so registration endpoints are no longer shadowed
  by the former catch-all action route.
- Standings rebuild is now a persistent task with participant-level progress, cooperative
  cancellation, retry, restart recovery, a result version, and unified admin task visibility.
  Contest migration now prepares state, configuration, and standings projections and measures
  all three before reporting the contest domain consistent.
- Judge dispatch now leases queued work by contest priority, per-user quota, language pressure, and
  queue age; configured language slots act as relative capacity weights and age prevents starvation.
  Signed task envelopes bind language, limits, network/file policy, data version, payload, and the
  immutable problem snapshot ID. Local snapshots own a stable SHA-256 manifest and an immutable
  `testdata/snapshots/<snapshot-id>` directory on the Judge shared volume; dispatch materializes
  time/memory/type/file-I/O, VJudge source metadata, and this testdata path from the snapshot before
  queueing the task. Older snapshots are upgraded before dispatch and cannot silently fall back to
  a mutable directory. Dispatch outage keeps work queued with bounded backoff instead of
  fabricating a result. Compilable tasks include a signed cache-isolation key derived from source,
  language configuration, compiler image, and compiler version. Submission transitions now lock and update the projection, attempt record,
  and immutable event together; Judge projections receive replay checkpoints, system errors retry
  at most twice, and an audited, cancellable submission-projection rebuild task is available through
  the unified admin job API. New submissions persist an immutable source-code version in the same
  transaction as the compatibility row and projection. Detail responses expose source only to the
  owner, an explicitly public source policy, or `judge:read`; list responses do not load source text.
  Submission migration backfills code-version references and reports missing, orphaned, mismatched,
  or eventless versions without modifying production data until an administrator starts the job.
- Each v2 domain now has an enforced rollout gate after the foundation middleware. The
  unauthenticated rollout manifest remains readable, domain cohorts are deterministic,
  and a disabled domain returns the normal `API_DOMAIN_DISABLED` envelope rather than
  falling through to a partly-enabled route. Problem publishing and submission
  create/cancel are written through one transaction manager, so durable Judge rows,
  v2 projections, audit records, and immutable submission events roll back together.
- Judge operations now shows a capability-gated live queue with queued, compiling, and judging
  projections, oldest-first wait times, stale and dispatch-retry signals, responsive column
  priorities, and recoverable offline state while retaining the last successful snapshot.
- The white-first frontend shell is active. The Rating workspace is now deliberately limited to
  calculation status and one chronological action after invalid submissions are handled. Admin
  operations and VJudge still expose the broader task states; the shared shell and submission
  workspace now expose skip navigation, named dialog semantics, focus rings, keyboard-reachable
  table regions, selected controls, editor loading state, and offline recovery. The Playwright
  acceptance matrix now passes 56 renders across phone, tablet, landscape tablet, desktop,
  equivalent 200% zoom, light/dark themes, and reduced motion without overflow or runtime errors.
- The home page no longer renders or fetches the personalized training workbench and recent
  submissions. Its remaining contest, announcement, problem-search, banner, activity, and link
  sections use a rebalanced primary/aside layout for both anonymous and signed-in users.
- Username tiers now have one light/dark semantic palette loaded by both application shells.
  Header, home, standings, and registration names use the canonical server renderer, while exact
  same-origin profile links inserted dynamically receive the same tier through the shared client.
- Contest list, context, problem set, standings, and registration management now share the new
  unframed hierarchy, state filtering, accessible live progress, compact summaries, responsive
  layouts, and canonical username rendering. All user-facing contest-mode labels use `ACM`; the
  lowercase `icpc` Rating/storage identifiers remain only for compatibility.
- Community v2 routes now cover discussions, solution drafts/review, notifications, message
  conversations, clipboard sharing, tickets, announcements, and active banners. Notification
  read state, message delivery/settings, and ticket create/reply/assign/close now persist their
  domain event in the same transaction; ownership, manager assignment, closed-state, disabled
  recipient, and rollback branches are covered. Discussion creation/reply/locking now lock their
  aggregates, persist domain events atomically, and hide discussions attached to private problems
  from unauthorized readers. Clipboard create/update/share/delete now use owner row locks,
  `If-Match`, atomic audit/domain events, rotating bounded tokens, SQL-enforced expiry, and tested
  failure rollback. Solution drafts, editing, review submission, approval/rejection, comments,
  author/mention notifications, and audit/domain events now share aggregate transactions. Editing
  and review use one detail ETag, and author edits return to review. Private-problem visibility and
  disabled submission policy are enforced after locks;
  the API maps the legacy `accepted` storage state to the `approved` contract without breaking the
  existing frontend. Message conversations now use
  stable keyset cursors, message pages use bounded locked scans, and settings updates check ETags
  after locking. Announcement and Banner management writes atomically persist content, audit, and
  domain events; public active-window reads and moderation queues are live in the running container.
- The notification center uses v2 writes for read-all, single-read, and delete. Each mutation locks
  ownership and persists its domain event atomically; no non-v2 form fallback remains.
- Reply, new-conversation, and message-settings forms use v2 writes only. Message
  settings use a fresh ETag, every write carries an idempotency key, verified-email policy matches
  the established policy, and authorized account administrators retain the recipient-policy
  override without bypassing transactional row locks or domain events.
- Clipboard create, edit, share-link rotation, and delete forms use v2 writes with idempotency and
  fresh ETags. The v2 contract preserves the established editor's
  empty-note behavior, UTF-8 100 KiB limit, editable link expiry, and expiry-preserving token rotation.
- Ticket creation, replies, assignment, status transitions, user withdrawal, and administrator
  closure use idempotent v2 writes without a form fallback.
  Creation validates the exact category/subtype pair, related resource, report reason, default user
  relation, and per-user daily quota inside one transaction without losing legacy fields. Public
  operator replies and status transitions atomically update state, notify the creator, and append
  notification and ticket events; assignment, withdrawal, and closure also add visible timeline
  records. Internal notes remain manager-only, resource-scoped managers must own the assignment
  before replying or changing status, administrator closure requires a recent login, all terminal
  states reject replies, and member ticket reads filter internal notes.
- Admin content now includes capability-gated, audited, ETag-protected announcement, banner,
  help, link, and allowlisted configuration workflows. Announcement, banner, and link writes use
  capability checks, recent-login protection where required, audit records, and v2 contracts.
- Problem list/detail/version reads now honor public, owner, and persistent problem-scoped grants;
  version history is cursor-paginated. ZIP bulk import has been removed; bulk removal archives
  problems without deleting submissions, snapshots, discussions, or data.
- Clipboard, tags, problem solutions, solution review queues, discussion replies, ticket replies,
  Rating history, contest Rating overrides, contest snapshots/participants/standings, submission
  revisions, VJudge imports, and administrative collections now use bounded keyset cursors and
  consistently expose `limit` plus nullable `next_cursor` metadata.
- Administrative writes for users, contests, community moderation, cross-user settings,
  message-policy overrides, and account tags authorize through the shared capability service.
  Remaining `is_admin` references represent stored account state or read-only presentation.
- Submission cheat/cancel/revoke/restore actions now use scoped capabilities, require recent login,
  generate audit descriptions automatically, and emit immutable audit/domain events. Their controls are driven by the same server
  authorization decision on both practice and contest submission pages.
- The deployment is explicitly scoped to a small group of trusted campus administrators. System
  operations no longer ask for handwritten reasons; review rejections that must guide an author remain required.
- Contest deletion now removes the contest and its dependent submissions/registrations in one
  transaction. Deleting a Rated contest restores the correct Rating baseline and recalculates all
  later ended Rated contests chronologically; the delete is rejected if pending judgements make a
  safe replay impossible.
- Problem pages now share one compact context header with stable contest countdown, wrapping
  facts/actions, a single active horizontal navigation rail, and a full-width Markdown statement.
  The application shell adds a keyboard-accessible command panel without restoring topbar search.
- The problem library keeps search, source/state/tag filters, sorting, pagination, and bulk
  actions without retaining local saved-view state.
- Contest creation and editing now use four validated steps for basics, problems/managers,
  schedule/rules, and save or publish confirmation. The final step summarizes the exact selected
  entities and settings while submitting only to v2 resources.
- Admin lists now share toolbar/table-region structure and responsive column priorities. Banner
  edit/delete forms use independent valid rows, and the solution review queue exposes status.
- Application CSS now has explicit shell, shared-component, and feature-workflow ownership.
  Rendered Markdown and username tiers each have one canonical style source, and all 94 mounted EJS
  templates compile with the running Web container's EJS engine.
- Web and Judge Control now use the same pinned SYZOJ Web repository digest, guarded by
  release-version tests so upstream image drift cannot silently change the UI.
- The current automated suite passes 389 unit and profile tests plus UOJ/HDU/POJ adapter and protocol tests.
