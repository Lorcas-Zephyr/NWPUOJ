# 帮助

## 评测

- C 和 C++ 程序使用站点已启用的编译器与语言标准进行编译。
- Java 程序应包含入口类；没有 `public class` 时请将入口类命名为 `Main`。
- 除题目明确要求文件输入输出外，程序必须从标准输入读取并向标准输出写入。
- 提交前请确认语言、时间限制、内存限制和输入输出方式。

## 个人资料

头像由本站保存。用户可在“修改资料”页面上传 PNG、JPG 或 WebP 图片，也可以恢复站点默认头像。

## 手动添加题目

拥有题目管理权限的用户可在[添加题目](/problem/0/edit)页面创建单道主题库题目。题面使用 Markdown，并支持 TeX 公式。

<span id="zip-bulk-import-format"></span>
## 评测数据 ZIP 格式

在题目的“管理题目 -> 数据包”中上传测试数据 ZIP。压缩包内的文件必须直接放在 ZIP 根目录，不能额外套一层同名文件夹；`data.yml` 中引用的文件名也相对于根目录。文件名区分大小写，禁止绝对路径、反斜杠路径、`..` 路径穿越、符号链接、设备文件和加密条目。

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
