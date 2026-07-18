# NWPUOJ UI Remediation

Updated: 2026-07-17

## Goals

- Build a quiet, professional interface for repeated OJ workflows rather than a marketing-style site.
- Improve visual hierarchy, typography, spacing, color semantics, responsive behavior, and interaction clarity together.
- Keep dense information easy to scan without relying on nested cards or excessive shadows.
- Preserve all existing permissions, filters, contest rules, URLs, and database behavior.

## Visual Direction

- Background: neutral cool gray with white work surfaces and restrained borders.
- Primary accent: blue only for navigation, links, and primary actions.
- Semantic colors: green for success, amber for waiting, red for failure, violet for system errors, gray for inactive/cancelled states.
- Typography: compact page titles, 14px operational body text, tabular numerals for scores/times, zero letter spacing.
- Shape: 4-6px control radius, no decorative floating sections, no card nesting.
- Density: 44px table rows on desktop where possible, larger touch targets only on mobile.

## P0 - Shared Foundation

- [x] Audit the shell, high-frequency pages, responsive rules, and Semantic UI conflicts.
- [x] Add shared design tokens for colors, spacing, borders, radii, focus rings, and table density in `custom/ui-system.css`.
- [x] Add reusable page header, toolbar, segmented control, table region, metadata, status badge, and empty-state classes.
- [x] Fix main/footer document structure and replace the three-line low-contrast footer with one compact metadata row.
- [x] Remove the global body scroll override that breaks modal scroll locking.
- [x] Normalize sidebar icon alignment, active state, focus state, and mobile top-bar truncation.
- [x] Restore intentional responsive behavior in `custom/mobile.css`; dense tables may scroll locally, but the document must not scroll horizontally.
- [x] Add visible keyboard focus and respect `prefers-reduced-motion`.
- [x] Add consistent page gutters and vertical rhythm between headings, controls, messages, content, and lists.
- [x] Give list/table regions complete side borders, rounded clipping, inner cell padding, and surrounding whitespace.
- [x] Replace pale-blue table surfaces with neutral gray headers, neutral hover states, stronger borders, and roomier header padding.
- [x] Render Compile Error as an amber/yellow warning state while keeping runtime and answer failures red.
- [x] Align all judge-result colors with Luogu's production RecordStatus palette, including distinct AC, WA, CE, RE, limit, waiting, judging, and unknown states.

Acceptance:

- No page-level horizontal overflow at 360px, 768px, 1024px, or desktop widths.
- Body scrolling locks correctly while Semantic UI modals or the mobile sidebar are open.
- Text and controls do not overlap at 200% zoom.
- Muted text and interactive states remain readable against the neutral background.

## P0 - Submissions

- [x] Replace the standalone "我的提交" command with an "全部 / 我的" segmented filter.
- [x] Use a responsive filter grid with consistent field widths and a visually separate action group.
- [x] Keep "筛选 / 清除" together and preserve contest/query parameters.
- [x] Put the submissions table in a focusable scroll region with a sticky header.
- [x] Add explicit column priority classes shared by the EJS header and Vue row template.
- [x] Keep ID, problem, status, and score visible on mobile; hide lower-priority usage columns.
- [x] Standardize `Accepted`, pending, failed, cancelled, and cheated visual states.

Acceptance:

- Desktop filters form one balanced toolbar without orphaned buttons.
- On mobile the filter controls stack cleanly and the action group remains a single row.
- Selecting "我的" submits the current filters with the logged-in username; selecting "全部" clears only the submitter filter.
- Dynamic judging updates do not resize or shift table columns.

## P0 - Problems And Contests

- [x] Convert repository and progress switches to horizontally scrollable segmented controls.
- [x] Give `# / H / U` problem groups a restrained divider header and visible item count.
- [x] Wrap problem tags inside the title cell instead of floating them.
- [x] Add a filter-preserving pagination control above the problem list with unique navigation IDs.
- [x] Replace the empty contest action form with a compact page action toolbar.
- [x] Add contest row metadata for type, status, schedule, and registration state on mobile.
- [x] Make contest rank and username columns sticky while problem columns scroll horizontally.
- [x] Replace clipped ribbon ranks with contained medal badges.
- [x] Add a persisted Rated switch, show Rated/Unrated in contest UI, and restrict automatic Rating finalization to Rated contests.

Acceptance:

- Problem repository controls remain directly below the title with the requested `0.5cm` spacing.
- Contest names, status, and primary actions remain visible at 360px.
- Contest score columns never become misaligned for ACM, NOI, or IOI modes.

## P1 - Ranklists, Discussion, And Content

- [x] Replace the ranklist tab bar with a two-option segmented mode control and align user search in the same toolbar.
- [x] Apply responsive table regions and explicit column priorities to global ranklists.
- [x] Rebuild discussion headers around board mode, breadcrumb, and post action without the fixed Semantic grid.
- [x] Rebuild article metadata/actions as a wrapping header and remove floats inside paragraph markup.
- [x] Keep solution content, moderation, comments, pagination, and reply form in one page container.
- [x] Let moderation controls wrap cleanly and prevent the rejection field from forcing overflow.
- [ ] Use side-by-side editor/preview on wide screens and tabbed mode on narrow screens.
- [x] Keep draft state visible without shifting editor actions.

Acceptance:

- Long titles, usernames, and rejection reasons do not overlap controls.
- Content pages retain a readable line length while code and tables can use wider regions.
- Empty discussions and solution lists use compact, consistent empty states.

## P1 - Problem And Contest Context

- [ ] Replace centered Semantic grids and negative margins with compact context headers.
- [ ] Put title, type, timing, countdown, and management actions into wrapping title/meta rows.
- [ ] Convert section navigation to an accessible horizontal rail with one active item.
- [ ] Ensure contest submission history does not display two active navigation items.
- [ ] Rebuild the submit workspace with stable editor dimensions and a one-column mobile layout.

Acceptance:

- Context navigation scrolls locally on narrow screens and never overlaps the title.
- Monaco retains at least 360px or approximately 50dvh of usable height on mobile.
- Countdown updates do not change the header's height.

## P2 - Admin And Maintenance

- [x] Disable account badge display, self-service editing, and administration while preserving historical database records.
- [x] Remove manual single-contest Rating calculation and make the backend Rating page read-only.
- [x] Replace user-rating labels named "积分" with "Rating" across public and admin views.
- [ ] Apply shared admin toolbar, table region, and responsive column priorities to all admin lists.
- [ ] Fix invalid cross-cell form markup in banner management.
- [ ] Add a visible Status column to the all-solutions review view.
- [ ] Remove obsolete inline styles after each page migrates to shared classes.
- [ ] Split shell, shared UI, and feature-specific CSS ownership.
- [ ] Deduplicate username tag CSS and Markdown presentation styles.
- [ ] Pin the SYZOJ Web image digest after UI verification to prevent upstream CSS drift.

## Verification Checklist

- [x] Run `node --check` on modified modules and scripts.
- [x] Compile/render modified EJS templates through the actual Web container.
- [x] Run `docker compose config --quiet` and `git diff --check`.
- [ ] Verify anonymous, user, reviewer, and administrator branches where affected.
- [ ] Check 360x800, 768x1024, 1024x768, and 1440x900 viewports.
- [ ] Verify keyboard navigation, focus indicators, modal scroll lock, table scrolling, and mobile sidebar behavior.
- [x] Confirm Web health and `RestartCount` after deployment.

## Verification Notes

- Anonymous page rendering is verified for submissions, problems, contests, global ranklist, discussion, solution list, and contest ranklist.
- Authenticated rendering is verified for the submissions scope control, article editor, solution editor, one-time content tokens, and draft/action toolbars.
- Markdown preview, review concurrency, and article/solution comment transactions were verified before the visual pass and remain covered by unchanged route contracts.
- Firefox headless screenshot capture is currently blocked by the host Snap mount namespace policy. Multi-viewport screenshot review therefore remains unchecked and must be completed in a browser-capable environment.
