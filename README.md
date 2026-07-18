# NWPUOJ

NWPUOJ 是面向高校程序设计教学、训练和竞赛的在线评测与社区平台。项目以 SYZOJ 作为底层 Web、数据模型和 Judge 协议框架，在其上提供现代化题库、比赛、评测、管理和社区能力。

当前发行版：**v1.0.0**

> 项目沿革：NWPUOJ 由 AlgoBeat Online Judge 现有代码与功能继续改版而来。自 NWPUOJ 起重新采用独立版本序列，并保留 SYZOJ 作为后台框架及相关技术标识。

仓库地址：<https://github.com/Lorcas-Zephyr/NWPUOJ>

## 系统能力

### 在线评测

- 支持 C、C++、Java、Python、Node.js、Pascal、C#、Ruby、Haskell 等已启用语言。
- 支持传统题、文件输入输出、交互题、提交答案题和 VJudge 题型。
- Judge Daemon 与 Runner 通过 RabbitMQ 分发任务，Redis 保存编译缓存。
- 默认生产配置为 16 个 Judge Daemon 和 16 个 Judge Runner。
- 提交状态采用事件驱动更新，不进行固定 2/3 秒轮询。
- Judge 上报编译、测试点或终态变化时，通过 SSE/流式连接更新列表和详情。
- 普通参赛者只能看到权限范围内的进度；隐藏分数、用量、诊断和测试点保持隐藏。
- 终态后自动关闭状态流，断线采用有上限的指数退避重连。

### 题库

- 题库分为全部题库、主题库、UOJ、HDU 和 POJ。
- 支持题号、标题、做题状态、来源和标签筛选。
- 标签支持搜索、多选和交集筛选，并按来源、算法、类型和难度分组。
- 题目列表将标签放在题目名称右侧、通过数量左侧。
- 支持 Markdown 题面、TeX 公式、样例、提示和本地测试数据。
- 支持严格格式的 ZIP 批量导入；整批校验和事务回滚避免半成品题目。
- 超级管理员可以批量删除当前页题目，被比赛引用的题目会阻止删除。

### VJudge

- UOJ：登录检测、题面导入、批量导入、远程提交、子任务和测试点结果同步。
- HDU：GB18030 题面转换、批量导入、Tesseract 本地验证码识别和远程评测。
- POJ：题面导入、批量导入、远程提交和重启续判。
- 外部题目使用独立展示编号，并自动添加来源标签。
- 比赛中的 VJudge 默认关闭，必须明确确认源码可见性和上游账号风险后启用。

### 比赛

- 支持 ACM 等比赛模式、比赛题目、参赛者、排行榜和提交管理。
- 支持报名、迟到报名、移除参赛者和报名修订控制。
- 支持 Rated 比赛配置、赛后自动 Rating 结算、历史记录和管理员手动重算。
- 比赛修改采用数据库命名锁和修订检查，避免多个管理员并发覆盖。
- 运行中的比赛严格控制题面、提交、代码、分数、测试点和他人结果可见性。

### 用户与社区

- 注册资料、学号、姓名和学院信息管理。
- 本地头像上传、邮箱验证、密码重置和会话吊销。
- 关注、粉丝、互关状态和用户动态。
- 犇犇短文、图片、回复和 @ 提及。
- 站内通知、站内信和消息接收设置。
- Markdown 个人剪贴板，支持私有、公开和限时分享链接。
- 题解投稿、审核、评论、投稿开关和审核记录。
- 公告、首页 Banner、讨论区和工单系统。
- Hit 值、Rating、用户名颜色、荣誉标签和作弊者状态。

### 管理后台

- 用户、权限、题目、标签、比赛、公告、Banner、题解、Rating 和帮助页管理。
- 评测服务页面展示每个 Daemon/Runner 的状态、CPU、内存、PID、OOM 和启动时间。
- 可安全重启单个 Judge 实例。
- Web 容器不挂载 Docker Socket；重启能力隔离在 `judge-control` 服务中。
- 控制服务使用内部网络、自动生成密钥、Compose 项目标签和服务白名单限制操作范围。
- 管理操作使用登录权限、全局来源校验、CSRF 和内容令牌保护。

## 架构

| 服务 | 作用 | 持久化 |
| --- | --- | --- |
| `web` | SYZOJ Web 与 NWPUOJ 定制模块 | `nwpuoj_config`、`nwpuoj_uploads` |
| `mariadb` | 用户、题目、比赛、提交和社区数据 | `nwpuoj_database` |
| `redis` | Judge 编译缓存 | 无持久化要求 |
| `rabbitmq` | Judge 任务队列 | 当前配置不承诺持久化 |
| `judge-daemon` | 接收任务、编排评测 | 共享配置与测试数据 |
| `judge-runner-1` | 特权沙箱执行 | 共享配置与测试数据 |
| `judge-control` | 受限的 Judge 状态与重启代理 | `nwpuoj_judge-control-auth` |

Compose 项目名固定为 `nwpuoj`，不依赖本地目录名称。不要随意修改项目名或卷名。

## 环境要求

- Linux x86_64 服务器，推荐 Ubuntu 22.04 或更新版本。
- Docker Engine 20.10 或更新版本。
- Docker Compose v2。
- Judge Runner 需要特权容器和 cgroup v1。
- 建议至少 8 核 CPU、16 GiB 内存和足够的测试数据磁盘空间。
- 生产环境必须使用 HTTPS 反向代理。

检查 cgroup：

```bash
stat -fc '%T' /sys/fs/cgroup
```

预期输出为 `tmpfs`。如果输出 `cgroup2fs`，需要先将主机切换到 cgroup v1，再启动 Judge Runner。

## 全新安装

### 1. 获取代码

```bash
git clone https://github.com/Lorcas-Zephyr/NWPUOJ.git
cd NWPUOJ
```

### 2. 创建密钥配置

```bash
cp env-app.example env-app
openssl rand -hex 32
openssl rand -hex 32
openssl rand -hex 32
```

将三个不同的随机值分别写入：

- `SYZOJ_WEB_SECRET_SESSION`
- `SYZOJ_WEB_SECRET_JUDGE`
- `SYZOJ_WEB_SECRET_EMAIL`

`env-app` 包含密钥和外部 OJ 账号，已被 Git 忽略，不得提交。

### 3. 安装自定义依赖

```bash
mkdir -p custom/node_modules
docker run --rm \
  -v "$PWD/custom:/work" \
  -w /work \
  node:18 npm ci
```

仓库已经包含浏览器端 Markdown、代码高亮和 KaTeX 静态资源，无需从 CDN 下载。

### 4. 创建运行时目录

```bash
mkdir -p \
  custom/uploads/avatar \
  custom/uploads/banner \
  custom/uploads/benben \
  custom/uploads/tickets
```

这些目录保存用户上传内容并被 Git 忽略。题目测试数据保存在 Docker 卷 `nwpuoj_uploads`。

### 5. 启动

```bash
docker compose config >/dev/null
docker compose up -d
docker compose ps
```

首次启动可能需要等待 MariaDB、RabbitMQ、Redis 和 Web 健康检查完成。

```bash
docker compose logs --tail 100 web
docker compose exec -T rabbitmq \
  rabbitmqctl list_queues name messages_ready messages_unacknowledged consumers
```

默认访问地址为 `http://服务器地址/`。

### 6. 初始化站长

全新数据库中的首个注册账号会在同一事务内成为站长和全站管理员。请在开放注册前完成首个账号注册。

已有数据库升级但尚未建立站长状态时，在 `env-app` 中设置：

```env
SYZOJ_SITE_OWNER_USER_ID=现有管理员数字ID
```

重启 Web 后确认站长，再根据需要移除该临时配置。

自定义模型和业务表由应用启动过程自动创建或同步，不需要执行旧版 README 中的手工 SQL 初始化脚本。

## 基础配置

站点名称、友情链接、分页和默认限制位于 `custom/web.json`。

邮件与外部 OJ 配置位于 `env-app`：

```env
SYZOJ_WEB_SMTP_HOST=smtp.example.com
SYZOJ_WEB_SMTP_PORT=465
SYZOJ_WEB_SMTP_USER=mailer@example.com
SYZOJ_WEB_SMTP_PASS=应用专用密码
SYZOJ_WEB_SMTP_FROM_NAME=NWPUOJ
```

修改挂载文件后通常只需重启 Web：

```bash
docker compose restart web
```

修改 Compose 配置、环境变量或挂载关系后使用：

```bash
docker compose up -d --force-recreate web
```

## HTTPS 部署

生产环境应将 Web 仅绑定到回环地址，并由 Nginx 终止 TLS。

```bash
cp deploy/https.env.example .env
```

编辑 `.env`：

```env
SYZOJ_WEB_BIND=127.0.0.1
SYZOJ_WEB_PORT=8080
SYZOJ_SECURE_COOKIES=true
SYZOJ_PUBLIC_URL=https://oj.example.edu
```

然后修改 `deploy/nginx-https.conf.example` 中的域名和证书路径，安装到 Nginx 并执行：

```bash
docker compose up -d
nginx -t
systemctl reload nginx
```

详细说明见 [deploy/README.md](deploy/README.md)。

## VJudge 配置

建议为每个平台使用独立普通账号，不要使用个人主账号。

```env
SYZOJ_WEB_UOJ_ENDPOINT=https://uoj.ac
SYZOJ_WEB_UOJ_USERNAME=
SYZOJ_WEB_UOJ_PASSWORD=
SYZOJ_WEB_UOJ_ALLOW_CONTESTS=false

SYZOJ_WEB_HDU_ENDPOINT=https://acm.hdu.edu.cn
SYZOJ_WEB_HDU_USERNAME=
SYZOJ_WEB_HDU_PASSWORD=
SYZOJ_WEB_HDU_ALLOW_CONTESTS=false

SYZOJ_WEB_POJ_ENDPOINT=http://poj.org
SYZOJ_WEB_POJ_USERNAME=
SYZOJ_WEB_POJ_PASSWORD=
SYZOJ_WEB_POJ_ALLOW_CONTESTS=false
```

注意：POJ 当前只提供 HTTP，上游登录凭据和提交源码会明文传输。UOJ、HDU、POJ 的页面协议不是稳定公开 API，上游改版后可能需要同步更新 provider。

VJudge 导入和提交队列位于单个 Web 进程内。启用 VJudge 时不要直接扩展为多个 Web 副本。

## 从旧 Compose 项目迁移

旧部署可能使用 `algobeatonlinejudge_*` 命名卷。新版本固定使用 `nwpuoj_*`。直接启动会得到空卷，因此必须先迁移。

确认没有 pending 评测且 RabbitMQ 队列为空：

```bash
docker compose exec -T mariadb mariadb -N -B -usyzoj -psyzoj syzoj \
  -e "SELECT COUNT(*) FROM judge_state WHERE pending=1;"
docker compose exec -T rabbitmq \
  rabbitmqctl list_queues name messages_ready messages_unacknowledged consumers
```

先做逻辑备份，再停止旧项目，不能使用 `down -v`：

```bash
docker compose exec -T mariadb \
  mariadb-dump -uroot --single-transaction --routines --events syzoj \
  > nwpuoj-before-migration.sql

docker compose -p algobeatonlinejudge down
```

创建并复制命名卷：

```bash
for volume in database uploads config judge-control-auth; do
  docker volume create "nwpuoj_${volume}"
  docker run --rm \
    -v "algobeatonlinejudge_${volume}:/from:ro" \
    -v "nwpuoj_${volume}:/to" \
    alpine:3.20 sh -c 'cp -a /from/. /to/'
done

docker compose up -d
```

验证用户、题目、比赛、提交、上传文件和 Judge 后，保留旧卷一段时间作为回滚点。不要执行 `docker volume prune`。

## 备份与恢复

### 数据库备份

```bash
docker compose exec -T mariadb \
  mariadb-dump -uroot --single-transaction --routines --events syzoj \
  > "nwpuoj-$(date +%F).sql"
```

### 上传和配置卷备份

```bash
docker run --rm -v nwpuoj_uploads:/data:ro -v "$PWD:/backup" \
  alpine:3.20 tar czf /backup/nwpuoj-uploads.tar.gz -C /data .
docker run --rm -v nwpuoj_config:/data:ro -v "$PWD:/backup" \
  alpine:3.20 tar czf /backup/nwpuoj-config.tar.gz -C /data .
```

恢复前必须停止 Web 和 Judge，确认目标数据库和卷，并保留恢复前副本。

## 更新

```bash
git pull --ff-only
docker run --rm -v "$PWD/custom:/work" -w /work node:18 npm ci
docker compose config >/dev/null
docker compose up -d
```

更新前先备份数据库和上传卷。不要使用 `docker compose down -v`。

## 运行验证

```bash
docker compose ps
curl -f http://127.0.0.1/help

docker compose exec -T mariadb \
  mariadb -N -B -usyzoj -psyzoj syzoj \
  -e "SELECT COUNT(*) FROM judge_state WHERE pending=1;"

docker compose exec -T rabbitmq \
  rabbitmqctl list_queues name messages_ready messages_unacknowledged consumers
```

本地测试：

```bash
node custom/tests/rating.test.js
node custom/tests/problem_bulk_import.test.js
node custom/tests/version_consistency.test.js
bash custom/tests/run-vjudge-tests.sh
```

压测脚本会创建大量用户、比赛和提交，只能在隔离环境中运行。不要直接在生产站点执行。

## 常用维护命令

```bash
docker compose logs --tail 100 web
docker compose logs -f judge-daemon
docker compose restart web
docker compose up -d --force-recreate web
docker compose exec web bash
docker compose exec mariadb mariadb -uroot syzoj
```

后台“评测服务”页面可以查看并重启单个 Daemon/Runner。重启正在执行任务的 Runner 可能使当前评测失败，应先确认任务状态。

## 版本与发布

NWPUOJ 使用独立语义化版本。当前首个发行版为 `v1.0.0`。

版本号同时保存在：

- `VERSION`
- `custom/web.json` 的 `nwpuoj_version`
- `custom/package.json`
- `custom/package-lock.json`
- README 当前发行版说明

发布或发生用户可见变更时，应同步更新以上位置，并执行：

```bash
node custom/tests/version_consistency.test.js
git tag -a v1.0.0 -m "NWPUOJ v1.0.0"
```

完整发布记录见 [GitHub Releases](https://github.com/Lorcas-Zephyr/NWPUOJ/releases)。

## 仓库结构

```text
.
├── VERSION                         # NWPUOJ 发行版本
├── docker-compose.yml              # Web、数据库、缓存、队列和 Judge
├── env-app.example                 # 密钥、SMTP 和 VJudge 配置模板
├── deploy/                         # HTTPS 反向代理示例
├── custom/
│   ├── web.json                    # 站点名称、版本和分页配置
│   ├── header.ejs                  # 公共头部、导航和品牌元数据
│   ├── views/                      # EJS 页面模板
│   ├── modules/                    # 路由、安全与业务模块
│   ├── models/                     # TypeORM 模型声明
│   ├── models-built/               # 运行时模型 JavaScript
│   ├── libs/                       # 业务库
│   ├── libs-built/                 # Judge 与 VJudge 运行时代码
│   ├── content/                    # 默认帮助内容
│   ├── tests/                      # 单元、协议和负载测试
│   ├── static-libs/                # 本地化浏览器依赖
│   └── uploads/                    # 被 Git 忽略的用户上传目录
└── README.md
```

## 许可与致谢

本项目采用 [Apache License 2.0](LICENSE)。

- [SYZOJ](https://github.com/syzoj/syzoj) 提供底层 OJ 架构和 Judge 协议。
- 感谢前序项目的开发者和所有参与题库、比赛、测试及运维工作的贡献者。

Powered by SYZOJ. Modified and maintained by **lorcas**.
