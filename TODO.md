# NWPUOJ UI Remediation

Updated: 2026-07-31

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
- [x] Add shared design tokens for colors, spacing, borders, radii, focus rings, and table density in `custom/app-shell.css`, `custom/app-shared.css`, and `custom/app-features.css`.
- [x] Add reusable page header, toolbar, segmented control, table region, metadata, status badge, and empty-state classes.
- [x] Fix main/footer document structure and replace the three-line low-contrast footer with one compact metadata row.
- [x] Remove the global body scroll override that breaks modal scroll locking.
- [x] Normalize sidebar icon alignment, active state, focus state, and mobile top-bar truncation.
- [x] Restore intentional responsive behavior in the active application styles; dense tables may scroll locally, but the document must not scroll horizontally.
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
- [x] Add browser-persisted saved problem views without changing filter URLs or server behavior.
- [x] Give `# / H / U` problem groups a restrained divider header and visible item count.
- [x] Wrap problem tags inside the title cell instead of floating them.
- [x] Add a filter-preserving pagination control above the problem list with unique navigation IDs.
- [x] Replace the empty contest action form with a compact page action toolbar.
- [x] Add contest row metadata for type, status, schedule, and registration state on mobile.
- [x] Make contest rank and username columns sticky while problem columns scroll horizontally.
- [x] Replace clipped ribbon ranks with contained medal badges.
- [x] Add a persisted Rated switch, show Rated/Unrated in contest UI, and calculate ended Rated contests only after an administrator confirms invalid submissions are handled.
- [x] Convert contest create/edit into four validated steps with a final save/publish summary.

Acceptance:

- Problem repository controls remain directly below the title with the requested `0.5cm` spacing.
- Contest names, status, and primary actions remain visible at 360px.
- Contest score columns never become misaligned for ACM, NOI, or IOI modes.

## P1 - Ranklists, Discussion, And Content

- [x] Dismissed Markdown editor drafts are removed so admin help does not prompt on every visit.
- [x] Replace the ranklist tab bar with a two-option segmented mode control and align user search in the same toolbar.
- [x] Apply responsive table regions and explicit column priorities to global ranklists.
- [x] Rebuild discussion headers around board mode, breadcrumb, and post action without the fixed Semantic grid.
- [x] Rebuild article metadata/actions as a wrapping header and remove floats inside paragraph markup.
- [x] Keep solution content, moderation, comments, pagination, and reply form in one page container.
- [x] Let moderation controls wrap cleanly and prevent the rejection field from forcing overflow.
- [x] Use side-by-side editor/preview on wide screens and tabbed mode on narrow screens.
- [x] Keep draft state visible without shifting editor actions.

Acceptance:

- Long titles, usernames, and rejection reasons do not overlap controls.
- Content pages retain a readable line length while code and tables can use wider regions.
- Empty discussions and solution lists use compact, consistent empty states.

## P1 - Problem And Contest Context

- [x] Replace centered Semantic grids and negative margins with compact context headers.
- [x] Put title, type, timing, countdown, and management actions into wrapping title/meta rows.
- [x] Convert section navigation to an accessible horizontal rail with one active item.
- [x] Ensure contest submission history does not display two active navigation items.
- [x] Rebuild the submit workspace with stable editor dimensions and a one-column mobile layout.

Acceptance:

- Context navigation scrolls locally on narrow screens and never overlaps the title.
- Monaco retains at least 360px or approximately 50dvh of usable height on mobile.
- Countdown updates do not change the header's height.

## P2 - Admin And Maintenance

- [x] Disable account badge display, self-service editing, and administration while preserving historical database records.
- [x] Replace single-contest Rating tools with a status-only backend page and one chronological calculation action.
- [x] Replace user-rating labels named "积分" with "Rating" across public and admin views.
- [x] Apply shared admin toolbar, table region, and responsive column priorities to all admin lists.
- [x] Fix invalid cross-cell form markup in banner management.
- [x] Add a visible Status column to the all-solutions review view.
- [x] Remove obsolete inline styles after each page migrates to shared classes.
- [x] Split shell, shared UI, and feature-specific CSS ownership.
- [x] Deduplicate username tag CSS and Markdown presentation styles.
- [x] Pin the SYZOJ Web image digest after UI verification to prevent upstream CSS drift.

## Verification Checklist

- [x] Run `node --check` on modified modules and scripts.
- [x] Compile/render modified EJS templates through the actual Web container.
- [x] Run `docker compose config --quiet` and `git diff --check`.
- [x] Verify anonymous, user, reviewer, and administrator branches where affected.
- [x] Check 360x800, 768x1024, 1024x768, and 1440x900 viewports.
- [x] Verify keyboard navigation, focus indicators, modal scroll lock, table scrolling, and mobile sidebar behavior.
- [x] Confirm Web health and `RestartCount` after deployment.

## Verification Notes

- Anonymous page rendering is verified for submissions, problems, contests, global ranklist, discussion, solution list, and contest ranklist.
- Authenticated rendering is verified for the submissions scope control, article editor, solution editor, one-time content tokens, and draft/action toolbars.
- Markdown preview, review concurrency, and article/solution comment transactions were verified before the visual pass and remain covered by unchanged route contracts.
- Playwright Chromium completed 56 valid renders across phone, tablet, landscape tablet, desktop,
  equivalent 200% zoom, light/dark themes, and reduced motion. No horizontal overflow, control
  overflow, broken images, duplicate IDs, unnamed icon buttons, theme mismatch, or page errors were
  reported. The compact 186px sidebar and full brand name were also inspected after the final fix.

## Major Release Closeout (v2.0.0)

目标：在当前迁移证据和 v2-only 运行态基础上，完成 v1 物理清理、发布验证和可回滚的大版本交付。以下任务全部完成后，才可将版本标记为完整大版本。

当前基线：题目 `11084/11084`、身份 `7/7`、提交 `30/30`、比赛 `2/2` 投影一致；完整比赛周期和回退演练证据已保留；Web 运行时已启用 `SYZOJ_V2_ONLY=true`。兼容清单为零 v1 API 读取、零 v1 写路由、零旧表单、零旧客户端调用和零兼容适配器。

- [x] 盘点兼容清单中的每个旧路由、表单动作和适配器，标记为“删除”“保留只读/评测回调”或“必须先迁移”，并为每项绑定 v2 替代接口和测试。
- [x] 按身份、题库、提交、比赛、Rating、VJudge、内容和管理域逐项删除旧写入路由、旧表单 fallback、旧客户端调用及无必要的兼容适配器；唯一保留的 `/judge` 是签名保护的内部评测回调。
- [x] 清理 `module-order.js`、Compose 挂载、构建产物和无引用模板/模块，确保删除后的 v1 文件不会被运行时加载；禁止通过旧路由绕回 HTML 或旧写入逻辑。
- [x] 将兼容清单收敛到零旧客户端写入、零未批准旧写入路径和零兼容适配器，并由 `compatibility_inventory.test.js` 持续门禁。
- [x] 完成匿名、普通用户、参赛者、题目审核、比赛管理员、评测操作员、站点管理员和所有者的 v2-only 端到端矩阵；覆盖创建、编辑、发布、删除/归档、提交、重测、Rating、VJudge 导入和权限拒绝。
- [x] 在 Playwright Chromium 完成 `360x800`、`768x1024`、`1024x768`、`1440x900`、200% 缩放、深色模式和减少动画检查，并验证焦点、滚动锁、表格局部滚动、移动侧栏、离线恢复和图标渲染。
- [x] 完成生产形态发布演练：全栈健康，短时 ACM 比赛 `#900061` 完成 1 名参赛者和 1 次有效提交后删除，SHA-256 周期证据和回滚演练证据已保留；Rating/通知/删除重算由事务与回归测试覆盖。
- [x] 更新 `README.md`、发行版本、变更记录、部署文档和回滚手册，明确 v2 API、v1 删除范围、内部 Judge 回调、数据备份和恢复步骤，并同步版本到 `v2.0.0`。
- [x] 运行 `npm test`、94 个模板编译、兼容清单生成、`docker compose config`、`git diff --check` 和 Web/Judge Control/Worker 健康检查；代码与运行态发布门禁已满足，发布提交和 `v2.0.0` 标签由仓库管理员创建。
