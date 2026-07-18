const crypto = require('crypto');
const TypeORM = require('typeorm');
const contestMutation = require('../libs/contest-mutation');
const contestRating = require('../libs/contest-rating');
const JudgeState = syzoj.model('judge_state');

let schemaPromise = null;
const contestRatingRequestCache = new Map();
function ensureRatingSchema() {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      const connection = TypeORM.getConnection();
      await connection.query(`
        CREATE TABLE IF NOT EXISTS contest_rating_config (
          contest_id INT NOT NULL,
          is_rated TINYINT(1) NOT NULL DEFAULT 0,
          updated_at INT NOT NULL,
          updated_by INT NULL,
          PRIMARY KEY (contest_id),
          KEY idx_contest_rating_config_rated (is_rated)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
      await connection.query(`
        INSERT IGNORE INTO contest_rating_config (contest_id,is_rated,updated_at,updated_by)
        SELECT id,0,UNIX_TIMESTAMP(),NULL FROM contest
      `);
      await connection.query(`
        CREATE TABLE IF NOT EXISTS contest_rating_finalization (
          contest_id INT NOT NULL,
          rating_calculation_id INT NULL,
          status VARCHAR(24) NOT NULL,
          participant_count INT NOT NULL DEFAULT 0,
          algorithm_version INT NOT NULL,
          completed_at INT NOT NULL,
          skip_reason VARCHAR(120) NULL,
          PRIMARY KEY (contest_id),
          UNIQUE KEY uq_contest_rating_calculation (rating_calculation_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
      await connection.query(`
        CREATE TABLE IF NOT EXISTS contest_rating_system_state (
          id TINYINT NOT NULL,
          initialized_at INT NOT NULL,
          PRIMARY KEY (id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
      const release = await contestMutation.acquireContestLock('rating-initialize');
      try {
        await contestMutation.withTransactionRetry(async manager => {
          const state = await manager.query('SELECT id FROM contest_rating_system_state WHERE id=1 FOR UPDATE');
          if (state.length) return;
          const nowRows = await manager.query('SELECT UNIX_TIMESTAMP() AS now');
          const now = Number(nowRows[0].now);
          await manager.query(
            `INSERT IGNORE INTO contest_rating_finalization
              (contest_id,rating_calculation_id,status,participant_count,algorithm_version,completed_at,skip_reason)
             SELECT id,NULL,'legacy_unrated',0,?,?,'predates_automatic_rating'
             FROM contest WHERE end_time<=?`,
            [contestRating.ALGORITHM_VERSION,now,now]
          );
          await manager.query('INSERT INTO contest_rating_system_state (id,initialized_at) VALUES (1,?)', [now]);
        });
      } finally {
        await release();
      }
    })().catch(error => {
      schemaPromise = null;
      throw error;
    });
  }
  return schemaPromise;
}

if (!JudgeState.prototype.__protectedRejudge) {
  const originalRejudge = JudgeState.prototype.rejudge;
  JudgeState.prototype.rejudge = async function protectedRejudge() {
    await ensureRatingSchema();
    const actions = await TypeORM.getConnection().query(
      'SELECT judge_id FROM judge_state_admin_action WHERE judge_id=? LIMIT 1',
      [this.id]
    );
    if (actions.length) throw new ErrorMessage('该提交已被管理员标记，不能直接重新评测。');
    if (Number(this.type) === 1 && await isContestRatingFinalized(Number(this.type_info))) {
      throw new ErrorMessage('该比赛 Rating 已结算，不能重新评测提交。');
    }
    return originalRejudge.call(this);
  };
  JudgeState.prototype.__protectedRejudge = true;
}

ensureRatingSchema().catch(error => {
  syzoj.log('[contest-rating] schema initialization failed: ' + (error.stack || error));
  process.exit(1);
});

async function isContestRatingFinalized(contestId) {
  await ensureRatingSchema();
  const rows = await TypeORM.getConnection().query(
    "SELECT status FROM contest_rating_finalization WHERE contest_id=? AND status='completed' LIMIT 1",
    [contestId]
  );
  return rows.length > 0;
}

function validAdminCsrfToken(req) {
  const expected = req.session && req.session.adminCsrfToken;
  const actual = req.body && req.body.csrf_token;
  return typeof expected === 'string' && typeof actual === 'string' &&
    expected.length === actual.length &&
    crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}

async function runFinalizationPass() {
  await ensureRatingSchema();
  const release = await contestMutation.acquireContestLock('rating-finalizer');
  try {
    const contests = await TypeORM.getConnection().query(
      `SELECT contest.id FROM contest
       INNER JOIN contest_rating_config config ON config.contest_id=contest.id AND config.is_rated=1
       LEFT JOIN contest_rating_finalization finalization ON finalization.contest_id=contest.id
       WHERE contest.end_time<=UNIX_TIMESTAMP() AND finalization.contest_id IS NULL
       ORDER BY contest.end_time ASC,contest.id ASC`
    );
    for (const contest of contests) {
      const result = await contestRating.finalizeContest(Number(contest.id));
      if (result.status === 'deferred') {
        syzoj.log(`[contest-rating] Contest #${contest.id} deferred because submissions are still pending.`);
      }
    }
  } finally {
    await release();
  }
}

async function scheduleFinalization() {
  try {
    await runFinalizationPass();
  } catch (error) {
    syzoj.log('[contest-rating] finalization failed: ' + (error.stack || error));
  } finally {
    setTimeout(scheduleFinalization, 60 * 1000);
  }
}

setTimeout(scheduleFinalization, 15 * 1000);
syzoj.utils.finalizeContestRating = contestRating.finalizeContest;
syzoj.utils.isContestRatingFinalized = isContestRatingFinalized;
syzoj.utils.ensureContestRatingSchema = ensureRatingSchema;

app.use(async (req, res, next) => {
  try {
    const match = /^\/contest\/(\d+)(?:\/|$)/.exec(req.path);
    if (!match) return next();
    await ensureRatingSchema();
    const contestId = Number(match[1]);
    const now = Date.now();
    let cached = contestRatingRequestCache.get(contestId);
    if (!cached || cached.expiresAt <= now) {
      const entry = { expiresAt: Infinity, promise: null };
      entry.promise = TypeORM.getConnection().query(
        `SELECT config.is_rated,contest.start_time,finalization.status AS rating_status,
                 EXISTS(SELECT 1 FROM contest_rating_finalization finalization
                        WHERE finalization.contest_id=contest.id AND finalization.status='completed') AS finalized
          FROM contest
          LEFT JOIN contest_rating_config config ON config.contest_id=contest.id
          LEFT JOIN contest_rating_finalization finalization ON finalization.contest_id=contest.id
          WHERE contest.id=? LIMIT 1`,
        [contestId]
      ).then(rows => {
        entry.expiresAt = Date.now() + 2000;
        return rows;
      }).catch(error => {
        if (contestRatingRequestCache.get(contestId) === entry) contestRatingRequestCache.delete(contestId);
        throw error;
      });
      contestRatingRequestCache.set(contestId, entry);
      cached = entry;
    }
    const rows = await cached.promise;
    res.locals.contestRated = !!(rows.length && rows[0].is_rated);
    res.locals.contestRatingFinalizationStatus = rows.length ? rows[0].rating_status : null;
    res.locals.contestRatingCanRecalculate = !!(res.locals.user && res.locals.user.is_admin);
    res.locals.contestRatingLocked = !!(rows.length && (
      Number(rows[0].start_time) <= Math.floor(Date.now() / 1000) || Number(rows[0].finalized) === 1
    ));
    next();
  } catch (error) {
    next(error);
  }
});

app.post('/contest/:id/rating/recalculate', async (req, res) => {
  try {
    const contestId = Number(req.params.id);
    if (!Number.isSafeInteger(contestId) || contestId <= 0) {
      throw contestMutation.mutationError('比赛 ID 不正确。');
    }
    if (!res.locals.user || !res.locals.user.is_admin) {
      throw contestMutation.mutationError('只有站点管理员可以重新计算 Rating。', 403);
    }
    if (!validAdminCsrfToken(req)) {
      throw contestMutation.mutationError('页面已失效，请刷新比赛管理页后重试。', 403);
    }
    await ensureRatingSchema();
    const result = await contestRating.recalculateRatingsFrom(contestId);
    syzoj.log(
      `[contest-rating] User #${res.locals.user.id} recalculated from contest #${contestId}: ` +
      `${result.contestCount} contests, ${result.userIds.length} users.`
    );
    res.redirect(303, syzoj.utils.makeUrl(['contest', contestId, 'edit'], {
      rating_recalculated: 1,
      rating_contests: result.contestCount,
      rating_users: result.userIds.length
    }));
  } catch (error) {
    syzoj.log('[contest-rating] recalculation failed: ' + (error.stack || error));
    res.status(error.statusCode || 400).render('error', { err: error });
  }
});

app.post('/admin/rating/add', async (req, res) => {
  res.status(404).render('error', {
    err: new ErrorMessage('单场比赛手动 Rating 计算已关闭，Rated 比赛将在结束后自动结算。')
  });
});

app.post('/admin/rating/delete', async (req, res) => {
  if (!res.locals.user || !res.locals.user.is_admin) {
    return res.status(403).render('error', { err: new ErrorMessage('您没有权限进行此操作。') });
  }
  res.status(409).render('error', {
    err: new ErrorMessage('自动 Rating 历史不能单独删除，否则会破坏后续比赛的 Rating 基线。')
  });
});

app.post([
  '/submission/:id/admin-action',
  '/submission/:id/admin-action/revoke',
  '/submission/:id/restore-and-rejudge',
  '/submission/:id/rejudge'
], async (req, res, next) => {
  try {
    const rows = await TypeORM.getConnection().query('SELECT type,type_info FROM judge_state WHERE id=? LIMIT 1', [Number(req.params.id)]);
    if (rows.length && Number(rows[0].type) === 1) {
      const contestId = Number(rows[0].type_info);
      const release = await contestMutation.acquireContestLock(contestId);
      let released = false;
      const releaseOnce = () => {
        if (released) return;
        released = true;
        release().catch(error => syzoj.log(error));
      };
      if (await isContestRatingFinalized(contestId)) {
        await release();
        released = true;
        return res.status(409).render('error', {
          err: new ErrorMessage('该比赛 Rating 已结算，不能再修改提交状态。')
        });
      }
      res.locals.contestMutationLockHeld = true;
      res.once('finish', releaseOnce);
      res.once('close', releaseOnce);
      if (syzoj.utils.runWithContestLockContext) {
        return syzoj.utils.runWithContestLockContext(contestId, next);
      }
    }
    next();
  } catch (error) {
    next(error);
  }
});

app.get('/user/:id', (req, res, next) => {
  const originalRender = res.render.bind(res);
  res.render = function renderUserWithRatingHistory(view, options) {
    if (view !== 'user' || !options || !options.show_user) return originalRender.apply(res, arguments);
    TypeORM.getConnection().query(
      `SELECT rc.contest_id,c.title,rh.rating_after,rh.rank,finalization.participant_count
       FROM rating_history rh
       INNER JOIN rating_calculation rc ON rc.id=rh.rating_calculation_id
       LEFT JOIN contest c ON c.id=rc.contest_id
       LEFT JOIN contest_rating_finalization finalization ON finalization.contest_id=rc.contest_id
       WHERE rh.user_id=? ORDER BY rh.rating_calculation_id ASC`,
      [options.show_user.id]
    ).then(rows => {
      let previous = Number(syzoj.config.default.user.rating);
      const histories = [{ contestName: '初始 Rating', contestId: null, value: previous, before: null, delta: null, rank: null }];
      for (const row of rows) {
        const after = Number(row.rating_after);
        histories.push({
          contestName: row.title || `比赛 #${row.contest_id}`,
          contestId: Number(row.contest_id),
          value: after,
          before: previous,
          delta: after - previous,
          rank: row.rank == null ? null : Number(row.rank),
          participants: Number(row.participant_count || 0)
        });
        previous = after;
      }
      options.ratingHistories = histories.reverse();
      originalRender(view, options);
    }).catch(next);
    return res;
  };
  next();
});

app.get('/contest/:id/ranklist', (req, res, next) => {
  const originalRender = res.render.bind(res);
  res.render = function renderRanklistWithRating(view, options) {
    if (view !== 'contest_ranklist' || !options || !Array.isArray(options.ranklist)) {
      return originalRender.apply(res, arguments);
    }
    TypeORM.getConnection().query(
      `SELECT rh.user_id,rh.rating_calculation_id,rh.rating_after,rh.rank,u.rating,
              finalization.participant_count
       FROM contest_rating_finalization finalization
       INNER JOIN rating_history rh ON rh.rating_calculation_id=finalization.rating_calculation_id
       INNER JOIN user u ON u.id=rh.user_id
       WHERE finalization.contest_id=? AND finalization.status='completed'`,
      [Number(req.params.id)]
    ).then(rows => {
      const changes = new Map(rows.map(row => [Number(row.user_id), {
        calculationId: Number(row.rating_calculation_id),
        after: Number(row.rating_after),
        rank: Number(row.rank),
        participants: Number(row.participant_count)
      }]));
      let previousByUser = new Map();
      return Promise.all(Array.from(changes.keys()).map(async userId => {
        const historyRows = await TypeORM.getConnection().query(
          `SELECT rh.rating_after FROM rating_history rh
           INNER JOIN rating_calculation rc ON rc.id=rh.rating_calculation_id
           WHERE rh.user_id=? AND rh.rating_calculation_id<? ORDER BY rh.rating_calculation_id DESC LIMIT 1`,
          [userId,changes.get(userId).calculationId]
        );
        previousByUser.set(userId, historyRows.length ? Number(historyRows[0].rating_after) : Number(syzoj.config.default.user.rating));
      })).then(() => {
        options.ranklist.forEach(item => {
          const change = changes.get(Number(item.user.id));
          if (change) item.ratingChange = Object.assign(change, { before: previousByUser.get(Number(item.user.id)) });
        });
        options.contestRatingFinalized = changes.size > 0;
        return TypeORM.getConnection().query(
          'SELECT status,skip_reason,participant_count FROM contest_rating_finalization WHERE contest_id=? LIMIT 1',
          [Number(req.params.id)]
        ).then(statusRows => {
          options.contestRatingStatus = statusRows.length ? statusRows[0] : null;
          originalRender(view, options);
        });
      });
    }).catch(next);
    return res;
  };
  next();
});
