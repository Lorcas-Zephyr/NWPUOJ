# 帮助

## 评测

- C 和 C++ 程序使用站点已启用的编译器与语言标准进行编译。
- Java 程序应包含入口类；没有 `public class` 时请将入口类命名为 `Main`。
- 除题目明确要求文件输入输出外，程序必须从标准输入读取并向标准输出写入。
- 提交前请确认语言、时间限制、内存限制和输入输出方式。

## 个人资料

头像由本站保存。用户可在“修改资料”页面上传 PNG、JPG 或 WebP 图片，也可以恢复站点默认头像。

## 图床与题面图片

拥有全局题目编辑权限的用户、基地成员、全站管理员和站长可以打开[图床](/image-host)上传题面图片。支持 JPG、PNG、WebP 和 GIF，单张图片不能超过 10 MiB。上传成功后，在“我的图片”列表中复制图片的外网链接，或直接复制生成的 Markdown 代码。

题面编辑器使用 Markdown。将图床链接放在图片语法的括号中即可在题面显示图片，格式如下：

```markdown
![图片说明](https://你的域名/self/image-assets/图片文件名)
```

例如：

```markdown
![样例示意图](https://noj.nwpu.edu.cn/self/image-assets/2f7c9c2e7b4d4f30a4f2d9e8c1a6b5f0.png)
```

也可以直接使用图床页面返回的 Markdown 代码。图片链接可以放在题面正文、输入/输出说明、样例说明等 Markdown 内容中。删除图床图片后，已经引用该图片的题面链接将无法访问，请确认不再使用后再删除。

## 手动添加题目

拥有题目管理权限的用户可在[添加题目](/problem/0/edit)页面创建单道主题库题目。题面使用 Markdown，并支持 TeX 公式。

<span id="bulk-problem-import"></span>
## 批量上传题目

拥有题目管理权限的用户可在[批量导入页面](/problems/import)下载 ZIP 模板并一次创建多道题目。ZIP 根目录下每个题目文件夹至少包含 `statement.md`（也可用 `problem.md`），可选包含 `problem.json` 和 `testdata/` 或 `testdata.zip`。

在 `problem.json` 中使用 `tag_names` 按名称填写已有标签，例如：

```json
{
  "title": "动态规划入门",
  "tag_names": ["动态规划", "图论"]
}
```

标签名称与题库中的名称完全匹配时才会关联，每题最多关联 20 个标签。拼写不匹配、重复或格式无效的标签会跳过，不影响题目导入。下载的 ZIP 模板已经包含 `tag_names` 字段。

<span id="zip-bulk-import-format"></span>
## 评测数据 ZIP 格式

在题目的“管理题目 -> 数据包”中上传测试数据 ZIP。文件通常直接放在 ZIP 根目录；如果压缩包只有一个顶层目录（例如 `data/` 或 `problem/testdata/`），系统会自动展开这类最多三层的目录。根目录也可以保留 `data.yml`、交互器或检查器，并将测试点放在一个名为 `data/`、`testdata/`、`tests/`、`testcases/` 或 `cases/` 的目录中，系统会自动展开该目录并修正 `data.yml` 的文件名前缀。文件名区分大小写，禁止绝对路径、反斜杠路径、`..` 路径穿越、符号链接、设备文件和加密条目。

上传 ZIP、解压后总大小的上限均为 200 MiB；最多 2000 个条目，单个解压文件最大 50 MiB。上传后请确认页面显示的测试点数量与预期一致。

`data.yml` 使用 UTF-8 YAML。文件名模板中的 `#` 会替换为 `cases` 中的测试点编号。每个子任务的 `score` 为该子任务分值，`type` 可取 `sum`、`min` 或 `mul`；所有子任务分值通常应合计为 100。

### 传统题

不需要子任务或 Special Judge 时，可以不写 `data.yml`。系统会自动配对根目录下同名的 `.in` 与 `.out`；`.ans` 也可代替 `.out`。

```text
traditional.zip
├── 1.in
├── 1.out
├── 2.in
└── 2.out
```

需要划分子任务时，在根目录加入：

```yaml
inputFile: "#.in"
outputFile: "#.out"
subtasks:
  - score: 30
    type: sum
    cases: [1, 2]
  - score: 70
    type: sum
    cases: [3, 4]
```

使用 Special Judge 时，将检查器源文件放在根目录，并在 `data.yml` 中增加：

```yaml
specialJudge:
  language: cpp17
  fileName: checker.cpp
```

检查器运行目录提供 `input`、`answer`、`user_out` 和 `code` 文件。检查器向标准输出写入 `0` 至 `100` 的得分，向标准错误写入提示信息。`cpp` 使用 C++03；需要 C++11 或更新语法时请使用 `cpp11` 或 `cpp17`。没有 `data.yml` 时，也可使用自动识别名称，例如 `spj_cpp.cpp`。

### 交互题

交互题必须提供 `data.yml` 和交互器源文件，并用 `interactor` 声明语言和文件名。下面的包包含两个测试点：

```text
interaction.zip
├── data.yml
├── interactor.cpp
├── 1.in
├── 1.ans
├── 2.in
└── 2.ans
```

```yaml
inputFile: "#.in"
outputFile: "#.ans"
interactor:
  language: cpp17
  fileName: interactor.cpp
subtasks:
  - score: 100
    type: sum
    cases: [1, 2]
```

交互器通过标准输入输出与选手程序通信。运行目录提供 `input`、`answer` 和 `code` 文件；交互器正常结束前必须在当前目录写入 `score.txt`，内容为 `0` 至 `100` 的数字。写入 `-1` 表示交互无效。`cpp` 使用 C++03；包含 `using`、属性或其他现代 C++ 语法的交互器应声明为 `cpp11` 或 `cpp17`。

<span id="communication-problems"></span>
### 通信题

同一份选手程序运行两次：**第一轮运行 → 转换程序处理第一轮输出 → 第二轮运行 → 检查第二轮输出**。

在“管理题目 → 题目类型”中选择「通信」，再上传测试数据 ZIP。选手仍然只提交一份代码，可使用当前开放的全部 8 种语言。程序如何区分两轮由题目约定，例如第一轮输入以 `1` 开头，转换后的第二轮输入以 `2` 开头；系统不会自动添加阶段标记。

[下载完整通信题示例数据包](/self/lib/communication-example.zip)。包内包含转换程序、两个测试点及参考代码 `solution.cpp`：第一轮计算两数之和，转换程序验证后交给第二轮，第二轮输出该和的两倍。

测试数据包的根目录包含：

```text
communication.zip
├── data.yml
├── transform.cpp
├── 1.in
├── 1.out
├── 2.in
└── 2.out
```

`data.yml` 示例：

```yaml
inputFile: "#.in"
outputFile: "#.out"
communication:
  language: cpp17
  fileName: transform.cpp
subtasks:
  - score: 100
    type: sum
    cases: [1, 2]
```

转换程序从标准输入读取第一轮的完整输出，将第二轮输入写到标准输出，提示信息写到标准错误流。其独立运行目录提供 `first_output`，以及数据包中配置的原始 `input` 和标准 `answer`。转换程序需要自行校验通信内容、格式和长度等题目限制。

| 转换程序退出码 | 处理结果 |
| --- | --- |
| `0` | 使用转换后的输入继续第二轮 |
| `1` | Wrong Answer，例如通信内容不符合要求 |
| `2` | Presentation Error，例如第一轮输出格式错误 |
| 其他退出码、崩溃或资源超限 | Judgement Failed，需检查转换程序或测试数据 |

两轮在独立沙箱和工作目录中运行，不能共享内存或残留文件。**时间限制为两轮累计用时**，第二轮使用剩余时间；内存限制分别生效，记录两轮峰值中的最大值。Python/PyPy、Java 的时间倍数照常生效。转换程序使用独立的评测资源，不计入选手用时。任一轮发生 RE、TLE、MLE 或 OLE 时立即停止，详情会标明出错轮次。

第二轮输出默认与标准答案比较，也可在 `data.yml` 中配置 `specialJudge`。检查器除 `input`、`answer`、`user_out`（第二轮输出）和 `code` 外，还可读取 `first_output`、`second_input`，并按现有规则输出 0 至 100 的得分。

提交详情可查看两轮输出、错误信息和转换后的第二轮输入，显示内容受现有测试数据查看权限限制。详情中的内容为长度受限的预览，实际传递和判题使用完整文件。

### 提交答案题

提交答案题建议始终提供 `data.yml`，使用 `userOutput` 明确选手答案 ZIP 中每个测试点的文件名。测试数据包示例：

```text
submit-answer.zip
├── data.yml
├── 1.in
├── 1.ans
├── 2.in
└── 2.ans
```

```yaml
inputFile: "#.in"
outputFile: "#.ans"
userOutput: "#.out"
subtasks:
  - score: 100
    type: sum
    cases: [1, 2]
```

选手提交的答案 ZIP 必须在根目录包含 `1.out`、`2.out` 等 `userOutput` 指定的文件，不能额外套文件夹。缺少任一文件会得到文件错误。需要自定义评分时，可按传统题相同方式增加 `specialJudge`；未配置检查器时使用普通输出比较。

## Hit 值

Hit 值每天 `00:00` 按 Asia/Shanghai 时区全量计算。若服务重启导致当天零点任务未执行，启动后会自动补算。


<span id="activity-registration"></span>
## 活动报名

通过侧栏的 **活动报名** 打开活动列表。这是独立的活动报名表，不会自动报名 OJ 比赛或创建比赛账号。

- **个人报名**：打开“我的报名”，开始填写，保存并确认信息，再点击“提交报名”。
- **组队报名**：队长创建队伍，按 OJ 用户名邀请成员；队员在该活动的“我的报名”中接受邀请，分别填写并确认自己的信息。人数满足要求后，由队长提交整队报名。待确认邀请不占用报名资格，同一活动不能加入多支队伍。
- **实名资料**：自动读取本人账户的用户名、姓名、学号、学院。报名时保存快照；账号资料之后的变化不会自动改写报名。队友只能看到用户名和填写状态，管理者可以查看完整报名信息。
- **审核与修改**：活动可以设置提交即成功或管理员审核。审核退回时按说明修改并重新提交；已通过的信息发生修改会重新进入审核。报名开放时间内可以撤回，队员退出会使整队回到填写状态。截止后只能查看。
- **管理活动**：在现有权限管理中授予全局“活动管理”权限，便可在活动列表创建活动，并在活动页管理报名名单、表单和设置。支持个人 / 组队、人数范围、24 小时制起止时间、Markdown 介绍、表单字段、审核、搜索及 CSV 导出（Excel 可打开）。已有报名记录后，报名方式、人数范围、审核规则和字段结构不可修改；可复制为新的草稿活动再调整。

所有活动时间均为北京时间（Asia/Shanghai），报名截止时刻不再接受修改或提交。邀请显示在活动页内，队长需自行告知队员前往确认。
