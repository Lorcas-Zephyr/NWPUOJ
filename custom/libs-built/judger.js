const enums = require('./enums');
const util = require('util');
const winston = require('winston');
const msgPack = require('msgpack-lite');
const fs = require('fs-extra');
const FastPriorityQueue = require('fastpriorityqueue');
const interface = require('./judger_interfaces');
const judgeResult = require('./judgeResult');
const vjudge = require("./vjudge");
const TypeORM = require('typeorm');
const EventEmitter = require('events');

const judgeStateCache = new Map();
const judgeDetailCache = new Map();
const judgeCacheTimers = new Map();
const JUDGE_CACHE_TTL = 30 * 60 * 1000;
const progressPusher = require('../modules/socketio');
const judgeStateEvents = new EventEmitter();
const judgeReportQueues = new Map();
judgeStateEvents.setMaxListeners(0);

function emitJudgeStateChange(taskId) {
  if (taskId != null) judgeStateEvents.emit(String(taskId));
}

function subscribeJudgeState(taskId, listener) {
  const event = String(taskId);
  judgeStateEvents.on(event, listener);
  return () => judgeStateEvents.removeListener(event, listener);
}

function enqueueJudgeReport(taskId, callback) {
  const key = String(taskId);
  const previous = judgeReportQueues.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(callback);
  judgeReportQueues.set(key, current);
  current.catch(error => winston.error(`Failed to process judge report ${key}: ${error.stack || error}`));
  current.then(() => {
    if (judgeReportQueues.get(key) === current) judgeReportQueues.delete(key);
  }, () => {
    if (judgeReportQueues.get(key) === current) judgeReportQueues.delete(key);
  });
  return current;
}

function cleanupJudgeCaches(taskId) {
  judgeStateCache.delete(taskId);
  judgeDetailCache.delete(taskId);
  const timer = judgeCacheTimers.get(taskId);
  if (timer) clearTimeout(timer);
  judgeCacheTimers.delete(taskId);
}

function setJudgeDetail(taskId, detail) {
  judgeDetailCache.set(taskId, detail);
  const previous = judgeCacheTimers.get(taskId);
  if (previous) clearTimeout(previous);
  const timer = setTimeout(() => cleanupJudgeCaches(taskId), JUDGE_CACHE_TTL);
  if (timer.unref) timer.unref();
  judgeCacheTimers.set(taskId, timer);
}

async function hasCancelledAction(judgeId) {
  if (!judgeId) return false;
  const rows = await TypeORM.getConnection().query(
    "SELECT judge_id FROM judge_state_admin_action WHERE judge_id=? AND action_type='cancelled' LIMIT 1",
    [judgeId]
  );
  return rows.length > 0;
}

const vjudgeStatusStrings = {
  1: 'Accepted',
  2: 'Wrong Answer',
  3: 'Partially Correct',
  4: 'Memory Limit Exceeded',
  5: 'Time Limit Exceeded',
  6: 'Output Limit Exceeded',
  7: 'File Error',
  8: 'Runtime Error',
  9: 'Judgement Failed',
  10: 'Invalid Interaction'
};

function applyVJudgeSummary(convertedResult, source) {
  const summary = source && source.vjudgeSummary;
  if (!summary || !vjudgeStatusStrings[summary.type]) return convertedResult;
  convertedResult.statusString = vjudgeStatusStrings[summary.type];
  if (Number.isFinite(summary.score)) convertedResult.score = summary.score;
  if (Number.isFinite(summary.time)) convertedResult.time = summary.time;
  if (Number.isFinite(summary.memory)) convertedResult.memory = summary.memory;
  return convertedResult;
}

const convertResultWithoutVJudgeSummary = judgeResult.convertResult;
judgeResult.convertResult = function convertResult(taskId, source) {
  return applyVJudgeSummary(convertResultWithoutVJudgeSummary(taskId, source), source);
};

function getRunningTaskStatusString(result) {
  let isPending = status => [0, 1].includes(status);
  let allFinished = 0, allTotal = 0;
  for (let subtask of result.judge.subtasks) {
    for (let curr of subtask.cases) {
      allTotal++;
      if (!isPending(curr.status)) allFinished++;
    }
  }

  return `Running ${allFinished}/${allTotal}`;
}

const judgeQueue = (() => {
  const queue = new FastPriorityQueue();
  let queueConsumers = [];

  class Item {
    constructor(data, priority) {
      this.data = data;
      this.priority = priority;
    }

    valueOf() {
      return this.priority;
    }
  }

  return {
    push(data, priority) {
      const item = new Item(data, priority);
      if (queueConsumers.length > 0) {
        const consumer = queueConsumers.pop();
        consumer(item);
      } else
        queue.add(item);
    },
    poll(timeout) {
      return new Promise(resolve => {
        if (!queue.isEmpty()) return resolve(queue.poll());

        const timer = setTimeout(() => {
          queueConsumers = queueConsumers.filter(cb => cb !== onNewItem);
          resolve(null);
        }, timeout);

        function onNewItem(item) {
          clearTimeout(timer);
          resolve(item);
        }

        queueConsumers.push(onNewItem);
      });
    }
  }
})();

async function connect() {
  const JudgeState = syzoj.model('judge_state');

  const judgeNamespace = syzoj.socketIO.of('judge');
  judgeNamespace.on('connect', socket => {
    winston.info(`Judge client ${socket.id} connected.`);

    let pendingAckTaskObj = null, waitingForTask = false;
    socket.on('waitForTask', async (token, ack) => {
      // Ignore requests with invalid token.
      if (token != syzoj.config.judge_token) {
        winston.warn(`Judge client ${socket.id} emitted waitForTask with invalid token.`);
        return;
      }

      ack();

      if (waitingForTask) {
        winston.warn(`Judge client ${socket.id} emitted waitForTask, but already waiting, ignoring.`);
        return;
      }

      waitingForTask = true;

      winston.warn(`Judge client ${socket.id} emitted waitForTask.`);

      // Poll the judge queue, timeout = 10s.
      let obj;
      while (socket.connected && !obj) {
        obj = await judgeQueue.poll(10);
      }

      if (!obj) {
        winston.warn(`Judge client ${socket.id} disconnected, stop poll the queue.`);
        // Socket disconnected and no task got.
        return;
      }

      winston.warn(`Judge task ${obj.data.content.taskId} poped from queue.`);

      // Re-push to queue if got task but judge client already disconnected.
      if (socket.disconnected) {
        winston.warn(`Judge client ${socket.id} got task but disconnected re-pushing task ${obj.data.content.taskId} to queue.`);
        judgeQueue.push(obj.data, obj.priority);
        return;
      }

      // Send task to judge client, and wait for ack.
      const task = obj.data;
      pendingAckTaskObj = obj;
      winston.warn(`Sending task ${task.content.taskId} to judge client ${socket.id}.`);
      socket.emit('onTask', msgPack.encode(task), () => {
        // Acked.
        winston.warn(`Judge client ${socket.id} acked task ${task.content.taskId}.`);
        pendingAckTaskObj = null;
        waitingForTask = false;
      });
    });

    socket.on('disconnect', reason => {
      winston.warn(`Judge client ${socket.id} disconnected, reason = ${util.inspect(reason)}.`);
      if (pendingAckTaskObj) {
        // A task sent but not acked, push to queue again.
        winston.warn(`Re-pushing task ${pendingAckTaskObj.data.content.taskId} to judge queue.`);
        judgeQueue.push(pendingAckTaskObj.data, pendingAckTaskObj.priority);
        pendingAckTaskObj = null;
      }
    });

    socket.on('reportProgress', (token, payload) => {
      // Ignore requests with invalid token.
      if (token !== syzoj.config.judge_token) {
        winston.warn(`Judge client ${socket.id} emitted reportProgress with invalid token.`);
        return;
      }

      const progress = msgPack.decode(payload);
      winston.verbose(`Got progress from progress exchange, id: ${progress.taskId}`);
      return enqueueJudgeReport(progress.taskId, async () => {

      // 检查是否被取消, 取消则不更新进度
      try {
        const judge_state_check = await JudgeState.findOne({ where: { task_id: progress.taskId } });
        if (judge_state_check && await hasCancelledAction(judge_state_check.id)) {
          cleanupJudgeCaches(progress.taskId);
          emitJudgeStateChange(progress.taskId);
          return;
        }
      } catch (e) {}

      if (progress.type === interface.ProgressReportType.Started) {
        progressPusher.createTask(progress.taskId);
        setJudgeDetail(progress.taskId, {});
        judgeStateCache.set(progress.taskId, {
          result: 'Compiling',
          score: 0,
          time: 0,
          memory: 0
        });
      } else if (progress.type === interface.ProgressReportType.Compiled) {
        setJudgeDetail(progress.taskId, Object.assign({}, judgeDetailCache.get(progress.taskId) || {}, {
          compile: progress.progress
        }));
        progressPusher.updateCompileStatus(progress.taskId, progress.progress);
      } else if (progress.type === interface.ProgressReportType.Progress) {
        setJudgeDetail(progress.taskId, progress.progress);
        const convertedResult = judgeResult.convertResult(progress.taskId, progress.progress);
        judgeStateCache.set(progress.taskId, {
          result: getRunningTaskStatusString(progress.progress),
          score: convertedResult.score,
          time: convertedResult.time,
          memory: convertedResult.memory
        });
        progressPusher.updateProgress(progress.taskId, progress.progress);
      } else if (progress.type === interface.ProgressReportType.Finished) {
        setJudgeDetail(progress.taskId, progress.progress);
        progressPusher.updateResult(progress.taskId, progress.progress);
        setTimeout(() => {
          cleanupJudgeCaches(progress.taskId);
        }, 5000);
      } else if (progress.type === interface.ProgressReportType.Reported) {
        progressPusher.cleanupProgress(progress.taskId);
      }
      if (progress.type !== interface.ProgressReportType.Reported) emitJudgeStateChange(progress.taskId);
      });
    });

    socket.on('reportResult', (token, payload) => {
      // Ignore requests with invalid token.
      if (token !== syzoj.config.judge_token) {
        winston.warn(`Judge client ${socket.id} emitted reportResult with invalid token.`);
        return;
      }

      const result = msgPack.decode(payload);
      winston.verbose('Received report for task ' + result.taskId);
      return enqueueJudgeReport(result.taskId, async () => {

      const judge_state = await JudgeState.findOne({
        where: {
          task_id: result.taskId
        }
      });

      // 检查取消标记: 如果该评测已被管理员取消, 抛弃 daemon 返回的结果
      if (judge_state && await hasCancelledAction(judge_state.id)) {
        winston.warn(`[cancel] Discarding result for cancelled judge ${judge_state.id} (taskId ${result.taskId})`);
        progressPusher.cleanupProgress(result.taskId);
        // 强制保持 Cancelled 状态(防止 daemon 结果覆盖)
        if (judge_state.status !== 'Cancelled') {
          judge_state.status = 'Cancelled';
          judge_state.pending = false;
          judge_state.score = 0;
          judge_state.result = null;
          await judge_state.save();
        }
        emitJudgeStateChange(result.taskId);
        return;
      }

      if (result.type === interface.ProgressReportType.Finished) {
        const convertedResult = judgeResult.convertResult(result.taskId, result.progress);
        winston.verbose('Reporting report finished: ' + result.taskId);
        progressPusher.cleanupProgress(result.taskId);

        if (!judge_state) return;
        const updateResult = await TypeORM.getConnection().query(
          `UPDATE judge_state js SET score=?,pending=0,status=?,total_time=?,max_memory=?,result=?
           WHERE js.id=? AND js.task_id=? AND js.pending=1
             AND NOT EXISTS (SELECT 1 FROM judge_state_admin_action action
               WHERE action.judge_id=js.id AND action.action_type='cancelled')`,
          [convertedResult.score, convertedResult.statusString, convertedResult.time,
            convertedResult.memory, JSON.stringify(convertedResult.result), judge_state.id, result.taskId]
        );
        if (!updateResult.affectedRows) {
          emitJudgeStateChange(result.taskId);
          return;
        }
        judge_state.score = convertedResult.score;
        judge_state.pending = false;
        judge_state.status = convertedResult.statusString;
        judge_state.total_time = convertedResult.time;
        judge_state.max_memory = convertedResult.memory;
        judge_state.result = convertedResult.result;
        try {
          await judge_state.updateRelatedInfo(false);
        } finally {
          emitJudgeStateChange(result.taskId);
        }
      } else if (result.type == interface.ProgressReportType.Compiled) {
        if (!judge_state) return;
        await TypeORM.getConnection().query(
          `UPDATE judge_state js SET compilation=? WHERE js.id=? AND js.task_id=? AND js.pending=1
             AND NOT EXISTS (SELECT 1 FROM judge_state_admin_action action
               WHERE action.judge_id=js.id AND action.action_type='cancelled')`,
           [JSON.stringify(result.progress), judge_state.id, result.taskId]
        );
        emitJudgeStateChange(result.taskId);
      } else {
        winston.error('Unsupported result type: ' + result.type);
      }
      });
    });
  });
}
module.exports.connect = connect;

async function findActiveVJudgeState(id, taskId, requirePending) {
  const JudgeState = syzoj.model('judge_state');
  for (let attempt = 0; attempt < (requirePending ? 40 : 1); attempt++) {
    const state = await JudgeState.findOne({ where: { id: id, task_id: taskId } });
    if (!state) return null;
    if (await hasCancelledAction(state.id)) return null;
    if (!requirePending || state.pending) return state;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return null;
}

async function handleVJudgeProgress(judgeStateId, progress) {
  console.log(progress);
  const currentJudgeState = await findActiveVJudgeState(judgeStateId, progress.taskId, false);
  if (!currentJudgeState) {
    cleanupJudgeCaches(progress.taskId);
    progressPusher.cleanupProgress(progress.taskId);
    return false;
  }

  if (progress.type === interface.ProgressReportType.Compiled) {
    setJudgeDetail(progress.taskId, Object.assign({}, judgeDetailCache.get(progress.taskId) || {}, {
      compile: progress.progress
    }));
    progressPusher.updateCompileStatus(progress.taskId, progress.progress);
  } else if (progress.type === interface.ProgressReportType.Progress) {
    setJudgeDetail(progress.taskId, progress.progress);
    const convertedResult = judgeResult.convertResult(progress.taskId, progress.progress);
    judgeStateCache.set(progress.taskId, {
      result: getRunningTaskStatusString(progress.progress),
      score: convertedResult.score,
      time: convertedResult.time,
      memory: convertedResult.memory
    });
    progressPusher.updateProgress(progress.taskId, progress.progress);
  } else if (progress.type === interface.ProgressReportType.Finished) {
    setJudgeDetail(progress.taskId, progress.progress);
    const activeState = await findActiveVJudgeState(judgeStateId, progress.taskId, true);
    if (!activeState) {
      cleanupJudgeCaches(progress.taskId);
      return false;
    }

    const convertedResult = judgeResult.convertResult(progress.taskId, progress.progress);
    const updateResult = await TypeORM.getConnection().query(
      `UPDATE judge_state js SET score=?,pending=0,status=?,total_time=?,max_memory=?,result=?,compilation=?
       WHERE js.id=? AND js.task_id=? AND js.pending=1
         AND NOT EXISTS (SELECT 1 FROM judge_state_admin_action action
           WHERE action.judge_id=js.id AND action.action_type='cancelled')`,
      [
        convertedResult.score == null ? 0 : convertedResult.score,
        convertedResult.statusString,
        convertedResult.time,
        convertedResult.memory,
        JSON.stringify(convertedResult.result),
        progress.progress.compile ? JSON.stringify(progress.progress.compile) : null,
        judgeStateId,
        progress.taskId
      ]
    );
    if (!updateResult || updateResult.affectedRows !== 1) {
      cleanupJudgeCaches(progress.taskId);
      emitJudgeStateChange(progress.taskId);
      return false;
    }

    try {
      progressPusher.updateResult(progress.taskId, progress.progress);
      const finalJudgeState = await syzoj.model('judge_state').findOne({
        where: { id: judgeStateId, task_id: progress.taskId }
      });
      if (finalJudgeState) {
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            await finalJudgeState.updateRelatedInfo(false);
            break;
          } catch (e) {
            if (attempt === 3) {
              winston.error(`Failed to update VJudge statistics for ${progress.taskId}: ${e.stack || e}`);
            } else {
              await new Promise(resolve => setTimeout(resolve, 200 * attempt));
            }
          }
        }
      }
    } finally {
      emitJudgeStateChange(progress.taskId);
      setTimeout(() => {
        cleanupJudgeCaches(progress.taskId);
        progressPusher.cleanupProgress(progress.taskId);
      }, 5000);
    }
  }
  if (progress.type !== interface.ProgressReportType.Finished) emitJudgeStateChange(progress.taskId);
  return true;
}

function enqueueVJudgeProgress(judgeStateId, progress) {
  return enqueueJudgeReport(progress.taskId, () => handleVJudgeProgress(judgeStateId, progress));
}

module.exports.handleVJudgeProgress = enqueueVJudgeProgress;
module.exports.applyVJudgeSummary = applyVJudgeSummary;
module.exports.initializeRecoveredVJudge = function initializeRecoveredVJudge(judgeState) {
  if (judgeStateCache.has(judgeState.task_id)) return;
  progressPusher.createTask(judgeState.task_id);
  setJudgeDetail(judgeState.task_id, {});
  judgeStateCache.set(judgeState.task_id, {
    result: 'Pending',
    score: Number(judgeState.score || 0),
    time: Number(judgeState.total_time || 0),
    memory: Number(judgeState.max_memory || 0)
  });
};

module.exports.judge = async function (judge_state, problem, priority) {
  if (typeof problem.type === 'string' && problem.type.startsWith('vjudge:')) {
    progressPusher.createTask(judge_state.task_id);
    setJudgeDetail(judge_state.task_id, {});
    judgeStateCache.set(judge_state.task_id, {
      result: 'Pending',
      score: 0,
      time: 0,
      memory: 0
    });

    return vjudge(judge_state, problem, progress => enqueueVJudgeProgress(judge_state.id, progress));
  }

  let type, param, extraData = null;
  switch (problem.type) {
    case 'submit-answer':
      type = enums.ProblemType.AnswerSubmission;
      param = null;
      extraData = await fs.readFile(syzoj.model('file').resolvePath('answer', judge_state.code));
      break;
    case 'interaction':
      type = enums.ProblemType.Interaction;
      param = {
        language: judge_state.language,
        code: judge_state.code,
        timeLimit: problem.time_limit,
        memoryLimit: problem.memory_limit,
      }
      break;
    default:
      type = enums.ProblemType.Standard;
      param = {
        language: judge_state.language,
        code: judge_state.code,
        timeLimit: problem.time_limit,
        memoryLimit: problem.memory_limit,
        fileIOInput: problem.file_io ? problem.file_io_input_name : null,
        fileIOOutput: problem.file_io ? problem.file_io_output_name : null
      };
      break;
  }

  const content = {
    taskId: judge_state.task_id,
    judgeId: judge_state.id,
    testData: problem.id.toString(),
    type: type,
    priority: priority,
    realPriority: priority - parseInt(judge_state.id) / 10000000,
    param: param
  };

  judgeQueue.push({
    content: content,
    extraData: extraData
  }, content.realPriority);

  winston.warn(`Judge task ${content.taskId} enqueued.`);
}

module.exports.getCachedJudgeState = taskId => judgeStateCache.get(taskId);
module.exports.getCachedJudgeDetail = taskId => judgeDetailCache.get(taskId);
module.exports.emitJudgeStateChange = emitJudgeStateChange;
module.exports.subscribeJudgeState = subscribeJudgeState;
