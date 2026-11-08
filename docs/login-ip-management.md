# 登录 IP 管理

- 后台入口：`/admin/ip`，需要全局 `admin:audit.read` 权限。
- 周赛入口：`/weekly-ranklist/settings#ip`，与总榜设置共用全站管理员 / 站长权限。
- 表格支持用户名（模糊匹配）或 UID、北京时间范围、每页 50 条；周赛只显示自动从线下转为线上的记录，并支持比赛筛选。
- 全站查询接口为 `GET /api/v2/admin/login-ips`，周赛查询为 `GET /api/v2/weekly-ranklist/login-ips`。
  参数：`q`、`from` / `to`（北京时间 `YYYY-MM-DDTHH:mm`，含开始、不含结束）、`page`；周赛还支持 `contest_id`，且始终仅返回自动转线上场次的相关登录记录。

## 自动转线上规则

对已选入总榜的 ACM 比赛及成员，只检查已登记线下的场次。核验窗口从比赛开始，到该用户本场最后一次正式提交，包含末次提交所在秒（提交时间精度为秒）。赛前 / 赛后及练习提交不扩大窗口；没有正式提交时不执行核验。

窗口内出现至少两个不同的有效 IP 成功登录（`auth:login`），自动将本场 `onsite` 改为 `0`。IPv4 映射 IPv6 和等价 IPv6 写法按同一个 IP 计算，重复登录及空白 / 无效 IP 不增加计数。仅使用成功登录审计，不推断其他请求的来源。

保存登记、总榜刷新和登录后检查共用规则。定时刷新每 30 秒执行，也会在新提交扩大核验窗口后重新检查历史登录。已有比赛也适用；不会自动将线上登记改回线下。

自动转换在总榜行锁事务内执行，同步推进总榜版本、完整重算并写入 `weekly_ranklist:attendance.auto_online` 审计事件。审计含用户、比赛、核验时间范围及各 IP 的首次 / 末次登录时间。`weekly_ranklist_ip_violation` 保存对应证据供管理页标识状态；从总榜移除成员或比赛时清理关联标识，原审计事件保留。公开总榜不返回 IP 或登录明细。

## 验证

`npm run test:weekly`、`npm run test:weekly:mysql`、`npm run test:weekly:browser`。MySQL 测试只使用连接内临时表，浏览器测试拦截 API 请求，不修改真实成员或登录记录。
