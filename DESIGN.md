# NWPUOJ 2.0 全量重构设计方案

> 状态：已实现（v2-only 运行态已启用）
>
> 范围：前台 UI、后端接口、权限模型、评测编排、VJudge、比赛、Rating、管理后台全部重新设计。

## 1. 目标与原则

NWPUOJ 2.0 不以现有页面、路由和数据库结构为设计前提。现有功能作为能力清单保留，交互、服务边界、接口契约和权限规则全部重新定义。

本实例定位为校内 OJ，由少量可信管理员维护。管理端优先降低重复录入：帮助页、Rating、导入、重建、归档、权限和运行任务等系统操作不要求人工填写原因，审计记录由系统根据操作类型、对象、操作者和请求路径自动生成。审核拒绝等需要向内容作者提供修改依据的场景，仍必须填写可执行的反馈原因。

### 1.1 产品目标

- 让学生可以用最少步骤完成“发现题目 -> 编码 -> 提交 -> 复盘”。
- 让比赛管理员可以在一个工作台完成建赛、报名、监控、裁判和赛后结算。
- 让题目管理员可以安全维护题面、数据、标签、版本和来源。
- 让站点管理员可以看见系统健康度、风险、队列和审计记录。
- 保持评测结果、比赛排名、Rating 和外部题库导入的可追溯性。

### 1.2 设计原则

1. API 优先：页面只是 API 的一个客户端，所有重要操作都有明确的资源和状态。
2. 默认拒绝：没有显式权限、作用域和策略就不能执行操作。
3. 事件驱动：提交、评测、比赛、Rating 和批量导入都由不可变事件驱动状态变化。
4. 可恢复：任务可重试、可取消、可断点续跑，用户不会因为刷新或短暂断线丢失进度。
5. 可解释：每次拒绝、排名变化、Rating 变化和评测失败都能给出原因。
6. 先模块化单体：第一阶段保持一个 Web 部署单元，但按领域边界拆分模块，后续可以独立扩展。

## 2. 总体架构

```text
Browser / Mobile
        |
 API Gateway + Session/Auth + Rate Limit
        |
 ┌──────┼────────┬────────┬────────┬────────┬──────────┐
 │      │        │        │        │        │          │
题库域  提交域   比赛域   Rating域  VJudge域  管理域   社区域
 │      │        │        │        │        │          │
 └──────┴────────┴────────┴────────┴────────┴──────────┘
        |
 Event Bus / Job Queue / Audit Log
        |
 MariaDB + Redis + Object Storage + Judge Control
```

### 2.1 领域模块

| 模块 | 负责内容 |
| --- | --- |
| Identity | 用户、组织、团队、会话、MFA、登录风险 |
| Authorization | 角色、权限、作用域、策略评估、授权审计 |
| Problem | 题目、题目版本、测试数据、标签、题解、来源 |
| Submission | 提交、代码版本、可见性、重提和用户历史 |
| Judge | 编译、沙箱、测试点、结果事件、队列和 Worker |
| Contest | 比赛生命周期、报名、题目快照、排行榜、赛后结算 |
| Rating | Rating Profile、比赛结算、重算、历史和赛季 |
| VJudge | 远程账号、题面导入、远程提交、同步和限流 |
| Content | 公告、Banner、讨论、工单、站内信、通知 |
| Admin | 系统配置、运营任务、风险、审计、批量任务 |

### 2.2 API 基础约定

- 新 API 前缀：`/api/v2`。
- 所有响应统一为：

```json
{
  "data": {},
  "meta": { "request_id": "req_..." },
  "error": null
}
```

- 错误统一为：

```json
{
  "data": null,
  "meta": { "request_id": "req_..." },
  "error": {
    "code": "CONTEST_LOCKED",
    "message": "比赛已经开始，题目集合不能修改。",
    "fields": {}
  }
}
```

- 列表使用 `cursor`、`limit`、`next_cursor`，不再依赖页码作为唯一分页方式。
- 写操作支持 `Idempotency-Key`。
- 可编辑资源支持 `ETag` 和 `If-Match`，防止管理员覆盖他人修改。
- 时间统一使用 ISO 8601 UTC，展示层按用户时区转换。
- 资源删除默认使用归档，物理删除必须使用高危权限和二次认证。
- 所有写操作返回 `operation_id`，异步任务通过任务资源和 SSE 查询进度。

## 3. 身份与权限重设计

### 3.1 身份模型

用户不再直接依赖 `is_admin` 作为唯一判断。授权由以下对象组成：

- `User`：个人身份和账号状态。
- `Organization`：学校、学院或竞赛组织。
- `Team`：比赛队伍或训练小组。
- `Role`：一组权限的命名集合。
- `Grant`：某用户/团队在某作用域下获得某角色。
- `Policy`：额外条件，例如比赛时间、题目可见性或 IP 风险。
- `AuditEvent`：授权和高危操作的不可变记录。

### 3.2 内置角色

| 角色 | 默认作用域 | 能力 |
| --- | --- | --- |
| guest | 全局 | 查看公开题目、公开比赛和公开讨论 |
| member | 全局 | 提交题目、报名比赛、发布个人内容 |
| participant | 单场比赛 | 查看比赛内容、提交比赛代码、查看本人结果 |
| problem_editor | 题目/题库 | 编辑题面、标签、版本和测试数据 |
| problem_reviewer | 题目/题库 | 审核题目、发布版本、阻止危险变更 |
| contest_manager | 单场比赛/组织 | 建赛、报名管理、比赛监控和赛后处理 |
| judge_operator | 全局 | 查看评测服务、重启 Worker、处理评测任务 |
| content_moderator | 全局/社区 | 审核题解、讨论、公告和工单 |
| rating_manager | 全局/赛季 | 发布 Rating、重算和修正异常结果 |
| vjudge_manager | 全局 | 管理外部账号、导入任务和远程提交策略 |
| site_admin | 全局 | 用户、权限、内容和系统配置 |
| owner | 全局 | 站点所有权、管理员任命、密钥和不可逆操作 |

### 3.3 权限格式

权限采用 `资源:动作`，作用域单独存储：

```text
problem:read
problem:create
problem:edit
problem:publish
problem:testdata.write
submission:create
submission:rejudge
judge:read
judge:worker.restart
contest:create
contest:edit
contest:publish
contest:registration.manage
contest:standings.rebuild
rating:publish
rating:recalculate
vjudge:source.manage
vjudge:import.create
admin:user.manage
admin:permission.grant
admin:config.write
audit:read
```

### 3.4 授权规则

1. 未登录用户只能访问公开资源。
2. 资源所有者只能操作自己的资源，除非获得更高作用域授权。
3. 比赛管理员只拥有该场比赛的权限，不能借此修改全局题库或其他比赛。
4. 题目管理员只能修改被授权题目，发布题目需要 `problem:publish`。
5. `site_admin` 默认不能执行 Rating 发布、密钥读取和所有权转移，必须单独授予。
6. 高危操作要求近期登录或 MFA：删除题目、重算 Rating、重启 Worker、批量导入、修改站点管理员。
7. 所有权限判断必须经过统一 `authorize(subject, action, resource, context)`，页面不能自行判断角色。
8. 权限变化立即生效；已有会话不会永久缓存授权结果。
9. 拒绝响应必须返回稳定错误码，前端根据错误码展示可操作的下一步。

## 4. 核心 API 设计

### 4.1 身份

```text
POST   /api/v2/auth/login
POST   /api/v2/auth/logout
GET    /api/v2/auth/session
POST   /api/v2/auth/mfa/challenge
POST   /api/v2/auth/mfa/verify
POST   /api/v2/auth/password/reset
GET    /api/v2/me
PATCH  /api/v2/me
GET    /api/v2/me/hit-settings
PATCH  /api/v2/me/hit-settings
PATCH  /api/v2/me/user-tag
GET    /api/v2/me/notifications
GET    /api/v2/users/:id/hit-history
```

登录响应只返回会话状态，不返回密码、权限全量列表或敏感配置。权限通过：

```text
GET /api/v2/me/capabilities?context=contest:123
```

### 4.2 题库与题目

```text
GET    /api/v2/problems
POST   /api/v2/problems
GET    /api/v2/problems/:id
PATCH  /api/v2/problems/:id
POST   /api/v2/problems/:id/publish
POST   /api/v2/problems/:id/unpublish
POST   /api/v2/problems/:id/archive
GET    /api/v2/problems/:id/versions
POST   /api/v2/problems/:id/versions
POST   /api/v2/problems/:id/testdata/validate
POST   /api/v2/problems/:id/testdata/upload
DELETE /api/v2/problems/:id/testdata/files/:filename
GET    /api/v2/problems/:id/solutions
POST   /api/v2/problems/bulk-actions
GET    /api/v2/tags
POST   /api/v2/tags
```

题目发布必须产生不可变 `ProblemSnapshot`，比赛和提交引用快照，而不是直接引用会变化的当前题目。

### 4.3 提交与评测

```text
POST   /api/v2/problems/:id/submissions
POST   /api/v2/contests/:id/problems/:pid/submissions
GET    /api/v2/submissions
GET    /api/v2/submissions/:id
POST   /api/v2/submissions/:id/rejudge
POST   /api/v2/submissions/:id/cancel
POST   /api/v2/submissions/events           # batch SSE with signed status credentials
GET    /api/v2/submissions/:id/events       # SSE
GET    /api/v2/submissions/:id/testpoints
```

提交请求：

```json
{
  "language": "cpp20",
  "source": "...",
  "source_visibility": "private",
  "client_request_id": "submit_..."
}
```

### 4.4 比赛

```text
GET    /api/v2/contests
POST   /api/v2/contests
GET    /api/v2/contests/:id
PATCH  /api/v2/contests/:id
DELETE /api/v2/contests/:id
POST   /api/v2/contests/:id/review
POST   /api/v2/contests/:id/publish
POST   /api/v2/contests/:id/start
POST   /api/v2/contests/:id/freeze
POST   /api/v2/contests/:id/end
POST   /api/v2/contests/:id/register
DELETE /api/v2/contests/:id/register
GET    /api/v2/contests/:id/participants
POST   /api/v2/contests/:id/participants/bulk-action
GET    /api/v2/contests/:id/standings
POST   /api/v2/contests/:id/standings/rebuild
GET    /api/v2/contests/:id/events       # SSE
```

比赛题目使用 `ContestProblemSnapshot`，比赛开始后禁止修改题目集合、计分规则和 Rated 属性。

### 4.5 Rating

```text
GET    /api/v2/rating/profiles
GET    /api/v2/rating/leaderboard
GET    /api/v2/users/:id/rating-history
POST   /api/v2/contests/:id/rating/preview
POST   /api/v2/contests/:id/rating/publish
POST   /api/v2/rating/jobs/recalculate
GET    /api/v2/rating/jobs/:id
POST   /api/v2/rating/adjustments
```

用户社交关系使用幂等写入：

```text
POST   /api/v2/users/:id/follow
DELETE /api/v2/users/:id/follow
POST   /api/v2/users/:id/avatar
DELETE /api/v2/users/:id/avatar
```

Rating 变化必须通过 `RatingEvent` 记录，禁止直接覆盖用户当前分数。

### 4.6 VJudge

```text
GET    /api/v2/vjudge/sources
POST   /api/v2/vjudge/sources
POST   /api/v2/vjudge/sources/:id/test-connection
POST   /api/v2/vjudge/sources/:id/imports
GET    /api/v2/vjudge/imports
GET    /api/v2/vjudge/imports/:id
POST   /api/v2/vjudge/imports/:id/cancel
POST   /api/v2/vjudge/problems/:id/submissions
GET    /api/v2/vjudge/remote-problems/:source/:remote_id
```

外部平台账号只保存加密引用，不允许 API 返回明文。导入和远程提交均通过异步任务执行。

### 4.7 管理与审计

```text
GET    /api/v2/admin/overview
GET    /api/v2/admin/health
GET    /api/v2/admin/audit-events
GET    /api/v2/admin/users
GET    /api/v2/admin/users/:id
PATCH  /api/v2/admin/users/:id
DELETE /api/v2/admin/users/:id
POST   /api/v2/admin/users/:id/disable
POST   /api/v2/admin/users/:id/enable
POST   /api/v2/admin/users/:id/roles
GET    /api/v2/admin/judge-workers
POST   /api/v2/admin/judge-workers/:id/restart
POST   /api/v2/admin/services/web/restart
GET    /api/v2/admin/jobs
POST   /api/v2/admin/jobs/:id/cancel
GET    /api/v2/admin/announcements
POST   /api/v2/admin/announcements
GET    /api/v2/admin/banners
POST   /api/v2/admin/banners
POST   /api/v2/admin/banners/upload
```

任何管理写操作都必须返回 `audit_event_id`。

## 5. 评测逻辑重设计

### 5.1 提交状态机

```text
created
  -> queued
  -> compiling
  -> judging
  -> accepted / wrong_answer / runtime_error / time_limit / memory_limit
  -> system_error / cancelled
```

每次状态变化写入 `SubmissionEvent`，状态接口只读当前投影，事件用于审计和重建。

### 5.2 评测编排

- Scheduler 根据比赛优先级、用户配额、语言资源和队列年龄分配任务。
- 每个任务绑定语言版本、资源限制、网络策略、文件策略和测试数据版本。
- Worker 只执行签名任务，不接受浏览器直接传入的任意参数。
- 编译缓存按源码哈希、语言配置和编译器镜像版本隔离。
- 系统错误自动重试，用户代码错误不重试。
- 评测结果采用公开字段和受保护字段分离，前端只能读取当前权限允许的投影。
- 管理员重测保留原评测结果，并由系统自动记录操作者、对象和操作类型。
- 评测服务不可用时提交进入 `queued`，不会伪造失败结果。

### 5.3 结果可见性

| 场景 | 普通用户 | 比赛参赛者 | 比赛管理员 | 评测管理员 |
| --- | --- | --- | --- | --- |
| 本人终态 | 完整 | 完整 | 完整 | 完整 |
| 他人终态 | 按公开策略 | 比赛策略 | 完整 | 完整 |
| 测试点详情 | 按题目策略 | 比赛策略 | 完整 | 完整 |
| 编译日志 | 本人 | 本人 | 可配置 | 完整 |
| Worker 诊断 | 不可见 | 不可见 | 摘要 | 完整 |

## 6. VJudge 重设计

### 6.1 Provider Adapter 契约

每个平台实现统一接口：

```text
checkAccount()
searchProblems(query)
fetchProblem(remoteId)
fetchProblemList(cursor)
submit(remoteProblem, language, source)
pollSubmission(remoteSubmissionId)
normalizeResult(rawResult)
```

### 6.2 导入流程

```text
选择平台
  -> 测试账号
  -> 选择单题/批量
  -> 预览题目和冲突
  -> 设置可见性与标签
  -> 创建导入任务
  -> 实时进度
  -> 成功/跳过/失败
  -> 可重试失败项
```

规则：

- 每个平台独立限流、重试和凭据。
- 远程题目使用 `source + remote_id` 唯一键。
- 导入任务可取消、可恢复，已完成题目不会重复写入。
- 比赛使用 VJudge 题目必须显式开启比赛策略。
- 远程提交记录上游任务 ID、本地提交 ID 和同步事件。
- 上游错误不会被伪装成本地评测错误。

## 7. 比赛系统重设计

### 7.1 生命周期

```text
draft -> review -> scheduled -> running -> frozen -> ended -> rated -> archived
```

每次状态转换需要对应权限、前置条件和审计事件。

### 7.2 比赛配置

- 基础信息：标题、说明、时区、起止时间。
- 题目集合：题目快照、顺序、别名、分值、罚时。
- 规则：ACM、IOI、NOI、自定义计分。
- 参赛策略：公开、邀请、白名单、团队、迟到报名。
- 可见性：题面、代码、提交、排行榜、测试点和他人结果。
- 安全：IP 限制、设备策略、异常提交标记。
- Rating：Profile、Rated 条件、结算延迟和预览。

### 7.3 排行榜

- 使用事件投影，不在请求时重新扫描全部提交。
- 支持实时榜、冻结榜、解冻榜和最终榜。
- 每次重建生成新版本，保留旧版本用于审计。
- 参赛者只能读取允许字段，管理员可以查看完整诊断。

## 8. Rating 重设计

### 8.1 Rating Profile

站点支持多个互相隔离的 Rating Profile：

- `icpc`：ACM/ICPC 比赛。
- `ioi`：基于得分的比赛。
- `practice`：训练赛，可选计入。
- `vjudge`：外部题库比赛，可独立配置。

### 8.2 计算规则

- 默认采用 Glicko-2，并公开参数、初始分、波动率和不确定度。
- 每场比赛先生成 `RatingPreview`，管理员确认后才能发布。
- 结算结果写入不可变 `RatingEvent`，当前分数是事件投影。
- 取消、作弊、资格取消和赛后修正都通过反向事件处理，禁止直接改历史记录。
- 重算是可追踪的异步 Job，支持预览差异、批准和回滚投影。
- Rating 发布后向分数发生变化的参赛者发送通知，包含比赛、前后 Rating 和增减值；
  重算只更新当前有效通知，重复执行不得重复投递，删除比赛触发重算时必须说明被删除的比赛。
- Rating 发布权限独立于普通比赛管理权限。

## 9. 管理后台重设计

后台首页改为运维工作台，而不是功能链接列表：

```text
系统健康 | 评测队列 | 待审核内容 | 批量任务 | 风险事件 | 最近审计
```

### 9.1 页面分组

- 概览：系统指标、告警、任务和最近操作。
- 用户与权限：用户、角色、授权、登录风险、会话。
- 题目：题目、版本、测试数据、标签、审核。
- 比赛：比赛、报名、排行榜、临时账号、Rating。
- 评测：Worker、队列、失败任务、重测。
- 外部平台：UOJ、HDU、POJ 账号和导入任务。
- 内容：公告、Banner、题解、讨论、工单。
- 系统：配置、密钥引用、维护窗口、审计。

### 9.2 批量任务统一模型

所有导入、重算、批量删除、重建排行榜都使用统一任务面板：

- `queued / running / paused / cancelling / completed / failed / cancelled`
- 任务详情、进度、当前对象、失败列表、重试按钮
- 谁创建、谁批准、预计影响范围
- 任务可取消但不可伪造完成

## 10. 前端 UI 结构

### 10.1 应用壳

- 左侧工作区导航、顶部当前上下文、右侧个人和通知。
- 页面标题、状态、主操作和次要操作统一布局。
- 不使用页面套页面的卡片嵌套。
- 表格、抽屉、命令面板、步骤条和状态标签为基础组件。
- 复杂编辑页使用分组和步骤，不使用长页面堆叠表单。

### 10.2 关键页面

| 页面 | 新交互 |
| --- | --- |
| 首页 | 继续做题、比赛、评测和公告的工作台 |
| 题库 | 搜索、筛选、保存视图、批量操作 |
| 题目 | 题面保持单列完整 Markdown 流，提交进入独立稳定编辑工作区 |
| 提交 | 实时状态流、错误解释、重提和对比 |
| 比赛 | 题目、排行榜、提交、公告同一工作区 |
| 建赛 | 基本信息、题目、规则、发布确认步骤 |
| 评测 | 队列和 Worker 实时监控 |
| VJudge | 平台标签页、连接、导入任务、失败重试 |
| Rating | 预览、批准、发布、历史和差异 |
| 后台 | 告警和任务优先，而不是菜单优先 |

### 10.3 状态要求

每个页面必须实现：

- 首次加载
- 空数据
- 加载中
- 部分加载
- 权限不足
- 资源不存在
- 操作成功
- 可恢复错误
- 不可恢复错误
- 离线/断线

## 11. 数据与迁移

### 11.1 新旧隔离

- 新 API 使用 `/api/v2`，旧 API 通过兼容层保留一段迁移期。
- 新权限表与旧管理员字段并行运行，迁移完成后以授权表为准。
- 旧提交、比赛和 Rating 数据转成事件投影，不直接重写历史。
- 旧 VJudge 记录保留原始来源字段，补充统一 Provider 字段。

### 11.2 迁移阶段

1. 建立新领域表和事件表。
2. 导入用户、题目、比赛、提交和 Rating 历史。
3. 双写新旧投影，验证计数和关键结果。
4. 切换新前端和 `/api/v2`。
5. 观察一个完整比赛周期并验证 v2 投影一致性与回退演练。
6. 物理删除旧读写路由、表单和兼容适配器，只发布 v2 运行时。

## 12. 实施顺序与验收

### 12.1 实施阶段

1. 设计令牌、身份、API 错误模型和权限引擎。
2. 应用壳、登录、题库、题目详情和提交。
3. Judge 事件流、队列、Worker 控制和重测。
4. 比赛生命周期、报名、排行榜和比赛提交。
5. Rating Profile、预览、发布和重算。
6. VJudge Provider、导入任务和远程提交。
7. 管理后台、审计、公告、Banner 和批量任务。
8. 社区、通知、站内信、剪贴板和工单。
9. 深色模式、移动端、可访问性和迁移切换。

### 12.2 验收标准

- 普通用户、题目管理员、比赛管理员、评测管理员和站点管理员的权限边界可自动化测试。
- 每次提交、评测、比赛状态转换、Rating 变化和导入任务都有可追溯事件。
- 评测服务短暂断线不导致提交丢失或页面通用报错。
- 比赛开始后题目快照、计分规则和 Rated 状态不可被普通管理员修改。
- VJudge 单题、批量导入、失败重试和远程提交可恢复。
- Rating 重算可预览差异、批准、发布和回滚投影。
- 所有危险操作具备 MFA/近期登录、CSRF、幂等和审计保护。
- 桌面端、平板端和移动端完成关键流程，键盘和屏幕阅读器可操作。

## 13. 当前确认项

本提案默认：

- 第一阶段仍采用模块化单体，不立即拆成多个独立部署服务。
- MariaDB、Redis、RabbitMQ 和对象存储继续作为基础设施，但访问通过领域模块封装。
- Glicko-2 作为默认 Rating 算法，具体参数在实现前通过历史比赛回放校准。
- v1 HTTP 接口、旧页面写路径和兼容适配器已经物理删除；公开业务只通过
  `/api/v2`，`/judge` 仅作为签名保护的内部评测回调。

本方案已在 v2.0.0 实现。后续变更必须继续满足权限矩阵、设计清单、v2-only 兼容性清单
和发布门禁。

## 附录 A：完整权限矩阵与运营接口

本附录补齐社区、个人内容和后台运营功能。它们与前面的领域模型、错误模型和审计规则使用同一套 API 约定。

### A.1 关键权限矩阵

`R` 表示读取，`W` 表示创建或编辑，`P` 表示发布，`O` 表示运营或高危操作。实际判断还要叠加资源作用域和状态条件。

| 领域 | member | problem_editor | contest_manager | judge_operator | rating_manager | content_moderator | site_admin |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 公开题目 | R | R | R | R | R | R | R |
| 授权题目 | - | R/W/P | R | R | R | R | R/W/P |
| 本人提交 | R/W | R/W | R/W | R/W | R/W | R/W | R/W |
| 他人提交 | - | 按题目策略 | 比赛作用域 | R/O | R | 按审核策略 | R/O |
| 比赛配置 | - | - | R/W/P | R | R | R | R/W/P |
| 比赛报名 | R/W | R/W | R/W/O | R | R | R | R/W/O |
| Worker 状态 | - | - | 摘要 | R/O | - | - | R/O |
| Rating 预览 | - | - | R | - | R/W/P | R | R |
| VJudge 导入 | - | - | 按比赛策略 | R | R/W/O | - | R/W/O |
| 题解/讨论审核 | W（本人） | R | R | R | R | R/W/P | R/W/P |
| 用户和授权 | - | - | - | - | - | - | R/W/O |
| 站点配置与密钥 | - | - | - | - | - | - | 独立高危授权 |

任何 `O` 操作都必须产生审计事件，并在必要时要求 MFA 或近期登录。

### A.2 社区、个人内容与运营内容

```text
GET    /api/v2/discussions
POST   /api/v2/discussions
GET    /api/v2/discussions/:id
DELETE /api/v2/discussions/:id
POST   /api/v2/discussions/:id/replies
DELETE /api/v2/discussions/:id/replies/:replyId
POST   /api/v2/discussions/:id/lock
POST   /api/v2/solutions
GET    /api/v2/problems/:id/solutions
GET    /api/v2/solutions/:id
PATCH  /api/v2/solutions/:id
POST   /api/v2/solutions/:id/submit-review
POST   /api/v2/solutions/:id/review
POST   /api/v2/solutions/:id/withdraw
DELETE /api/v2/solutions/:id
POST   /api/v2/solutions/:id/comments
DELETE /api/v2/solutions/:id/comments/:commentId
GET    /api/v2/notifications
POST   /api/v2/notifications/read-all
GET    /api/v2/messages
POST   /api/v2/messages/conversations/:id/messages
DELETE /api/v2/messages/:id
DELETE /api/v2/messages/conversations/:id
PATCH  /api/v2/messages/settings
GET    /api/v2/clipboard
POST   /api/v2/clipboard
PATCH  /api/v2/clipboard/:id
POST   /api/v2/clipboard/:id/share
DELETE /api/v2/clipboard/:id
GET    /api/v2/tickets
POST   /api/v2/tickets
GET    /api/v2/tickets/relation-search
POST   /api/v2/tickets/:id/replies
POST   /api/v2/tickets/:id/assign
GET    /api/v2/announcements
GET    /api/v2/banners/active
```

后台运营接口：

```text
GET    /api/v2/admin/solutions/review-queue
GET    /api/v2/admin/tickets
POST   /api/v2/admin/tickets/:id/close
GET    /api/v2/admin/user-tags
POST   /api/v2/admin/user-tags/grants
POST   /api/v2/admin/user-tags/:id/disable
GET    /api/v2/admin/contest-temp-accounts
POST   /api/v2/admin/contest-temp-accounts/import
GET    /api/v2/admin/help/pages
PUT    /api/v2/admin/help/pages/:slug
GET    /api/v2/admin/links
PUT    /api/v2/admin/links
GET    /api/v2/admin/config/metadata
PATCH  /api/v2/admin/config
POST   /api/v2/admin/rejudge/jobs
GET    /api/v2/admin/rejudge/jobs/:id
```

配置和批量任务接口只返回字段元数据、脱敏值和变更差异，永远不返回外部平台密码、会话密钥或完整环境变量。
