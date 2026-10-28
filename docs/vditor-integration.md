# 全站 Markdown 编辑器

更新日期：2026-10-05。

## 范围与行为

- 使用本地部署的中文 Vditor 4.0.0，所有文档默认分屏预览（左侧 Markdown 源码、右侧实时预览），包含长文档和异步加载的内容。仍可收起预览，或手动选择即时渲染、所见即所得与全屏；异步内容更新不覆盖手动选择的模式。
- 统一题面（包括基地题目）、比赛简介和公告、题单说明、帮助页、全站公告/通知、私信、工单、个人简介和剪贴板的 Markdown 编辑。
- 原有题解/讨论模板也接入公共编辑器，但不重新开放已关闭的模块。
- 纯文本比赛通知、代码提交框、CSV/UID/账号列表不升级为 Markdown。全站通知关闭 Markdown 时保留普通文本框。
- Markdown 表格的相邻相同内容不自动合并，横向、纵向和表头均独立显示；不修改已保存的题面或测试数据。
- 原有服务器渲染保留数学公式、语法高亮、XSS 过滤和缓存；仅禁用 `markdownItMergeCells`。剪贴板也使用同一服务端渲染结果。

## 集成与权限

`custom/static-libs/noj-markdown.js` 按显式字段白名单初始化编辑器。没有 Markdown 字段的页面不会下载 Vditor。

原 textarea 仍是表单数据源；同步覆盖输入、FormData、直接读取 value 的 JSON 保存、异步版本读取、草稿恢复、清空和重置。只打开页面不改写 Markdown。原有 If-Match、CSRF、发布流程和管理员权限不变。

图片上传复用 `/api/v2/image-host`：仅原有题目管理权限或基地成员显示上传入口，实际请求继续由后端校验；PNG/JPEG/GIF/WebP，每张不超过 10 MiB。直接插入返回的站点图床链接。未授权用户仍可手动编写图片链接，但没有新增上传权限。

工具栏提供「上传图片」及「图床」。图床面板从原有接口获取本人图片，支持名称搜索、分批显示（每次 18 张）、懒加载缩略图，并在原光标位置插入图片。上传期间显示明确状态，阻止尚未插入图片就保存；外部存储未启用。弹窗支持 Escape、点击背景与取消关闭。

图片使用 Vditor 的 Markdown 插入接口，避免富文本模式把尖括号地址误当成 HTML。编辑器上传按钮不显示普通文件控件的「已选择」提示，其他上传区域仍显示文件名。富文本左侧为 H1–H6 等标记保留独立边距，避免裁切。

编辑区沿用站内蓝白/深色主题：工具分组、文字模式切换、柔和圆角与轻量悬停，状态和字数放在底部；小屏自动换行，尊重减少动画偏好。

## 性能

- 避免初始化后再次解析同一份内容；语言包、解析器和样式并行加载。
- 跟踪内容变化，读取未修改的表单值时不重复转换整篇 Markdown。
- 富文本输入按 240 ms 合并同步；点击保存/发布、FormData 和取值时仍强制同步待处理内容。源码模式直接使用编辑器给出的 Markdown。
- 分栏预览在输入停止 500 ms 后更新，避免每次按键重绘公式和代码；长文档也默认分屏，工具栏可手动收起预览。
- 不在输入时加模糊、布局动画或对整篇文档反复重置内容。

Vditor 自带的浏览器共享缓存关闭；已有按用户隔离的本地草稿继续由站内逻辑管理。资源加载失败时保留原文本框。

## 本地资产

- 目录：`custom/static-libs/vditor-4.0.0/`，保留官方 LICENSE、README.md 和 dist。
- 来源：官方 npm `vditor@4.0.0`，未修改上游代码。
- npm integrity：`sha512-JUeSmmNNxXaq4j29F6OZ/vLgyM/Wt/SpSK4o/gyrc02uTsS+iTeC0ofajxbW29WSJ4LFMec4nrywVul51PrLvg==`。
- 编辑器、中文语言包、Lute、公式和高亮资源从本站 `/self/lib/` 加载，不依赖外部编辑器 CDN。

## 回归与部署

浏览器测试全部拦截请求，只使用隔离测试页面，不创建真实用户、题目、通知或上传数据。需要 Docker Web 容器提供实际服务端依赖，以及可用的 Playwright。

```bash
node --test custom/tests/markdown_tables.test.js custom/tests/markdown_editor_draft.test.js
NODE_PATH=/tmp/noj-ccsp-review-browser/node_modules node --test custom/tests/vditor.browser.test.js custom/tests/vditor_performance.browser.test.js custom/tests/contest_problem_order.browser.test.js
docker compose up -d --no-deps web
```

新增 `rendererd.js` 挂载后必须重新创建 Web 容器，单纯 restart 不会应用新挂载。无需重启评测服务。

验收涵盖三种编辑模式、即时保存、必填/长度校验、只读/禁用、异步题面、草稿/重置、通知纯文本切换、图片上传成功/拒绝、XSS、主题/手机布局，以及实际题目、比赛、公告、通知、帮助和剪贴板模板的保存请求。线上重复内容表格应不再生成自动 `rowspan` / `colspan`。
