# NWPUOJ v2.0.0 部署与维护手册

本文面向站点管理员和服务器运维人员，覆盖生产部署、日常巡检、备份恢复、升级回滚、
Judge/VJudge 运维、安全和故障处理。发布操作还需同时遵循
[发布手册](../RELEASE.md) 与 [兼容性清单](../COMPATIBILITY.md)。

## 1. 系统边界

NWPUOJ 以 Docker Compose 项目 `nwpuoj` 运行：

| 服务 | 职责 | 关键状态 |
| --- | --- | --- |
| `web` | 页面、`/api/v2`、会话和业务任务 | 会话位于 tmpfs，业务数据在 MariaDB |
| `mariadb` | 用户、题目、比赛、提交和社区数据 | 命名卷 `nwpuoj_database` |
| `redis` | Judge 编译缓存 | 可重建，不作为业务事实来源 |
| `rabbitmq` | 实时评测任务队列 | 队列非持久化，停机前必须排空 |
| `judge-daemon` | 接收和编排评测 | 默认 16 个实例 |
| `judge-runner-1` | 在特权沙箱中执行程序 | 默认 16 个实例，要求 cgroup v1 |
| `judge-control` | 查询和重启单个 Judge 实例 | 仅内部网络可达，令牌保存在命名卷 |

业务接口只允许 `/api/v2`。`/api/*` v1 及旧页面写入路由已从 Web 镜像物理删除；
`/judge` 是 Judge Daemon 使用签名调用的内部回调，不是公开 v1 接口。

下列内容必须作为一个恢复点一起管理：

- MariaDB 逻辑备份；
- `nwpuoj_uploads` 中的题目测试数据；
- `nwpuoj_config` 中的 Judge/Web 共享配置；
- 仓库内被 Git 忽略的 `custom/uploads` 用户头像、Banner 和工单附件；
- `env-app`、反向代理配置和当前发布提交/镜像摘要。

Redis 缓存和 RabbitMQ 队列不进入长期备份。恢复前应保证没有尚未落库的评测任务。

## 2. 首次部署

### 2.1 主机要求

- Linux x86_64，Docker Engine 20.10 以上，Docker Compose v2；
- 推荐至少 8 核 CPU、16 GiB 内存，并为测试数据预留独立磁盘容量；
- Runner 需要 `privileged` 和 cgroup v1；
- 生产环境必须通过 HTTPS 反向代理开放。

确认 cgroup：

```bash
stat -fc '%T' /sys/fs/cgroup
```

输出应为 `tmpfs`。若为 `cgroup2fs`，先按操作系统文档切换到 cgroup v1，再启动
Runner。

### 2.2 安装与密钥

```bash
git clone https://github.com/Lorcas-Zephyr/NWPUOJ.git
cd NWPUOJ
cp env-app.example env-app
```

分别执行三次 `openssl rand -hex 32`，将不同值写入：

- `SYZOJ_WEB_SECRET_SESSION`；
- `SYZOJ_WEB_SECRET_JUDGE`；
- `SYZOJ_WEB_SECRET_EMAIL`。

`env-app` 包含会话、Judge、邮件和外部 OJ 凭据，不得提交 Git、放入前端镜像或粘贴到
公开工单。生产环境应限制为仅运维账号可读。

安装定制依赖并准备绑定目录：

```bash
mkdir -p custom/node_modules custom/uploads/avatar custom/uploads/banner custom/uploads/tickets
docker run --rm -v "$PWD/custom:/work" -w /work node:18 npm ci
```

启动前校验：

```bash
docker compose config --quiet
docker compose up -d
docker compose ps
```

首次启动等待 MariaDB、Redis、RabbitMQ、Web 和 Judge Control 变为 `healthy`。全新数据库
的首个注册账号会在事务内成为站长；应先在内网完成注册，再开放站点。

### 2.3 HTTPS

复制 `deploy/https.env.example` 为 `.env`，至少设置：

```env
SYZOJ_WEB_BIND=127.0.0.1
SYZOJ_WEB_PORT=8080
SYZOJ_SECURE_COOKIES=true
SYZOJ_PUBLIC_URL=https://oj.example.edu
```

按 [HTTPS 部署说明](../deploy/README.md) 配置 Nginx。`SYZOJ_PUBLIC_URL` 必须与用户实际
访问地址一致，否则邮件链接、Cookie 和来源校验可能异常。

## 3. 日常巡检

建议每天检查一次，比赛前后增加频率。

### 3.1 容器和 HTTP

```bash
docker compose ps
curl -fsS http://127.0.0.1/help >/dev/null
docker compose logs --tail 100 web
```

所有长期服务应为 `Up`，带健康检查的服务应为 `healthy`。反复增长的重启次数需要立刻
查看日志和主机内存/OOM 记录。

### 3.2 数据库、评测和队列

```bash
docker compose exec -T mariadb mariadb -N -B -usyzoj -psyzoj syzoj \
  -e "SELECT COUNT(*) FROM judge_state WHERE pending=1;"
docker compose exec -T rabbitmq \
  rabbitmqctl list_queues name messages_ready messages_unacknowledged consumers
```

`pending` 不一定必须为零，但应随 Runner 工作持续下降。正常空闲时 `task` 队列的
`messages_ready` 和 `messages_unacknowledged` 都应为零，消费者数量应与 Daemon/Runner
规模一致。

后台“评测服务”可查看每个 Daemon/Runner 的 CPU、内存、PID、启动时间和 OOM 状态。
只在确认当前实例没有关键任务时重启单个实例；重启 Runner 可能使正在执行的评测失败。

### 3.3 磁盘和备份

```bash
docker system df
docker volume inspect nwpuoj_database nwpuoj_uploads nwpuoj_config
du -sh custom/uploads
```

测试数据和数据库通常是主要增长来源。不要使用 `docker volume prune` 作为清理手段。
清理题目、测试数据或附件应通过后台正常功能完成，并先确认没有比赛、题目或工单引用。

## 4. 备份策略

建议：

- 每日数据库逻辑备份和 `custom/uploads` 归档；
- 每周完整归档 `nwpuoj_uploads` 与 `nwpuoj_config`；
- 大赛前、升级前和批量导入前额外创建一次完整恢复点；
- 至少保留一份异机或离线副本，并定期做恢复演练；
- 备份文件加密保存，访问权限按生产数据管理。

创建一个显式备份目录：

```bash
mkdir -p release-backup
docker compose exec -T mariadb mariadb-dump -uroot \
  --single-transaction --routines --events syzoj \
  > release-backup/nwpuoj.sql
docker run --rm -v nwpuoj_uploads:/data:ro -v "$PWD/release-backup:/backup" \
  alpine:3.20 tar czf /backup/uploads.tar.gz -C /data .
docker run --rm -v nwpuoj_config:/data:ro -v "$PWD/release-backup:/backup" \
  alpine:3.20 tar czf /backup/config.tar.gz -C /data .
tar czf release-backup/custom-uploads.tar.gz custom/uploads
cp env-app release-backup/env-app
git rev-parse HEAD > release-backup/git-commit.txt
docker compose images > release-backup/images.txt
```

完成后计算校验值并将备份移出工作目录：

```bash
sha256sum release-backup/* > release-backup/SHA256SUMS
```

不要把 `release-backup`、`env-app` 或 SQL 备份提交到仓库。

## 5. 恢复与灾难回滚

恢复会覆盖当前状态，必须先：

1. 确认恢复点的时间、提交和校验值；
2. 记录故障现场日志并另做当前状态备份；
3. 停止 Web、Daemon 和 Runner，避免恢复期间继续写入；
4. 明确目标命名卷，避免操作到其他 Compose 项目。

数据库恢复示例：

```bash
docker compose stop web judge-daemon judge-runner-1
docker compose exec -T mariadb mariadb -uroot syzoj < release-backup/nwpuoj.sql
```

卷恢复应在相关服务停止后，将归档解压到明确的 `nwpuoj_uploads` 和
`nwpuoj_config`。恢复文件前先保留现有卷副本，不能只恢复部分投影表或只恢复数据库而
忽略对应测试数据。

恢复后按顺序启动基础设施、Web、Daemon 和 Runner，并验证：

- 登录及会话；
- 一个公开题目的题面与测试数据；
- 一次本地语言提交的完整评测；
- 比赛详情、参赛者、排行榜和 Rating 状态；
- 头像、Banner、附件等上传内容；
- RabbitMQ 无滞留任务。

任何情况下都不要执行 `docker compose down -v`。该命令会删除数据库、题目测试数据和
共享配置卷。v2 镜像不能通过重新启用 v1 路由回滚，必须恢复上一发行提交/镜像及同一
时间点的完整数据集。

## 6. 更新与发布

### 6.1 普通更新

更新前先排空任务并完成完整备份：

```bash
git fetch origin
git pull --ff-only
docker run --rm -v "$PWD/custom:/work" -w /work node:18 npm ci
cd custom
npm test
cd ..
docker compose config --quiet
docker compose build web
docker compose up -d --force-recreate web
```

必须使用仓库的 `Dockerfile.web` 构建 Web，不能直接运行上游
`menci/syzoj-web` 镜像。构建步骤负责安装 v2 定制代码并物理移除上游 v1 路由。

### 6.2 发布门禁

正式发布至少满足：

- 工作树没有意外文件，版本号在 `VERSION`、`custom/web.json`、package 文件和 README
  中一致；
- `npm test`、EJS 模板编译、Compose 配置和 Web 渲染冒烟全部通过；
- `COMPATIBILITY-INVENTORY.json` 的 v1 读取、写入、表单、客户端调用和适配器均为零；
- 匿名用户、普通用户、参赛者、专项管理员、全站管理员和站长权限矩阵通过；
- 桌面、平板、手机、深浅主题、缩放和减少动画模式通过视觉验收；
- 创建并删除一个短时 ACM 测试比赛，覆盖报名、参赛者、提交、排行榜、结束、Rating、
  通知、无效提交和后续重算；
- 数据库无异常 pending，RabbitMQ 无 ready/unacknowledged 任务；
- 备份可读、校验值正确、回滚责任人和恢复步骤明确。

完整流程见 [`RELEASE.md`](../RELEASE.md)。不要在未验证环境直接创建发布标签。

## 7. 权限与审计

NWPUOJ 使用能力和资源作用域控制权限：

- 站长/全站管理员可以进入完整后台；
- 题目、比赛、Judge、Rating 和内容管理员只进入自己的工作区；
- 只有“管理用户”能力不能自动获得完整后台；
- 比赛页面“参赛者”是普通只读视图，移除用户、临时账号等操作只在比赛管理界面；
- 高危操作要求 CSRF、来源校验、幂等控制，并写入审计记录；
- 题解拒绝需要填写可供作者修改的原因，帮助页、Rating 等系统操作不要求无意义原因。

每月复核管理员、站长、外部 OJ 凭据和离职人员账号。权限变更后验证旧会话是否已吊销。
审计日志不应由执行操作的普通管理员自行删除。

## 8. Judge 运维

### 8.1 扩缩容

当前 Compose 固定 16 个 Daemon 和 16 个 Runner。调整前评估 CPU、内存、cgroup 和队列
压力，并保持消费者规模匹配。Runner 使用特权容器，不应在不可信共用主机部署。

比赛前执行一次真实小题提交，确认编译、运行、测试点、终态事件和源码可见性。不要只以
容器 `healthy` 代替功能验证。

### 8.2 队列积压

出现积压时按顺序检查：

1. `docker compose ps` 中 RabbitMQ、Daemon、Runner 是否运行；
2. 后台“评测服务”是否有离线、OOM 或重复重启实例；
3. `docker compose logs --tail 200 judge-daemon` 和 Runner 日志；
4. RabbitMQ 的 ready、unacknowledged 和 consumers；
5. 测试数据卷是否存在、磁盘是否已满。

不要直接清空队列。先确认任务是否已经落库、是否仍可重试；错误清队列会让提交永久停留在
等待状态。需要重测时使用后台重测任务，保留审计和进度。

## 9. VJudge 运维

UOJ、HDU、POJ 使用独立低权限账号，在 `env-app` 配置。默认禁止比赛内 VJudge；只有确认
上游条款、源码可见性和凭据风险后才可设置对应 `ALLOW_CONTESTS=true`。

维护时注意：

- 上游页面不是稳定 API，登录字段、验证码、编码或结果 HTML 变化都会导致失败；
- HDU 依赖本地 Tesseract 验证码识别，连续失败时不要高频重试；
- POJ 使用 HTTP，凭据和源码可能明文传输，不建议承载敏感代码；
- 导入任务支持批量题号、可见性和冲突策略，失败项应按任务明细重试；
- Web 内维护 provider 队列，启用 VJudge 时不要扩为多个 Web 副本；
- 修改账号后执行单题导入和一次无敏感内容的远程提交验证。

仓库测试验证 provider 解析、协议、重启恢复和未配置账号时的安全拒绝。它不能替代使用
真实上游账号的发布前连通性测试。

## 10. 内容和业务维护

### 10.1 题目和测试数据

新建题目使用一个连续 Markdown 题面。上传测试数据前确认文件名、输入输出配对、大小限制
和校验值。批量公开、隐藏、归档、删除都通过 v2 后台操作；被比赛引用的题目不能直接删除。

标签创建时由管理员选择类型，颜色由系统自动判定，不手填颜色。定期合并语义重复标签，
避免同一算法出现多个拼写。

### 10.2 比赛和 Rating

比赛可以先不选题目，但发布前应检查时间、公开性、题目、语言、报名和 Rated 设置。比赛
开始后避免修改计分和 Rated 关键规则。删除比赛会使后续 Rated 比赛需要重新计算；后台
Rating 页显示未计算状态并提供一键计算。

管理员删除作弊或无效提交后再计算 Rating。首次结算发送比赛结束后的变化通知；重算通知
应说明触发重算的比赛删除/修订原因及 Rating 差值。

### 10.3 公告、帮助和用户标签

生效公告置顶并按重要性排列，已结束公告在后并按开始时间排列。帮助页编辑器仅在内容真的
发生变化时保存草稿；发布或主动放弃后不应再次提示恢复。用户名牌可全局关闭，关闭只影响
显示，不删除已经配置的标签。

## 11. 安全维护

- 对外只开放 HTTPS 反向代理端口，不开放 MariaDB、Redis、RabbitMQ 或 Judge Control；
- Web 不挂载 Docker Socket；只有内部 `judge-control` 服务持有，并限制 Compose 项目和
  可操作服务；
- 定期轮换邮件、外部 OJ 和站点密钥。轮换会话密钥会使所有用户重新登录；
- 上传目录禁止执行脚本，反向代理应限制请求体和异常高频请求；
- 不记录密码、Cookie、CSRF、Judge 签名或外部 OJ 凭据；
- 定期更新固定镜像摘要和依赖，更新后重新执行全量测试；
- 数据导出、数据库备份和测试数据都按生产敏感数据处理。

若怀疑密钥泄漏：先隔离入口，轮换相关密钥和外部账号密码，重建 Web/Judge 服务，吊销
用户会话，检查审计日志和异常提交，再恢复对外服务。

## 12. 常见故障

### 页面返回 502 或无响应

检查 Web 健康、端口绑定、Nginx upstream 和 `SYZOJ_PUBLIC_URL`。查看 Web 日志中的数据库
连接、模板编译或模块加载错误。修改 Compose/环境变量后应使用
`docker compose up -d --force-recreate web`，仅 `restart` 不会更新环境。

### 登录后立即退出或 CSRF 失败

确认系统时间、HTTPS、`SYZOJ_SECURE_COOKIES`、公开 URL 和反向代理转发头一致。不要在
HTTP 环境开启 secure cookie。密钥改变后旧会话失效是预期行为。

### 提交长时间等待

检查 pending 数、RabbitMQ 队列、消费者数和 Runner 状态。若消息 ready 增长通常是消费者
不可用；unacknowledged 长时间不变通常是 Runner 卡住或测试数据/沙箱问题。

### 编辑器或图标不显示

浏览器依赖均从 `/static/self` 本地提供。检查静态资源状态码、挂载文件、浏览器控制台和
反向代理缓存。重新编译全部 EJS 并强制重建 Web，避免旧模板与新脚本混用。

### VJudge 导入或提交失败

先确认账号配置和上游可访问，再检查 provider 日志中的登录、验证码、编码和解析阶段。
上游改版时暂停批量任务，保留失败任务明细，用无敏感数据更新协议测试后再恢复。

### Rating 显示未计算

确认比赛已结束且 Rated，先处理作弊/无效提交，再在 Rating 管理页一键计算。删除或修改
较早比赛后，按时间顺序重新计算后续比赛，不要直接手改用户 Rating。

## 13. 发布后验收记录

每次大版本至少归档以下信息：

- Git 提交、标签、Web/Judge 镜像摘要；
- 备份位置、时间、SHA-256 和恢复演练结果；
- 自动测试数量、EJS 编译数量、页面/视口矩阵；
- 真实短时比赛编号、提交编号、Rating 计算和删除结果；
- 容器健康、重启次数、队列和 pending 快照；
- 未覆盖的外部依赖，例如尚未配置凭据的 VJudge 上游；
- 发布人、复核人、回滚责任人和观察结束时间。

完成这些记录后，才能把“自动化通过”解释为可发布，而不是把未验证的外部服务也宣称为
正常。
