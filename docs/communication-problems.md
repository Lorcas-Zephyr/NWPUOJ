# 通信题

题目管理中选择「通信」，上传包含 `data.yml`、转换程序和测试数据的 ZIP。选手仍提交一份程序，可使用现有提交语言。数据、转换程序和题目类型随提交快照固定，重测使用原快照。

每个测试点依次执行：

1. 编译一次选手代码，将原始输入交给第一次运行。
2. 第一轮正常退出后，转换程序读取第一轮输出并生成第二轮输入。
3. 在全新的沙箱和工作目录中第二次运行同一个程序。
4. 用标准答案或 Special Judge 检查第二轮输出。

时间限制是两轮累计 CPU 时间，第二轮使用剩余时间；内存限制分别生效，记录两轮峰值的最大值。Python/PyPy、Java 时间倍数照常生效。转换程序和检查器使用独立的 Special Judge 时限、内存限制，不计入选手用时。选手不能通过内存、工作目录文件或可写的可执行文件跨轮传递信息。

## 转换程序

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

转换程序从标准输入读取第一轮的完整标准输出，向标准输出写入第二轮输入。其独立工作目录提供原始 `input`、标准 `answer`（数据包配置了对应文件时）和 `first_output`。标准错误流用于提示信息。

| 转换程序退出码 | 处理 |
| --- | --- |
| 0 | 继续第二轮 |
| 1 | Wrong Answer，例如通信内容超出题目限制 |
| 2 | Presentation Error，例如第一轮输出格式错误 |
| 其他、崩溃或资源超限 | Judgement Failed，需检查转换程序或数据 |

转换程序必须自行校验第一轮输出的格式、长度和通信限制。两轮如何识别阶段由题目协议决定：例如原始输入以 `1` 开头，转换后的输入以 `2` 开头。系统不会自动添加阶段标记。

任一轮选手程序异常都会立即停止，正确保留 RE、TLE、MLE、OLE 等结果。测试点详情包含两轮运行指标、输出、错误信息以及转换后的输入，沿用现有测试数据和诊断信息权限，比赛期间不会向无权查看数据的选手泄露内容。详情只显示有限长度的预览；实际传递和判题使用完整文件。

可在 `data.yml` 中同时指定 `specialJudge`。检查器除现有 `input`、`answer`、`user_out`（第二轮输出）、`code` 外，还可读取 `first_output`、`second_input`。检查器仍输出 0–100 的得分，支持部分分。

## 示例

[示例目录](../custom/examples/communication) 中的题目要求第一轮输出两数之和，转换程序验证后加上阶段标记，第二轮输出该和的两倍。`solution.cpp` 是同一份程序两次运行的参考实现。管理页可直接下载完整示例 ZIP。

## 实现与部署

Web 的题目枚举新增 `communication`，启动时由现有 TypeORM schema 同步追加数据库枚举值。现有类型及历史快照不变。daemon 协议新增类型 4；两轮作为一个带 `communication` 参数的标准 RPC 在同一 runner 顺序执行。必须先更新全部 runner、再更新 daemon，最后更新 Web 后才能开放此题型。

`custom/judge/daemon-*.js`、`runner-communication.js` 和 `runner-judge.js` 是受版本管理的运行实现，同时由 Compose 挂载和 Dockerfile 复制。额外编译文件纳入编译缓存键，避免不同数据快照的头文件复用旧二进制。

回滚时先停止创建通信题提交并等待队列清空；已有通信题和提交仍需保留新 daemon/runner 才能重测，不能将其按普通题静默评测。不要删除题目、快照或结果数据。
