const { getCachedJudgeState, getCachedJudgeDetail } = require('./judger');

const getSubmissionInfo = (s, displayConfig) => ({
    submissionId: s.id,
    taskId: s.task_id,
    user: s.user.username,
    userId: s.user_id,
    problemName: s.problem.title,
    problemId: s.contestProblemIndex || s.problem_id,
    sourceProblemId: s.problem && s.problem.id ? s.problem.id : s.problem_id,
    problemDisplayId: s.problem.getDisplayId(),
    language: displayConfig.showCode ? ((s.language != null && s.language !== '')
      ? (((s.problem.getVJudgeLanguages() || syzoj.languages)[s.language] || {}).show || s.language)
      : null) : null,
    codeSize: displayConfig.showCode ? s.code_length : null,
    submitTime: syzoj.utils.formatDate(s.submit_time),
    adminActionType: s.adminActionType || null,
    canViewDetail: s.canViewDetail !== false,
});

const getRoughResult = (x, displayConfig, roughOnly) => {
    if (displayConfig.showResult) {
        if (x.pending) {
            let res = getCachedJudgeState(x.task_id) || null;
            if (!res) return null;
            const runningResult = (displayConfig.showDetailResult || displayConfig.showProgress) && String(res.result || '').startsWith('Running ')
              ? res.result
              : (String(res.result || '').startsWith('Running ') || roughOnly ? 'Judging' : res.result);
            return {
              result: runningResult,
              time: displayConfig.showUsage ? (roughOnly ? 0 : res.time) : null,
              memory: displayConfig.showUsage ? (roughOnly ? 0 : res.memory) : null,
              score: displayConfig.showScore ? (roughOnly ? 0 : res.score) : null
            };
        } else {
            return {
                result: x.status,
                time: displayConfig.showUsage ? x.total_time : null,
                memory: displayConfig.showUsage ? x.max_memory : null,
                score: displayConfig.showScore ? x.score : null
            };
        }
    } else {
        // 0: Waiting 1: Running
        if (x.status === "System Error")
            return { result: "System Error" };
        if (x.compilation == null || [0, 1].includes(x.compilation.status)) {
            return null;
        } else {
            if (x.compilation.status === 2) { // 2 is TaskStatus.Done
                return { result: "Submitted" };
            } else {
                return { result: "Compile Error" };
            }
        }
    }
}

const processOverallResult = (source, config) => {
    if (source == null)
        return null;
    if (source.error != null) {
        return {
            error: config.showDiagnostics ? source.error : '评测失败。',
            systemMessage: config.showDiagnostics ? source.systemMessage : undefined
        };
    }
    return {
        compile: source.compile,
        judge: config.showDetailResult ? (source.judge && {
            subtasks: source.judge.subtasks && source.judge.subtasks.map(st => ({
                score: st.score,
                resultType: st.resultType,
                resultStatus: st.resultStatus,
                cases: st.cases.map(cs => ({
                    status: cs.status,
                    errorMessage: config.showDiagnostics ? cs.errorMessage : undefined,
                    result: cs.result && {
                        type: cs.result.type,
                        time: config.showUsage ? cs.result.time : undefined,
                        memory: config.showUsage ? cs.result.memory : undefined,
                        scoringRate: cs.result.scoringRate,
                        systemMessage: config.showDiagnostics ? cs.result.systemMessage : undefined,
                        input: config.showTestdata ? cs.result.input : undefined,
                        output: config.showTestdata ? cs.result.output : undefined,
                        userOutput: config.showTestdata ? cs.result.userOutput : undefined,
                        userError: config.showTestdata ? cs.result.userError : undefined,
                        spjMessage: config.showTestdata ? cs.result.spjMessage : undefined,
                    }
                }))
            }))
        }) : null
    };
}

const getCurrentDetailResult = (taskId, config) => processOverallResult(getCachedJudgeDetail(taskId), config);

module.exports = { getCurrentDetailResult, getRoughResult, getSubmissionInfo, processOverallResult };
