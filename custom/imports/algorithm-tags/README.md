# 算法标签库（2026-09-30）

## 数据与范围

- 来源：洛谷官方公开 `https://www.luogu.com.cn/_lfe/tags` 接口，当日获取的 `type=2`（算法）全部 262 条。
- 快照：`luogu-2026-09-30.json`，保留洛谷原始 ID、名称和父标签 ID，以便追溯；不把洛谷 ID 当作本地数据库 ID。
- 映射：22 个根标签 → 现有 `category` / 算法大类 / teal；其余 240 个标签 → `algorithm` / 算法细目 / violet。
- 展示名称仅清理 BOM、零宽字符和多余空白；原始名称仍保存在快照中。
- 覆盖语言入门、基础算法、搜索、动态规划与优化、字符串、图论、树论、线性/树形数据结构、数论、组合数学、概率、线性代数、多项式、计算几何、博弈、群论、微积分、组合优化及其他技巧。
- 不导入洛谷的年份、地区、来源、难度；不猜测或自动修改现有题目的算法标签。
- 不新增权限、不变更题面、测试数据、提交或比赛配置。普通题库和基地复用原有标签选择、批量添加、筛选和管理流程。

## 导入原则

`seed.js` 为显式运行的维护脚本，默认只预览，不接入服务启动流程。复用经过空白、大小写和 Unicode 规范化后同名的已有算法标签 ID；遇到来源/难度同名或含义不明确的多个匹配时停止，不覆盖或删除原记录。

正式执行必须指定已有全站管理员 ID 和备份目录。在事务中备份原标签及全部关联、仅插入缺失标签，并逐项写入原有 `problem.tag.created` 审计事件。备份文件权限为 0600，目录为 0700。核对旧标签内容、旧关联摘要、导入完整性后才提交；失败回滚。重复执行为零新增。

在 Web 容器内使用现有 `SYZOJ_WEB_DB_*` 环境变量连接数据库，不把凭据写入文件或输出。

```bash
# 在项目根目录执行。
docker exec nwpuoj-web-1 mkdir -p /tmp/noj-algorithm-tags-20260930
docker cp custom/imports/algorithm-tags/. nwpuoj-web-1:/tmp/noj-algorithm-tags-20260930/
docker exec nwpuoj-web-1 node /tmp/noj-algorithm-tags-20260930/seed.js --dry-run
docker exec nwpuoj-web-1 node /tmp/noj-algorithm-tags-20260930/seed.js --apply --actor-id=1 --backup-dir=/app/custom-uploads/tag-catalog-backups
```

标签目录原先对每个标签单独查询关联数量，已改为一次聚合查询，保留原有计数语义。目录包含无关联题目的算法标签；API 标签列表仍使用游标分页，搜索仍支持关键词，未无限扩大接口默认返回数量。

## 本次导入

- 导入前：27 个标签（19 个来源、8 个难度）。
- 新增：262 个算法标签，本地 ID 34–295。
- 导入后：289 个标签。
- 原有 27 个标签及 11,208 条题目关联完全不变。
- 第二次执行：新增 0，复用 262。
- 备份：容器 `/app/custom-uploads/tag-catalog-backups/before-2026-09-30T01-46-31-414Z.json`，映射至主机 `custom/uploads/tag-catalog-backups/`；同名 `-result.json` 保存导入结果。
- 恢复应先审查新增标签是否已被用户使用，仅在确认无新增关联后删除本次新增 ID；不要直接覆盖标签表或恢复整表而丢失后续用户改动。

## 验证

```bash
cd custom
npm run test:algorithm-tags
# 已安装 Playwright/Chromium 时：
node --test tests/problem_tags.browser.test.js
NWPUOJ_WEB_URL=http://127.0.0.1 node --test tests/algorithm_tag_catalog.browser.test.js
```

实时浏览器检查是只读的：验证完整目录、262 个标签的真实搜索结果、API 全量分页、题库标签跳转、桌面和手机宽度；不新建或改动任何用户、题目。已有编辑页浏览器测试使用隔离 API，验证标签显示、添加、移除、保存和未修改标签的保留。

2026-09-30 执行结果：16 项目录/题库/标签回归测试通过；编辑页浏览器测试通过；本机真实页面的全量目录、262 次搜索、游标分页、筛选跳转及 1440/390 像素宽度检查通过。第一次快速搜索触发站点限流后，测试改为间隔 450ms 串行请求并遵守 `Retry-After`，未改动或绕过生产限流配置。

Web 服务已重启加载聚合查询优化，健康检查正常；首页及标签页返回 HTTP 200。公网自动化请求 `https://noj.nwpu.edu.cn/tags` 返回 HTTP 412，因此本轮不声称完成公网浏览器验证，也未修改公网防护。
