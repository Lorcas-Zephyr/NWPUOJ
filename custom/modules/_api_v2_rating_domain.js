const TypeORM = require('typeorm');
const crypto = require('crypto');
const Contest = syzoj.model('contest');
const contestRating = require('../libs/contest-rating');
const { calculatePeriod, normalizedConfig } = require('../libs/glicko2');
const { projectionDifference, rollbackIsCurrent, sameProjection } = require('../libs/rating-projection');
const { cascadeRatingPeriods } = require('../libs/rating-recalculation');
const ratingJobLifecycle = require('../libs/rating-job-lifecycle');
const ratingReversal = require('../libs/rating-reversal');
const ratingNotification = require('../libs/rating-notification');
const GLICKO2_VERSION = 1;
let schemaPromise = null;

async function ensureRatingV2Schema() {
  if (schemaPromise) return schemaPromise;
  schemaPromise = (async () => {
    const connection = TypeORM.getConnection();
    await connection.query(`CREATE TABLE IF NOT EXISTS rating_v2_profile (
      id VARCHAR(32) NOT NULL PRIMARY KEY, name VARCHAR(120) NOT NULL,
      algorithm VARCHAR(32) NOT NULL, algorithm_version INT NOT NULL,
      config_json LONGTEXT NOT NULL, enabled TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await connection.query(`CREATE TABLE IF NOT EXISTS rating_v2_preview (
      id CHAR(36) NOT NULL PRIMARY KEY, contest_id INT NOT NULL, profile_id VARCHAR(32) NOT NULL,
      status VARCHAR(24) NOT NULL DEFAULT 'pending', algorithm_version INT NOT NULL,
      input_hash CHAR(64) NOT NULL, diff_json LONGTEXT NOT NULL, created_by INT NOT NULL,
      approved_by INT NULL, created_at DATETIME(3) NOT NULL, approved_at DATETIME(3) NULL,
      UNIQUE KEY uq_rating_v2_preview_input(contest_id,profile_id,input_hash)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await connection.query(`CREATE TABLE IF NOT EXISTS rating_v2_event (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, profile_id VARCHAR(32) NOT NULL,
      user_id INT NOT NULL, contest_id INT NULL, kind VARCHAR(32) NOT NULL,
      delta INT NOT NULL DEFAULT 0, rating_before INT NULL, rating_after INT NULL,
      deviation_before DECIMAL(12,6) NULL, deviation_after DECIMAL(12,6) NULL,
      volatility_before DECIMAL(12,9) NULL, volatility_after DECIMAL(12,9) NULL,
      preview_id CHAR(36) NULL,
      reason VARCHAR(1000) NULL, source_event_id VARCHAR(120) NULL,
      created_by INT NULL, created_at DATETIME(3) NOT NULL,
      KEY idx_rating_v2_event_user(profile_id,user_id,created_at,id),
      KEY idx_rating_v2_event_contest(contest_id,id),
      UNIQUE KEY uq_rating_v2_event_source(source_event_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await connection.query(`CREATE TABLE IF NOT EXISTS rating_v2_current (
      profile_id VARCHAR(32) NOT NULL, user_id INT NOT NULL,
      rating DECIMAL(12,6) NOT NULL, deviation DECIMAL(12,6) NOT NULL,
      volatility DECIMAL(12,9) NOT NULL, last_event_id BIGINT UNSIGNED NULL,
      updated_at DATETIME(3) NOT NULL,
      PRIMARY KEY(profile_id,user_id),
      KEY idx_rating_v2_current_rank(profile_id,rating,user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await connection.query(`CREATE TABLE IF NOT EXISTS rating_v2_job (
      id CHAR(36) NOT NULL PRIMARY KEY, kind VARCHAR(32) NOT NULL,
      profile_id VARCHAR(32) NOT NULL, from_contest_id INT NULL,
      state VARCHAR(24) NOT NULL, stage VARCHAR(32) NOT NULL,
      processed INT NOT NULL DEFAULT 0, total INT NOT NULL DEFAULT 0,
      current_user_id INT NULL, cancel_requested TINYINT(1) NOT NULL DEFAULT 0,
      diff_json LONGTEXT NULL, rollback_json LONGTEXT NULL, error_json LONGTEXT NULL,
      actor_id INT NOT NULL, approved_by INT NULL, reason VARCHAR(1000) NOT NULL,
      audit_event_id BIGINT UNSIGNED NULL, created_at DATETIME(3) NOT NULL,
      updated_at DATETIME(3) NOT NULL, completed_at DATETIME(3) NULL,
      rolled_back_at DATETIME(3) NULL,
      KEY idx_rating_v2_job_state(state,updated_at),
      KEY idx_rating_v2_job_profile(profile_id,created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await connection.query(`CREATE TABLE IF NOT EXISTS rating_v2_contest_override (
      profile_id VARCHAR(32) NOT NULL,contest_id INT NOT NULL,user_id INT NOT NULL,
      status VARCHAR(32) NOT NULL,source_event_id BIGINT UNSIGNED NOT NULL,
      reason VARCHAR(1000) NOT NULL,updated_by INT NOT NULL,updated_at DATETIME(3) NOT NULL,
      PRIMARY KEY(profile_id,contest_id,user_id),KEY idx_rating_v2_override_contest(contest_id,status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    const eventColumns = {
      deviation_before: 'DECIMAL(12,6) NULL',
      deviation_after: 'DECIMAL(12,6) NULL',
      volatility_before: 'DECIMAL(12,9) NULL',
      volatility_after: 'DECIMAL(12,9) NULL',
      preview_id: 'CHAR(36) NULL',
      job_id: 'CHAR(36) NULL',
      supersedes_event_id: 'BIGINT UNSIGNED NULL'
    };
    for (const [column, definition] of Object.entries(eventColumns)) {
      const columns = await connection.query('SHOW COLUMNS FROM rating_v2_event LIKE ?', [column]);
      if (!columns.length) await connection.query(`ALTER TABLE rating_v2_event ADD COLUMN ${column} ${definition}`);
    }
    const sourceIndexes = await connection.query("SHOW INDEX FROM rating_v2_event WHERE Key_name='uq_rating_v2_event_source'");
    if (!sourceIndexes.length) await connection.query('ALTER TABLE rating_v2_event ADD UNIQUE KEY uq_rating_v2_event_source(source_event_id)');
    const jobIndexes = await connection.query("SHOW INDEX FROM rating_v2_event WHERE Key_name='idx_rating_v2_event_job'");
    if (!jobIndexes.length) await connection.query('ALTER TABLE rating_v2_event ADD KEY idx_rating_v2_event_job(job_id,id)');
    const profiles = [['icpc', 'ACM Rating'], ['ioi', 'IOI Rating'], ['practice', 'Practice Rating'], ['vjudge', 'VJudge Rating']];
    const defaultConfig = { rating: 1500, deviation: 350, volatility: 0.06, tau: 0.5, scale: 173.7178, minimum_deviation: 30, maximum_deviation: 350 };
    for (const [id, name] of profiles) await connection.query(`INSERT INTO rating_v2_profile (id,name,algorithm,algorithm_version,config_json,created_at,updated_at) VALUES (?,?,?, ?,?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE name=VALUES(name),algorithm=VALUES(algorithm),algorithm_version=VALUES(algorithm_version),config_json=VALUES(config_json),updated_at=UTC_TIMESTAMP(3)`, [id, name, 'glicko2', GLICKO2_VERSION, JSON.stringify(defaultConfig)]);
    await ratingNotification.ensureSchema(connection);
  })().catch(error => { schemaPromise = null; throw error; });
  return schemaPromise;
}
function api() { return syzoj.utils.apiV2; }
async function canRating(user, capability) { return !!(user && await syzoj.utils.authorizationV2.authorize(user, capability, null, {})); }
function inputHash(contestId, profileId, standings) { return crypto.createHash('sha256').update(JSON.stringify({ contestId, profileId, standings })).digest('hex'); }
async function profileFor(profileId) {
  const rows = await TypeORM.getConnection().query('SELECT * FROM rating_v2_profile WHERE id=? AND enabled=1 LIMIT 1', [profileId]);
  return rows[0] || null;
}
function profileConfig(profile) { return normalizedConfig(JSON.parse(profile.config_json || '{}')); }
async function ratingStandings(manager, contest, profileId) {
  const standing = await contestRating.canonicalStandings(manager, contest); if (standing.deferred || !standing.contestants.length) return standing;
  const rows = await manager.query("SELECT user_id FROM rating_v2_contest_override WHERE profile_id=? AND contest_id=? AND status IN ('cancelled','disqualified','cheating')", [profileId, contest.id]);
  if (!rows.length) return standing; const excluded = new Set(rows.map(row => Number(row.user_id)));
  const contestants = standing.contestants.filter(item => !excluded.has(Number(item.userId)));
  contestants.forEach((item, index) => { const prior = contestants[index - 1]; const tied = prior && Number(prior.score) === Number(item.score) && (contest.type !== 'acm' || Number(prior.tie || 0) === Number(item.tie || 0)); item.rank = tied ? prior.rank : index + 1; });
  return { deferred: false, contestants };
}
async function glickoInput(profile, standings) {
  const config = profileConfig(profile);
  const ids = standings.map(item => Number(item.userId));
  const rows = ids.length ? await TypeORM.getConnection().query('SELECT user_id,rating,deviation,volatility FROM rating_v2_current WHERE profile_id=? AND user_id IN (?)', [profile.id, ids]) : [];
  const states = new Map(rows.map(row => [Number(row.user_id), row]));
  return standings.map(item => {
    const state = states.get(Number(item.userId));
    return {
      userId: Number(item.userId),
      rank: Number(item.rank),
      score: Number(item.score || 0),
      rating: state ? Number(state.rating) : profile.id === 'icpc' ? Number(item.currentRating || config.initialRating) : config.initialRating,
      deviation: state ? Number(state.deviation) : config.initialDeviation,
      volatility: state ? Number(state.volatility) : config.initialVolatility
    };
  });
}
async function requireProfile(res, profileId) {
  const profile = await profileFor(profileId);
  if (!profile) api().fail(res, 422, 'RATING_PROFILE_INVALID', 'The Rating profile is invalid.', { profile_id: 'unknown or disabled profile' });
  return profile;
}

function safeJson(value, fallback) { try { return value ? JSON.parse(value) : fallback; } catch (error) { return fallback; } }
function serializeRatingJob(row) {
  const diff = safeJson(row.diff_json, null);
  return {
    id: row.id, kind: row.kind, profile_id: row.profile_id,
    from_contest_id: row.from_contest_id == null ? null : Number(row.from_contest_id),
    state: row.state, stage: row.stage,
    progress: { processed: Number(row.processed || 0), total: Number(row.total || 0), changed: diff ? Number(diff.changed_users || 0) : 0 },
    current_user_id: row.current_user_id == null ? null : Number(row.current_user_id),
    diff, error: safeJson(row.error_json, null), actor_id: Number(row.actor_id),
    approved_by: row.approved_by == null ? null : Number(row.approved_by),
    audit_event_id: row.audit_event_id == null ? null : String(row.audit_event_id),
    created_at: api().databaseIso(row.created_at), updated_at: api().databaseIso(row.updated_at),
    completed_at: api().databaseIso(row.completed_at),
    rolled_back_at: api().databaseIso(row.rolled_back_at)
  };
}

async function projectionForUser(manager, profile, userId, config, lock = false) {
  const rows = await manager.query(`SELECT rating,deviation,volatility FROM rating_v2_current WHERE profile_id=? AND user_id=?${lock ? ' FOR UPDATE' : ''}`, [profile.id, userId]);
  if (rows.length) return { rating: Math.round(Number(rows[0].rating)), deviation: Number(rows[0].deviation), volatility: Number(rows[0].volatility) };
  let rating = config.initialRating;
  if (profile.id === 'icpc') { const users = await manager.query(`SELECT rating FROM user WHERE id=?${lock ? ' FOR UPDATE' : ''}`, [userId]); if (users.length) rating = Number(users[0].rating || config.initialRating); }
  return { rating: Math.round(rating), deviation: config.initialDeviation, volatility: config.initialVolatility };
}

function standingsSnapshot(standings) {
  return standings.map(item => ({ userId: Number(item.userId), rank: Number(item.rank), score: Number(item.score || 0), tie: Number(item.tie || 0) }));
}

function standingsHash(contestId, profileId, standings) {
  return inputHash(contestId, profileId, standingsSnapshot(standings));
}

function stateFromEventBefore(row, config) {
  return {
    rating: row.rating_before == null ? config.initialRating : Math.round(Number(row.rating_before)),
    deviation: row.deviation_before == null ? config.initialDeviation : Number(row.deviation_before),
    volatility: row.volatility_before == null ? config.initialVolatility : Number(row.volatility_before)
  };
}

async function publishedContestSequence(connection, profileId, fromContestId) {
  let boundary = null;
  if (fromContestId != null) {
    const targets = await connection.query('SELECT id,end_time FROM contest WHERE id=? LIMIT 1', [fromContestId]);
    if (!targets.length) throw Object.assign(new Error('The starting contest was not found.'), { code: 'CONTEST_NOT_FOUND' });
    if (Number(targets[0].end_time || 0) > Math.floor(Date.now() / 1000)) throw Object.assign(new Error('The starting contest has not ended.'), { code: 'CONTEST_NOT_ENDED' });
    const published = await connection.query("SELECT id FROM rating_v2_event WHERE profile_id=? AND contest_id=? AND kind IN ('contest','contest_recalculated') LIMIT 1", [profileId, fromContestId]);
    if (!published.length) throw Object.assign(new Error('The starting contest has no published Rating event in this profile.'), { code: 'RATING_CONTEST_NOT_PUBLISHED' });
    boundary = targets[0];
  }
  const params = [profileId]; let clause = '';
  if (boundary) { clause = 'AND (contest.end_time>? OR (contest.end_time=? AND contest.id>=?))'; params.push(Number(boundary.end_time), Number(boundary.end_time), Number(boundary.id)); }
  return connection.query(`SELECT contest.* FROM contest INNER JOIN (
      SELECT DISTINCT contest_id FROM rating_v2_event WHERE profile_id=? AND contest_id IS NOT NULL AND kind IN ('contest','contest_recalculated')
    ) published ON published.contest_id=contest.id WHERE 1=1 ${clause} ORDER BY contest.end_time ASC,contest.id ASC`, params);
}

async function ratingJobWasCancelled(connection, jobId) {
  const controls = await connection.query('SELECT cancel_requested,state FROM rating_v2_job WHERE id=? LIMIT 1', [jobId]);
  if (controls.length && !controls[0].cancel_requested && controls[0].state !== 'cancelling') return false;
  if (controls.length) await connection.query("UPDATE rating_v2_job SET state='cancelled',stage='cancelled',current_user_id=NULL,updated_at=UTC_TIMESTAMP(3) WHERE id=?", [jobId]);
  return true;
}

async function buildRatingJobPreview(job) {
  const connection = TypeORM.getConnection(); const profile = await profileFor(job.profile_id);
  if (!profile) throw Object.assign(new Error('Rating profile is unavailable.'), { code: 'RATING_PROFILE_INVALID' });
  const config = profileConfig(profile); const watermarkRows = await connection.query('SELECT COALESCE(MAX(id),0) AS id FROM rating_v2_event WHERE profile_id=?', [profile.id]);
  const eventWatermark = Number(watermarkRows[0].id || 0); const contests = await publishedContestSequence(connection, profile.id, job.from_contest_id == null ? null : Number(job.from_contest_id));
  const contestIds = contests.map(contest => Number(contest.id));
  await connection.query("UPDATE rating_v2_job SET stage='previewing',processed=0,total=?,updated_at=UTC_TIMESTAMP(3) WHERE id=?", [contests.length, job.id]);
  if (!contests.length) {
    const diff = { version: 2, profile_id: profile.id, from_contest_id: null, event_watermark: String(eventWatermark), inspected_users: 0, changed_users: 0, contests: [], contest_events: [], items: [] };
    await connection.query("UPDATE rating_v2_job SET state='paused',stage='awaiting_approval',processed=0,total=0,current_user_id=NULL,diff_json=?,error_json=NULL,updated_at=UTC_TIMESTAMP(3) WHERE id=?", [JSON.stringify(diff), job.id]);
    await api().appendEvent({ stream: `rating-job:${job.id}`, type: 'rating.recalculation.preview.ready', aggregateId: job.id, payload: { changed_users: 0, inspected_users: 0, contests: 0 } }); return;
  }
  const eventRows = await connection.query(`SELECT * FROM rating_v2_event WHERE profile_id=? AND id<=? AND contest_id IN (?) AND kind IN ('contest','contest_recalculated') ORDER BY id ASC`, [profile.id, eventWatermark, contestIds]);
  const contestIndex = new Map(contestIds.map((id, index) => [id, index])); const latestByContestUser = new Map();
  eventRows.forEach(row => latestByContestUser.set(`${Number(row.contest_id)}:${Number(row.user_id)}`, row));
  const earliestByUser = new Map(); const latestSourceByUser = new Map();
  for (const row of latestByContestUser.values()) {
    const userId = Number(row.user_id); const index = contestIndex.get(Number(row.contest_id)); const earliest = earliestByUser.get(userId);
    if (!earliest || index < earliest.index) earliestByUser.set(userId, { index, row });
    if (!latestSourceByUser.has(userId) || Number(row.id) > latestSourceByUser.get(userId)) latestSourceByUser.set(userId, Number(row.id));
  }
  const baselines = new Map(); earliestByUser.forEach(({ row }, userId) => baselines.set(userId, stateFromEventBefore(row, config)));
  const periodInputs = []; const contestSummaries = [];
  for (let index = 0; index < contests.length; index += 1) {
    if (await ratingJobWasCancelled(connection, job.id)) return;
    const contest = contests[index]; const standing = await ratingStandings(connection.manager, contest, profile.id);
    if (standing.deferred) throw Object.assign(new Error(`Contest #${contest.id} still has pending submissions.`), { code: 'RATING_INPUT_PENDING' });
    const snapshot = standingsSnapshot(standing.contestants); periodInputs.push({ contestId: Number(contest.id), standings: snapshot });
    contestSummaries.push({ contest_id: Number(contest.id), title: contest.title || '', ended_at: contest.end_time == null ? null : new Date(Number(contest.end_time) * 1000).toISOString(), standings_hash: standingsHash(contest.id, profile.id, standing.contestants), participants: snapshot.length });
    await connection.query('UPDATE rating_v2_job SET processed=?,current_user_id=NULL,updated_at=UTC_TIMESTAMP(3) WHERE id=?', [index + 1, job.id]);
  }
  const recalculation = cascadeRatingPeriods(periodInputs, baselines, config); const items = [];
  for (const [userId, after] of recalculation.finalStates.entries()) {
    const before = await projectionForUser(connection, profile, userId, config);
    const difference = projectionDifference({ userId, sourceEventId: latestSourceByUser.get(userId) || `boundary:${contestIds[0]}`, before, after }); if (difference) items.push(difference);
  }
  const contestEvents = []; const recalculatedContestUsers = new Set();
  recalculation.periods.forEach(period => period.changes.forEach(change => {
    const key = `${period.contestId}:${change.userId}`; const source = latestByContestUser.get(key); recalculatedContestUsers.add(key);
    const previousRatingBefore = source && source.rating_before != null ? Math.round(Number(source.rating_before)) : null;
    const previousRatingAfter = source && source.rating_after != null ? Math.round(Number(source.rating_after)) : null;
    const notificationChanged = !source || previousRatingBefore !== Math.round(Number(change.ratingBefore)) || previousRatingAfter !== Math.round(Number(change.ratingAfter));
    contestEvents.push({ contest_id: period.contestId, user_id: change.userId, rank: change.rank, score: Number(change.score || 0), rating_before: change.ratingBefore, rating_after: change.ratingAfter, deviation_before: change.deviationBefore, deviation_after: change.deviationAfter, volatility_before: change.volatilityBefore, volatility_after: change.volatilityAfter, delta: change.delta, supersedes_event_id: source ? String(source.id) : null, previous_rating_before: previousRatingBefore, previous_rating_after: previousRatingAfter, notification_changed: notificationChanged });
  }));
  const removedContestEvents = [];
  for (const [key, source] of latestByContestUser.entries()) {
    if (!recalculatedContestUsers.has(key)) removedContestEvents.push({ contest_id: Number(source.contest_id), user_id: Number(source.user_id), supersedes_event_id: String(source.id) });
  }
  const endingWatermark = await connection.query('SELECT COALESCE(MAX(id),0) AS id FROM rating_v2_event WHERE profile_id=?', [profile.id]);
  if (Number(endingWatermark[0].id || 0) !== eventWatermark) throw Object.assign(new Error('Rating events changed while the preview was being built.'), { code: 'RATING_JOB_STALE' });
  const diff = { version: 2, profile_id: profile.id, from_contest_id: contestIds[0], event_watermark: String(eventWatermark), inspected_users: recalculation.finalStates.size, changed_users: items.length, contests: contestSummaries, contest_events: contestEvents, removed_contest_events: removedContestEvents, items };
  await connection.query("UPDATE rating_v2_job SET state='paused',stage='awaiting_approval',processed=total,current_user_id=NULL,diff_json=?,error_json=NULL,updated_at=UTC_TIMESTAMP(3) WHERE id=?", [JSON.stringify(diff), job.id]);
  await api().appendEvent({ stream: `rating-job:${job.id}`, type: 'rating.recalculation.preview.ready', aggregateId: job.id, payload: { changed_users: items.length, inspected_users: recalculation.finalStates.size, contests: contests.length } });
}

async function applyRatingJob(job) {
  const changedUsers = await TypeORM.getConnection().transaction(async manager => {
    const rows = await manager.query('SELECT * FROM rating_v2_job WHERE id=? FOR UPDATE', [job.id]); const currentJob = rows[0];
    if (!currentJob || currentJob.cancel_requested) { if (currentJob) await manager.query("UPDATE rating_v2_job SET state='cancelled',stage='cancelled',updated_at=UTC_TIMESTAMP(3) WHERE id=?", [job.id]); return []; }
    const profileRows = await manager.query('SELECT * FROM rating_v2_profile WHERE id=? AND enabled=1 LIMIT 1', [currentJob.profile_id]); if (!profileRows.length) throw Object.assign(new Error('Rating profile is unavailable.'), { code: 'RATING_PROFILE_INVALID' });
    const profile = profileRows[0]; const config = profileConfig(profile); const diff = safeJson(currentJob.diff_json, { items: [], contests: [], contest_events: [], removed_contest_events: [] }); const rollback = []; const notificationRollback = [];
    if (Number(diff.version || 0) !== 2) throw Object.assign(new Error('This preview uses an obsolete recalculation format. Create a new preview.'), { code: 'RATING_JOB_PREVIEW_OBSOLETE' });
    const watermarkRows = await manager.query('SELECT COALESCE(MAX(id),0) AS id FROM rating_v2_event WHERE profile_id=?', [profile.id]);
    if (String(watermarkRows[0].id || 0) !== String(diff.event_watermark || 0)) throw Object.assign(new Error('Rating events changed after this preview. Create a new preview.'), { code: 'RATING_JOB_STALE' });
    for (const expected of diff.contests || []) {
      const contests = await manager.query('SELECT * FROM contest WHERE id=? FOR UPDATE', [expected.contest_id]);
      if (!contests.length) throw Object.assign(new Error(`Contest #${expected.contest_id} no longer exists.`), { code: 'RATING_JOB_STALE' });
      const standing = await ratingStandings(manager, contests[0], profile.id);
      if (standing.deferred) throw Object.assign(new Error(`Contest #${expected.contest_id} still has pending submissions.`), { code: 'RATING_INPUT_PENDING' });
      if (standingsHash(expected.contest_id, profile.id, standing.contestants) !== expected.standings_hash) throw Object.assign(new Error(`Contest #${expected.contest_id} standings changed after this preview.`), { code: 'RATING_JOB_STALE' });
    }
    const lockedProjection = new Map();
    for (let index = 0; index < diff.items.length; index += 1) {
      const item = diff.items[index]; const before = await projectionForUser(manager, profile, item.user_id, config, true);
      if (!sameProjection(before, item.before)) throw Object.assign(new Error(`Rating projection changed for user #${item.user_id}. Create a new preview.`), { code: 'RATING_JOB_STALE' });
      lockedProjection.set(Number(item.user_id), before);
    }
    const contestSummaries = new Map((diff.contests || []).map(item => [Number(item.contest_id), item]));
    const lastAppliedEvent = new Map(); const notificationNow = Math.floor(Date.now() / 1000);
    for (const event of diff.contest_events || []) {
      const source = `rating-job:${job.id}:contest:${event.contest_id}:user:${event.user_id}`;
      const inserted = await manager.query(`INSERT INTO rating_v2_event (profile_id,user_id,contest_id,kind,delta,rating_before,rating_after,deviation_before,deviation_after,volatility_before,volatility_after,preview_id,reason,source_event_id,job_id,supersedes_event_id,created_by,created_at)
        VALUES (?,?,?,'contest_recalculated',?,?,?,?,?,?,?,NULL,?,?,?,?,?,UTC_TIMESTAMP(3))`, [profile.id, event.user_id, event.contest_id, event.delta, event.rating_before, event.rating_after, event.deviation_before, event.deviation_after, event.volatility_before, event.volatility_after, currentJob.reason, source, job.id, event.supersedes_event_id == null ? null : Number(event.supersedes_event_id), currentJob.approved_by]);
      const eventId = Number(inserted.insertId); lastAppliedEvent.set(Number(event.user_id), eventId);
      if (event.notification_changed === true) {
        let notificationResult;
        if (Math.round(Number(event.rating_before)) === Math.round(Number(event.rating_after))) {
          notificationResult = await ratingNotification.removeRatingChangeNotification(manager, {
            profileId: profile.id,
            contestId: event.contest_id,
            userId: event.user_id
          });
        } else {
          const contestSummary = contestSummaries.get(Number(event.contest_id)) || {};
          notificationResult = await ratingNotification.upsertRatingChangeNotification(manager, {
            profileId: profile.id,
            profileName: profile.name,
            contestId: event.contest_id,
            userId: event.user_id,
            contestTitle: contestSummary.title,
            rank: event.rank,
            participantCount: contestSummary.participants,
            ratingBefore: event.rating_before,
            ratingAfter: event.rating_after,
            sourceKey: `rating-event:${eventId}`,
            kind: 'recalculated',
            jobId: job.id,
            now: notificationNow
          });
        }
        if (notificationResult && !notificationResult.deduplicated && (notificationResult.created || notificationResult.removed)) {
          notificationRollback.push({ profile_id: profile.id, contest_id: Number(event.contest_id), user_id: Number(event.user_id), previous: notificationResult.previous });
        } else if (notificationResult && !notificationResult.deduplicated && notificationResult.notificationId != null) {
          notificationRollback.push({ profile_id: profile.id, contest_id: Number(event.contest_id), user_id: Number(event.user_id), previous: notificationResult.previous });
        }
      }
    }
    for (const removed of diff.removed_contest_events || []) {
      const notificationResult = await ratingNotification.removeRatingChangeNotification(manager, {
        profileId: profile.id,
        contestId: removed.contest_id,
        userId: removed.user_id
      });
      if (notificationResult.removed) notificationRollback.push({ profile_id: profile.id, contest_id: Number(removed.contest_id), user_id: Number(removed.user_id), previous: notificationResult.previous });
    }
    for (let index = 0; index < diff.items.length; index += 1) {
      const item = diff.items[index]; const before = lockedProjection.get(Number(item.user_id)); let eventId = lastAppliedEvent.get(Number(item.user_id));
      if (!eventId) {
        const source = `rating-job:${job.id}:reverse:${item.user_id}`; const supersedes = /^\d+$/.test(String(item.source_event_id || '')) ? Number(item.source_event_id) : null;
        const inserted = await manager.query(`INSERT INTO rating_v2_event (profile_id,user_id,contest_id,kind,delta,rating_before,rating_after,deviation_before,deviation_after,volatility_before,volatility_after,preview_id,reason,source_event_id,job_id,supersedes_event_id,created_by,created_at)
          VALUES (?,?,?,'recalculation_reverse',?,?,?,?,?,?,?,NULL,?,?,?,?,?,UTC_TIMESTAMP(3))`, [profile.id, item.user_id, diff.from_contest_id, item.after.rating - before.rating, before.rating, item.after.rating, before.deviation, item.after.deviation, before.volatility, item.after.volatility, currentJob.reason, source, job.id, supersedes, currentJob.approved_by]);
        eventId = Number(inserted.insertId);
      }
      await manager.query(`INSERT INTO rating_v2_current (profile_id,user_id,rating,deviation,volatility,last_event_id,updated_at) VALUES (?,?,?,?,?,?,UTC_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE rating=VALUES(rating),deviation=VALUES(deviation),volatility=VALUES(volatility),last_event_id=VALUES(last_event_id),updated_at=VALUES(updated_at)`, [profile.id, item.user_id, item.after.rating, item.after.deviation, item.after.volatility, eventId]);
      if (profile.id === 'icpc') await manager.query('UPDATE user SET rating=? WHERE id=?', [item.after.rating, item.user_id]);
      rollback.push({ user_id: item.user_id, before, after: item.after, apply_event_id: String(eventId) });
      await manager.query('UPDATE rating_v2_job SET processed=?,current_user_id=?,updated_at=UTC_TIMESTAMP(3) WHERE id=?', [index + 1, item.user_id, job.id]);
    }
    await manager.query("UPDATE rating_v2_job SET state='completed',stage='completed',processed=total,current_user_id=NULL,rollback_json=?,completed_at=UTC_TIMESTAMP(3),updated_at=UTC_TIMESTAMP(3) WHERE id=?", [JSON.stringify({ version: 2, projections: rollback, notifications: notificationRollback }), job.id]);
    return rollback.map(item => item.user_id);
  });
  changedUsers.forEach(userId => syzoj.model('user').deleteFromCache(userId));
  await api().appendEvent({ stream: `rating-job:${job.id}`, type: 'rating.recalculation.completed', aggregateId: job.id, payload: { changed_users: changedUsers.length } });
}

async function runRatingJob(jobId) {
  const connection = TypeORM.getConnection();
  try {
    const claimed = await connection.query("UPDATE rating_v2_job SET state='running',updated_at=UTC_TIMESTAMP(3) WHERE id=? AND state='queued'", [jobId]); if (!claimed.affectedRows) return;
    const rows = await connection.query('SELECT * FROM rating_v2_job WHERE id=? LIMIT 1', [jobId]); const job = rows[0];
    if (ratingJobLifecycle.shouldApply(job)) await applyRatingJob(job); else await buildRatingJobPreview(job);
  } catch (error) {
    await connection.query("UPDATE rating_v2_job SET state='failed',stage='failed',current_user_id=NULL,error_json=?,updated_at=UTC_TIMESTAMP(3) WHERE id=?", [JSON.stringify({ code: error.code || 'RATING_RECALCULATION_FAILED', message: String(error.message || error).slice(0, 500) }), jobId]).catch(() => {});
    await api().appendEvent({ stream: `rating-job:${jobId}`, type: 'rating.recalculation.failed', aggregateId: jobId, payload: { code: error.code || 'RATING_RECALCULATION_FAILED' } }).catch(() => {});
  }
}

app.get(['/api/v2/ratings/profiles', '/api/v2/rating/profiles'], async (req, res) => { await ensureRatingV2Schema(); const rows = await TypeORM.getConnection().query('SELECT id,name,algorithm,algorithm_version,config_json,enabled FROM rating_v2_profile WHERE enabled=1 ORDER BY id'); return api().send(res, rows.map(row => ({ id: row.id, name: row.name, algorithm: row.algorithm, algorithm_version: Number(row.algorithm_version), config: JSON.parse(row.config_json || '{}') }))); });
app.get(['/api/v2/ratings/leaderboard', '/api/v2/rating/leaderboard'], async (req, res) => {
  await ensureRatingV2Schema(); const profileId = String(req.query.profile || 'icpc'); const limit = api().parseLimit(req, 50, 100); const cursor = api().decodeCursor(req.query.cursor); const profile = await requireProfile(res, profileId); if (!profile) return;
  const cursorRating = cursor && Number(cursor.rating); const cursorUser = cursor && Number(cursor.user_id);
  const rows = profileId === 'icpc'
    ? await TypeORM.getConnection().query(`SELECT user.id AS user_id,user.username,COALESCE(projection.rating,user.rating) AS rating,projection.deviation,projection.volatility
      FROM user LEFT JOIN rating_v2_current projection ON projection.user_id=user.id AND projection.profile_id='icpc'
      WHERE (? IS NULL OR COALESCE(projection.rating,user.rating)<? OR (COALESCE(projection.rating,user.rating)=? AND user.id>?))
      ORDER BY COALESCE(projection.rating,user.rating) DESC,user.id ASC LIMIT ?`, [cursorRating || null, cursorRating || null, cursorRating || null, cursorUser || 0, limit + 1])
    : await TypeORM.getConnection().query(`SELECT projection.user_id,user.username,projection.rating,projection.deviation,projection.volatility
      FROM rating_v2_current projection INNER JOIN user ON user.id=projection.user_id
      WHERE projection.profile_id=? AND (? IS NULL OR projection.rating<? OR (projection.rating=? AND projection.user_id>?))
      ORDER BY projection.rating DESC,projection.user_id ASC LIMIT ?`, [profileId, cursorRating || null, cursorRating || null, cursorRating || null, cursorUser || 0, limit + 1]);
  const more = rows.length > limit; const page = rows.slice(0, limit); res.locals.apiMeta.limit = limit; res.locals.apiMeta.next_cursor = more ? api().encodeCursor({ rating: Number(page[page.length - 1].rating), user_id: Number(page[page.length - 1].user_id) }) : null;
  return api().send(res, page.map((row, index) => ({ rank: index + 1, user_id: Number(row.user_id), username: row.username, rating: Math.round(Number(row.rating || 1500)), deviation: row.deviation == null ? null : Number(row.deviation), volatility: row.volatility == null ? null : Number(row.volatility), profile: profileId })));
});
app.get(['/api/v2/ratings/users/:id/history', '/api/v2/users/:id/rating-history'], async (req, res) => {
  await ensureRatingV2Schema(); const profileId = String(req.query.profile || 'icpc'); const profile = await requireProfile(res, profileId); if (!profile) return;
  const limit = api().parseLimit(req, 50, 100); const cursor = api().decodeCursor(req.query.cursor) || {}; const beforeId = Number(cursor.id || 0); const userId = Number(req.params.id); const connection = TypeORM.getConnection();
  const existing = await connection.query('SELECT id FROM rating_v2_event WHERE profile_id=? AND user_id=? LIMIT 1', [profileId, userId]);
  if (!existing.length && profileId === 'icpc') {
    const rows = await connection.query(`SELECT history.rating_calculation_id AS id,history.user_id,history.rating_after,history.rank,calculation.contest_id,contest.title,contest.end_time
      FROM rating_history history INNER JOIN rating_calculation calculation ON calculation.id=history.rating_calculation_id
      LEFT JOIN contest ON contest.id=calculation.contest_id WHERE history.user_id=? AND history.rating_calculation_id>? ORDER BY history.rating_calculation_id ASC LIMIT ?`, [userId, beforeId, limit + 1]);
    const more = rows.length > limit; const page = rows.slice(0, limit); res.locals.apiMeta.limit = limit; res.locals.apiMeta.next_cursor = more ? api().encodeCursor({ source: 'legacy', id: Number(page[page.length - 1].id) }) : null;
    return api().send(res, page.map(row => ({ event_id: `legacy:${row.id}`, user_id: Number(row.user_id), profile: profileId, kind: 'legacy_contest', contest_id: row.contest_id == null ? null : Number(row.contest_id), contest_title: row.title || null, rating_before: null, rating: Number(row.rating_after), delta: null, deviation: null, volatility: null, rank: Number(row.rank), reason: null, occurred_at: row.end_time ? new Date(Number(row.end_time) * 1000).toISOString() : null })));
  }
  const rows = existing.length ? await connection.query(`SELECT event.id,event.user_id,event.contest_id,event.kind,event.delta,event.rating_before,event.rating_after,event.deviation_after,event.volatility_after,event.reason,event.job_id,event.supersedes_event_id,event.created_at,contest.title
    FROM rating_v2_event event LEFT JOIN contest ON contest.id=event.contest_id
    WHERE event.profile_id=? AND event.user_id=? AND event.id>? ORDER BY event.id ASC LIMIT ?`, [profileId, userId, beforeId, limit + 1]) : [];
  const more = rows.length > limit; const page = rows.slice(0, limit); res.locals.apiMeta.limit = limit; res.locals.apiMeta.next_cursor = more ? api().encodeCursor({ source: 'v2', id: Number(page[page.length - 1].id) }) : null;
  return api().send(res, page.map(row => ({ event_id: String(row.id), user_id: Number(row.user_id), profile: profileId, kind: row.kind, contest_id: row.contest_id == null ? null : Number(row.contest_id), contest_title: row.title || null, rating_before: row.rating_before == null ? null : Number(row.rating_before), rating: Number(row.rating_after), delta: Number(row.delta), deviation: row.deviation_after == null ? null : Number(row.deviation_after), volatility: row.volatility_after == null ? null : Number(row.volatility_after), reason: row.reason, job_id: row.job_id || null, supersedes_event_id: row.supersedes_event_id == null ? null : String(row.supersedes_event_id), occurred_at: api().databaseIso(row.created_at) })));
});

app.get(['/api/v2/contests/:id/rating-preview', '/api/v2/contests/:id/rating/preview'], async (req, res) => { await ensureRatingV2Schema(); if (!res.locals.user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.'); if (!await canRating(res.locals.user, 'rating:read')) return api().fail(res, 403, 'CAPABILITY_REQUIRED', 'Capability required: rating:read.'); const previewId = String(req.query.preview_id || ''); const rows = previewId ? await TypeORM.getConnection().query('SELECT * FROM rating_v2_preview WHERE id=? AND contest_id=? LIMIT 1', [previewId, Number(req.params.id)]) : []; if (!rows.length) return api().fail(res, 404, 'RATING_PREVIEW_NOT_FOUND', 'Rating preview was not found.'); const row = rows[0]; return api().send(res, { id: row.id, contest_id: Number(row.contest_id), profile_id: row.profile_id, status: row.status, algorithm_version: Number(row.algorithm_version), diff: JSON.parse(row.diff_json || '{}'), created_at: api().databaseIso(row.created_at) }); });

app.post(['/api/v2/contests/:id/rating-preview', '/api/v2/contests/:id/rating/preview'], async (req, res) => {
  const user = res.locals.user; if (!user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.'); if (!await canRating(user, 'rating:preview')) return api().fail(res, 403, 'CAPABILITY_REQUIRED', 'Capability required: rating:preview.');
  const contestId = Number(req.params.id); const contest = await Contest.findById(contestId); if (!contest) return api().fail(res, 404, 'CONTEST_NOT_FOUND', 'Contest was not found.'); if (Number(contest.end_time) > Math.floor(Date.now() / 1000)) return api().fail(res, 409, 'CONTEST_NOT_ENDED', 'Rating can be previewed after the contest ends.'); const profileId = String(req.body && req.body.profile_id || 'icpc'); await ensureRatingV2Schema(); const profile = await requireProfile(res, profileId); if (!profile) return;
  const finalized = profileId === 'icpc' ? await TypeORM.getConnection().query("SELECT status FROM contest_rating_finalization WHERE contest_id=? AND status='completed' LIMIT 1", [contestId]) : []; if (finalized.length) return api().fail(res, 409, 'RATING_ALREADY_PUBLISHED', 'Rating for this contest was already published.');
  const manager = TypeORM.getConnection().manager; const standing = await ratingStandings(manager, contest, profile.id); if (standing.deferred) return api().fail(res, 409, 'RATING_INPUT_PENDING', 'Submissions are still pending.'); if (standing.contestants.length < 2) return api().fail(res, 409, 'RATING_NOT_ENOUGH_PARTICIPANTS', 'At least two eligible participants are required.');
  const input = await glickoInput(profile, standing.contestants); const changes = calculatePeriod(input, profileConfig(profile)); const diff = { profile_id: profileId, algorithm: 'glicko2', algorithm_version: GLICKO2_VERSION, config: JSON.parse(profile.config_json || '{}'), standings_hash: standingsHash(contestId, profileId, standing.contestants), contestants: changes }; const hash = inputHash(contestId, profileId, input); const id = crypto.randomUUID();
  await TypeORM.getConnection().query('INSERT INTO rating_v2_preview (id,contest_id,profile_id,status,algorithm_version,input_hash,diff_json,created_by,created_at) VALUES (?,?,?,\'pending\',?,?,?, ?,UTC_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE id=id', [id, contestId, profileId, GLICKO2_VERSION, hash, JSON.stringify(diff), user.id]);
  const rows = await TypeORM.getConnection().query('SELECT * FROM rating_v2_preview WHERE contest_id=? AND profile_id=? AND input_hash=? LIMIT 1', [contestId, profileId, hash]); const preview = rows[0]; const auditEventId = await syzoj.utils.authorizationV2.recordAudit(req, { action: 'rating:preview', resourceType: 'contest', resourceId: contestId, reason: syzoj.utils.operationReason(req, '生成 Rating 预览'), details: { preview_id: preview.id } }); return api().send(res, { id: preview.id, contest_id: contestId, profile_id: profileId, status: preview.status, algorithm_version: GLICKO2_VERSION, diff, audit_event_id: auditEventId }, 201);
});

app.post(['/api/v2/contests/:id/rating-publish', '/api/v2/contests/:id/rating/publish'], async (req, res) => {
  const user = res.locals.user; if (!user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.'); if (!await canRating(user, 'rating:publish')) return api().fail(res, 403, 'CAPABILITY_REQUIRED', 'Capability required: rating:publish.'); if (!syzoj.utils.authorizationV2.recentLoginSatisfied(req)) return api().fail(res, 403, 'RECENT_LOGIN_REQUIRED', 'Please sign in again before publishing Rating.');
  const contestId = Number(req.params.id); const previewId = String(req.body && req.body.preview_id || ''); const reason = syzoj.utils.operationReason(req, '发布 Rating'); await ensureRatingV2Schema();
  try {
    const result = await TypeORM.getConnection().transaction(async manager => {
      const rows = await manager.query('SELECT * FROM rating_v2_preview WHERE id=? AND contest_id=? FOR UPDATE', [previewId, contestId]); if (!rows.length) { const error = new Error('Rating preview was not found.'); error.code = 'RATING_PREVIEW_NOT_FOUND'; error.statusCode = 404; throw error; }
      const preview = rows[0]; if (preview.status === 'published') return { status: 'published', event_ids: [] }; if (preview.status !== 'pending') { const error = new Error('Rating preview is not publishable.'); error.code = 'RATING_PREVIEW_INVALID'; error.statusCode = 409; throw error; }
      const finalizations = preview.profile_id === 'icpc' ? await manager.query('SELECT status FROM contest_rating_finalization WHERE contest_id=? FOR UPDATE', [contestId]) : []; if (finalizations.length) { const error = new Error('Rating for this contest was already finalized.'); error.code = 'RATING_ALREADY_PUBLISHED'; error.statusCode = 409; throw error; }
      const diff = JSON.parse(preview.diff_json || '{}'); const contestants = Array.isArray(diff.contestants) ? diff.contestants : []; if (contestants.length < 2 || !diff.standings_hash) { const error = new Error('Rating preview has no publishable contestants or uses an obsolete format.'); error.code = 'RATING_PREVIEW_INVALID'; error.statusCode = 409; throw error; }
      const contestRows = await manager.query('SELECT * FROM contest WHERE id=? FOR UPDATE', [contestId]); if (!contestRows.length) { const error = new Error('Contest was not found.'); error.code = 'CONTEST_NOT_FOUND'; error.statusCode = 404; throw error; }
      const currentStanding = await ratingStandings(manager, contestRows[0], preview.profile_id); if (currentStanding.deferred) { const error = new Error('Submissions are still pending.'); error.code = 'RATING_INPUT_PENDING'; error.statusCode = 409; throw error; }
      if (standingsHash(contestId, preview.profile_id, currentStanding.contestants) !== diff.standings_hash) { const error = new Error('Contest standings changed after this preview. Create a new preview.'); error.code = 'RATING_PREVIEW_STALE'; error.statusCode = 409; throw error; }
      const calculation = preview.profile_id === 'icpc' ? await manager.query('INSERT INTO rating_calculation (contest_id) VALUES (?)', [contestId]) : null; const calculationId = calculation ? Number(calculation.insertId) : null; const eventIds = []; const notificationIds = []; const notificationNow = Math.floor(Date.now() / 1000);
      for (const contestant of contestants) {
        const currentRows = await manager.query('SELECT rating,deviation,volatility FROM rating_v2_current WHERE profile_id=? AND user_id=? FOR UPDATE', [preview.profile_id, contestant.userId]);
        let current = currentRows[0]; if (!current && preview.profile_id === 'icpc') { const users = await manager.query('SELECT rating FROM user WHERE id=? FOR UPDATE', [contestant.userId]); current = users.length ? { rating: users[0].rating, deviation: contestant.deviationBefore, volatility: contestant.volatilityBefore } : null; }
        const currentRating = current ? Math.round(Number(current.rating)) : Math.round(Number(contestant.ratingBefore)); const currentDeviation = current ? Number(current.deviation) : Number(contestant.deviationBefore); const currentVolatility = current ? Number(current.volatility) : Number(contestant.volatilityBefore);
        if (currentRating !== Math.round(Number(contestant.ratingBefore)) || Math.abs(currentDeviation - Number(contestant.deviationBefore)) > 0.000001 || Math.abs(currentVolatility - Number(contestant.volatilityBefore)) > 0.000000001) { const error = new Error('Rating changed after this preview. Create a new preview.'); error.code = 'RATING_PREVIEW_STALE'; error.statusCode = 409; throw error; }
        const source = `preview:${previewId}:user:${contestant.userId}`; const inserted = await manager.query(`INSERT INTO rating_v2_event (profile_id,user_id,contest_id,kind,delta,rating_before,rating_after,deviation_before,deviation_after,volatility_before,volatility_after,preview_id,reason,source_event_id,created_by,created_at)
          VALUES (?,?,?,'contest',?,?,?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP(3))`, [preview.profile_id, contestant.userId, contestId, contestant.delta, contestant.ratingBefore, contestant.ratingAfter, contestant.deviationBefore, contestant.deviationAfter, contestant.volatilityBefore, contestant.volatilityAfter, previewId, reason, source, user.id]);
        const eventId = Number(inserted.insertId); eventIds.push(String(eventId));
        await manager.query(`INSERT INTO rating_v2_current (profile_id,user_id,rating,deviation,volatility,last_event_id,updated_at) VALUES (?,?,?,?,?,?,UTC_TIMESTAMP(3))
          ON DUPLICATE KEY UPDATE rating=VALUES(rating),deviation=VALUES(deviation),volatility=VALUES(volatility),last_event_id=VALUES(last_event_id),updated_at=VALUES(updated_at)`, [preview.profile_id, contestant.userId, contestant.ratingAfter, contestant.deviationAfter, contestant.volatilityAfter, eventId]);
        if (preview.profile_id === 'icpc') { await manager.query('UPDATE user SET rating=? WHERE id=?', [contestant.ratingAfter, contestant.userId]); await manager.query('INSERT INTO rating_history (rating_calculation_id,user_id,rating_after,rank) VALUES (?,?,?,?)', [calculationId, contestant.userId, contestant.ratingAfter, contestant.rank]); }
        if (Math.round(Number(contestant.ratingBefore)) !== Math.round(Number(contestant.ratingAfter))) {
          const notification = await ratingNotification.upsertRatingChangeNotification(manager, {
            profileId: preview.profile_id,
            userId: contestant.userId,
            contestId,
            contestTitle: contestRows[0].title,
            rank: contestant.rank,
            participantCount: contestants.length,
            ratingBefore: contestant.ratingBefore,
            ratingAfter: contestant.ratingAfter,
            sourceKey: `rating-event:${eventId}`,
            kind: 'published',
            now: notificationNow
          });
          notificationIds.push(String(notification.notificationId));
        }
      }
      if (preview.profile_id === 'icpc') await manager.query(`INSERT INTO contest_rating_finalization (contest_id,rating_calculation_id,status,participant_count,algorithm_version,completed_at,skip_reason) VALUES (?,?,'completed',?,?,UNIX_TIMESTAMP(),NULL)`, [contestId, calculationId, contestants.length, GLICKO2_VERSION]);
      await manager.query("UPDATE rating_v2_preview SET status='published',approved_by=?,approved_at=UTC_TIMESTAMP(3) WHERE id=?", [user.id, previewId]);
      return { status: 'published', event_ids: eventIds, notification_ids: notificationIds, participant_count: contestants.length, user_ids: contestants.map(item => Number(item.userId)) };
    });
    (result.user_ids || []).forEach(userId => syzoj.model('user').deleteFromCache(userId)); delete result.user_ids;
    const auditEventId = await syzoj.utils.authorizationV2.recordAudit(req, { action: 'rating:publish', resourceType: 'contest', resourceId: contestId, reason, details: { preview_id: previewId, participant_count: result.participant_count || 0, event_ids: result.event_ids } }); await syzoj.utils.apiV2.appendEvent({ stream: `rating:${contestId}`, type: 'rating.published', aggregateId: contestId, actor: user, payload: { contest_id: contestId, preview_id: previewId, audit_event_id: auditEventId } }); return api().send(res, { contest_id: contestId, preview_id: previewId, ...result, audit_event_id: auditEventId });
  } catch (error) { return api().fail(res, error.statusCode || 409, error.code || 'RATING_PUBLISH_FAILED', error.message); }
});

async function reverseRatingEvent(req, res, user) {
  const reversalTypes = ratingReversal.REVERSAL_TYPES;
  const originalId = Number(req.body && req.body.reverses_event_id); const reversalType = String(req.body && req.body.reversal_type || 'correction'); const reason = syzoj.utils.operationReason(req, '撤销 Rating 事件');
  if (!Number.isSafeInteger(originalId) || originalId < 1 || !reversalTypes[reversalType]) return api().fail(res, 422, 'VALIDATION_FAILED', 'A valid source event and reversal type are required.', { reverses_event_id: 'positive integer', reversal_type: 'cancellation, disqualification, cheating, or correction' });
  const eligibility = req.body && req.body.eligibility == null ? null : String(req.body.eligibility); if (eligibility && !['eligible', 'excluded'].includes(eligibility)) return api().fail(res, 422, 'VALIDATION_FAILED', 'Eligibility must be eligible or excluded.', { eligibility: 'invalid' });
  await ensureRatingV2Schema(); const jobId = crypto.randomUUID();
  try {
    const transactionResult = await TypeORM.getConnection().transaction(manager => ratingReversal.reverseInTransaction(manager, {
      originalId,
      reversalType,
      eligibility,
      requestedUserId: req.params.id || null,
      requestedProfileId: req.body && req.body.profile_id,
      actorId: user.id,
      reason,
      jobId,
      currentProjection: async (manager, profile, userId) => projectionForUser(manager, profile, userId, profileConfig(profile), true),
      recordAudit: (details, manager) => syzoj.utils.authorizationV2.recordAudit(req, {
        action: `rating:reverse.${reversalType}`,
        resourceType: 'rating_event',
        resourceId: details.event_id,
        reason,
        details
      }, manager)
    }));
    const { domain_event: domainEvent, ...result } = transactionResult;
    syzoj.model('user').deleteFromCache(result.user_id);
    api().publishEvent(domainEvent);
    if (result.job_id) setImmediate(() => runRatingJob(result.job_id));
    return api().send(res, result, result.job_id ? 202 : 201);
  } catch (error) { return api().fail(res, error.statusCode || 409, error.code || 'RATING_REVERSAL_FAILED', error.message); }
}

app.get('/api/v2/contests/:id/rating/overrides', async (req, res) => {
  if (!res.locals.user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.'); if (!await canRating(res.locals.user, 'rating:read')) return api().fail(res, 403, 'CAPABILITY_REQUIRED', 'Capability required: rating:read.'); await ensureRatingV2Schema();
  const profileId = String(req.query.profile || 'icpc'); const limit = api().parseLimit(req, 50, 100); const cursor = Number(api().decodeCursor(req.query.cursor) || 0); const rows = await TypeORM.getConnection().query('SELECT profile_id,contest_id,user_id,status,source_event_id,reason,updated_by,updated_at FROM rating_v2_contest_override WHERE profile_id=? AND contest_id=? AND user_id>? ORDER BY user_id ASC LIMIT ?', [profileId, Number(req.params.id), cursor, limit + 1]);
  const more = rows.length > limit; const page = rows.slice(0, limit); res.locals.apiMeta.limit = limit; res.locals.apiMeta.next_cursor = more ? api().encodeCursor(Number(page[page.length - 1].user_id)) : null;
  return api().send(res, page.map(row => ({ profile_id: row.profile_id, contest_id: Number(row.contest_id), user_id: Number(row.user_id), status: row.status, source_event_id: String(row.source_event_id), reason: row.reason, updated_by: Number(row.updated_by), updated_at: api().databaseIso(row.updated_at) })));
});

app.post(['/api/v2/ratings/users/:id/adjustments', '/api/v2/rating/adjustments'], async (req, res) => {
  const user = res.locals.user; if (!user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.'); if (!await canRating(user, 'rating:publish')) return api().fail(res, 403, 'CAPABILITY_REQUIRED', 'Capability required: rating:publish.'); if (!syzoj.utils.authorizationV2.recentLoginSatisfied(req)) return api().fail(res, 403, 'RECENT_LOGIN_REQUIRED', 'Please sign in again before adjusting Rating.');
  if (req.body && req.body.reverses_event_id != null) return reverseRatingEvent(req, res, user);
  const userId = Number(req.params.id || req.body && req.body.user_id); const profileId = String(req.body && req.body.profile_id || 'icpc'); const delta = Number(req.body && req.body.delta); const reason = syzoj.utils.operationReason(req, '调整用户 Rating'); if (!Number.isSafeInteger(userId) || userId < 1 || !Number.isSafeInteger(delta) || delta === 0 || Math.abs(delta) > 1000) return api().fail(res, 422, 'VALIDATION_FAILED', 'A valid user and non-zero delta are required.', { user_id: 'positive integer', delta: 'integer between -1000 and 1000' });
  await ensureRatingV2Schema(); const profile = await requireProfile(res, profileId); if (!profile) return; const config = profileConfig(profile);
  try {
    const result = await TypeORM.getConnection().transaction(async manager => {
      const users = await manager.query('SELECT id,rating FROM user WHERE id=? FOR UPDATE', [userId]); if (!users.length) { const error = new Error('User was not found.'); error.code = 'USER_NOT_FOUND'; error.statusCode = 404; throw error; }
      const rows = await manager.query('SELECT rating,deviation,volatility FROM rating_v2_current WHERE profile_id=? AND user_id=? FOR UPDATE', [profileId, userId]); const current = rows[0] || { rating: profileId === 'icpc' ? users[0].rating : config.initialRating, deviation: config.initialDeviation, volatility: config.initialVolatility }; const before = Math.round(Number(current.rating)); const after = Math.max(1, before + delta); const source = `adjustment:${crypto.randomUUID()}`;
      const inserted = await manager.query(`INSERT INTO rating_v2_event (profile_id,user_id,contest_id,kind,delta,rating_before,rating_after,deviation_before,deviation_after,volatility_before,volatility_after,preview_id,reason,source_event_id,created_by,created_at)
        VALUES (?,?,NULL,'adjustment',?,?,?,?,?,?,?,NULL,?,?,?,UTC_TIMESTAMP(3))`, [profileId, userId, after - before, before, after, current.deviation, current.deviation, current.volatility, current.volatility, reason, source, user.id]); const eventId = Number(inserted.insertId);
      await manager.query(`INSERT INTO rating_v2_current (profile_id,user_id,rating,deviation,volatility,last_event_id,updated_at) VALUES (?,?,?,?,?,?,UTC_TIMESTAMP(3))
        ON DUPLICATE KEY UPDATE rating=VALUES(rating),deviation=VALUES(deviation),volatility=VALUES(volatility),last_event_id=VALUES(last_event_id),updated_at=VALUES(updated_at)`, [profileId, userId, after, current.deviation, current.volatility, eventId]); if (profileId === 'icpc') await manager.query('UPDATE user SET rating=? WHERE id=?', [after, userId]);
      return { event_id: String(eventId), profile_id: profileId, user_id: userId, rating_before: before, rating_after: after, delta: after - before };
    });
    syzoj.model('user').deleteFromCache(userId); const auditEventId = await syzoj.utils.authorizationV2.recordAudit(req, { action: 'rating:adjust', resourceType: 'user', resourceId: userId, reason, details: result }); return api().send(res, { ...result, audit_event_id: auditEventId }, 201);
  } catch (error) { return api().fail(res, error.statusCode || 409, error.code || 'RATING_ADJUSTMENT_FAILED', error.message); }
});

function operationReason(req) {
  return syzoj.utils.operationReason(req, 'Rating 管理操作');
}
async function requireRatingJobCapability(req, res, capability = 'rating:recalculate') {
  if (!res.locals.user) { api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.'); return false; }
  if (!await canRating(res.locals.user, capability)) { api().fail(res, 403, 'CAPABILITY_REQUIRED', `Capability required: ${capability}.`); return false; }
  return true;
}
async function loadRatingJob(id) {
  await ensureRatingV2Schema(); const rows = await TypeORM.getConnection().query('SELECT * FROM rating_v2_job WHERE id=? LIMIT 1', [id]); return rows[0] || null;
}

app.post('/api/v2/rating/jobs/recalculate', async (req, res) => {
  if (!await requireRatingJobCapability(req, res)) return;
  if (!syzoj.utils.authorizationV2.recentLoginSatisfied(req)) return api().fail(res, 403, 'RECENT_LOGIN_REQUIRED', 'Please sign in again or complete MFA before recalculating Rating.');
  const reason = operationReason(req);
  const profileId = String(req.body && req.body.profile_id || 'icpc'); const fromContestId = req.body && req.body.from_contest_id == null ? null : Number(req.body.from_contest_id);
  await ensureRatingV2Schema(); const profile = await requireProfile(res, profileId); if (!profile) return;
  if (fromContestId != null && (!Number.isSafeInteger(fromContestId) || fromContestId < 1 || !await Contest.findById(fromContestId))) return api().fail(res, 422, 'VALIDATION_FAILED', 'The starting contest is invalid.', { from_contest_id: 'unknown contest' });
  const id = crypto.randomUUID();
  await TypeORM.getConnection().query("INSERT INTO rating_v2_job (id,kind,profile_id,from_contest_id,state,stage,actor_id,reason,created_at,updated_at) VALUES (?,'recalculate',?,?,'queued','preview',?,?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))", [id, profileId, fromContestId, res.locals.user.id, reason]);
  const auditEventId = await syzoj.utils.authorizationV2.recordAudit(req, { action: 'rating:recalculate.create', resourceType: 'rating_job', resourceId: id, reason, details: { profile_id: profileId, from_contest_id: fromContestId } });
  await TypeORM.getConnection().query('UPDATE rating_v2_job SET audit_event_id=? WHERE id=?', [auditEventId, id]);
  await api().appendEvent({ stream: `rating-job:${id}`, type: 'rating.recalculation.queued', aggregateId: id, actor: res.locals.user, payload: { profile_id: profileId, from_contest_id: fromContestId, audit_event_id: auditEventId } });
  setImmediate(() => runRatingJob(id)); const row = await loadRatingJob(id); return api().send(res, { ...serializeRatingJob(row), audit_event_id: String(auditEventId) }, 202);
});

app.get('/api/v2/rating/jobs/:id', async (req, res) => {
  if (!await requireRatingJobCapability(req, res, 'rating:read')) return; const row = await loadRatingJob(req.params.id);
  if (!row) return api().fail(res, 404, 'RATING_JOB_NOT_FOUND', 'Rating job was not found.'); return api().send(res, serializeRatingJob(row));
});

app.get('/api/v2/rating/jobs', async (req, res) => {
  if (!await requireRatingJobCapability(req, res, 'rating:read')) return; await ensureRatingV2Schema(); const limit = api().parseLimit(req, 30, 100); const cursor = api().decodeCursor(req.query.cursor); const profileId = String(req.query.profile_id || '');
  const before = cursor && cursor.created_at ? new Date(cursor.created_at) : null; const beforeId = cursor && cursor.id ? String(cursor.id) : '';
  const rows = await TypeORM.getConnection().query(`SELECT * FROM rating_v2_job WHERE (?='' OR profile_id=?) AND (? IS NULL OR created_at<? OR (created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT ?`, [profileId, profileId, before, before, before, beforeId, limit + 1]);
  const more = rows.length > limit; const page = rows.slice(0, limit); const last = page[page.length - 1]; res.locals.apiMeta.limit = limit; res.locals.apiMeta.next_cursor = more && last ? api().encodeCursor({ created_at: api().databaseIso(last.created_at), id: last.id }) : null; return api().send(res, page.map(serializeRatingJob));
});

app.post('/api/v2/rating/jobs/:id/retry', async (req, res) => {
  if (!await requireRatingJobCapability(req, res)) return;
  if (!syzoj.utils.authorizationV2.recentLoginSatisfied(req)) return api().fail(res, 403, 'RECENT_LOGIN_REQUIRED', 'Please sign in again or complete MFA before retrying Rating recalculation.');
  const reason = operationReason(req); const job = await loadRatingJob(req.params.id);
  if (!job) return api().fail(res, 404, 'RATING_JOB_NOT_FOUND', 'Rating job was not found.'); if (!ratingJobLifecycle.retryAllowed(job)) return api().fail(res, 409, 'RATING_JOB_NOT_RETRYABLE', 'Only a failed, cancelled, or rolled-back job can be retried.');
  const result = await TypeORM.getConnection().query("UPDATE rating_v2_job SET state='queued',stage='preview',processed=0,total=0,current_user_id=NULL,cancel_requested=0,diff_json=NULL,rollback_json=NULL,error_json=NULL,approved_by=NULL,reason=?,completed_at=NULL,rolled_back_at=NULL,updated_at=UTC_TIMESTAMP(3) WHERE id=?", [reason, job.id]);
  if (!result.affectedRows) return api().fail(res, 409, 'RATING_JOB_STATE_CHANGED', 'The Rating job state changed. Refresh and try again.');
  const auditEventId = await syzoj.utils.authorizationV2.recordAudit(req, { action: 'rating:recalculate.retry', resourceType: 'rating_job', resourceId: job.id, reason, details: { previous_state: job.state, previous_stage: job.stage } }); await TypeORM.getConnection().query('UPDATE rating_v2_job SET audit_event_id=? WHERE id=?', [auditEventId, job.id]); setImmediate(() => runRatingJob(job.id)); return api().send(res, { id: job.id, state: 'queued', stage: 'preview', audit_event_id: String(auditEventId) }, 202);
});

app.post('/api/v2/rating/jobs/:id/approve', async (req, res) => {
  if (!await requireRatingJobCapability(req, res)) return;
  if (!syzoj.utils.authorizationV2.recentLoginSatisfied(req)) return api().fail(res, 403, 'RECENT_LOGIN_REQUIRED', 'Please sign in again or complete MFA before approving Rating changes.');
  const reason = operationReason(req); const job = await loadRatingJob(req.params.id);
  if (!job) return api().fail(res, 404, 'RATING_JOB_NOT_FOUND', 'Rating job was not found.'); if (!ratingJobLifecycle.approvalAllowed(job)) return api().fail(res, 409, 'RATING_JOB_NOT_APPROVABLE', 'Only a completed preview can be approved.');
  const result = await TypeORM.getConnection().query("UPDATE rating_v2_job SET state='queued',stage='applying',processed=0,total=?,approved_by=?,reason=?,updated_at=UTC_TIMESTAMP(3) WHERE id=? AND state='paused'", [safeJson(job.diff_json, { items: [] }).items.length, res.locals.user.id, reason, job.id]);
  if (!result.affectedRows) return api().fail(res, 409, 'RATING_JOB_STATE_CHANGED', 'The Rating job state changed. Refresh and try again.');
  const auditEventId = await syzoj.utils.authorizationV2.recordAudit(req, { action: 'rating:recalculate.approve', resourceType: 'rating_job', resourceId: job.id, reason, details: { profile_id: job.profile_id } });
  await TypeORM.getConnection().query('UPDATE rating_v2_job SET audit_event_id=? WHERE id=?', [auditEventId, job.id]); setImmediate(() => runRatingJob(job.id));
  return api().send(res, { id: job.id, state: 'queued', stage: 'applying', audit_event_id: String(auditEventId) }, 202);
});

app.post('/api/v2/rating/jobs/:id/cancel', async (req, res) => {
  if (!await requireRatingJobCapability(req, res)) return; const reason = operationReason(req); const job = await loadRatingJob(req.params.id);
  if (!job) return api().fail(res, 404, 'RATING_JOB_NOT_FOUND', 'Rating job was not found.'); const nextState = ratingJobLifecycle.cancellationState(job); if (!nextState) return api().fail(res, 409, 'RATING_JOB_TERMINAL', 'The Rating job has already finished.');
  await TypeORM.getConnection().query("UPDATE rating_v2_job SET cancel_requested=1,state=?,stage=?,updated_at=UTC_TIMESTAMP(3) WHERE id=?", [nextState, nextState, job.id]);
  const auditEventId = await syzoj.utils.authorizationV2.recordAudit(req, { action: 'rating:recalculate.cancel', resourceType: 'rating_job', resourceId: job.id, reason, details: { previous_state: job.state } });
  return api().send(res, { id: job.id, state: nextState, audit_event_id: String(auditEventId) }, nextState === 'cancelling' ? 202 : 200);
});

app.post('/api/v2/rating/jobs/:id/rollback', async (req, res) => {
  if (!await requireRatingJobCapability(req, res)) return;
  if (!syzoj.utils.authorizationV2.recentLoginSatisfied(req)) return api().fail(res, 403, 'RECENT_LOGIN_REQUIRED', 'Please sign in again or complete MFA before rolling back Rating.');
  const reason = operationReason(req); const job = await loadRatingJob(req.params.id);
  if (!job) return api().fail(res, 404, 'RATING_JOB_NOT_FOUND', 'Rating job was not found.'); if (!ratingJobLifecycle.rollbackAllowed(job)) return api().fail(res, 409, 'RATING_JOB_NOT_ROLLBACKABLE', 'Only an applied recalculation can be rolled back.');
  try {
    const userIds = await TypeORM.getConnection().transaction(async manager => {
      const jobs = await manager.query('SELECT * FROM rating_v2_job WHERE id=? FOR UPDATE', [job.id]); const currentJob = jobs[0]; if (!currentJob || currentJob.state !== 'completed' || currentJob.stage !== 'completed') throw Object.assign(new Error('The Rating job is no longer rollbackable.'), { code: 'RATING_JOB_STATE_CHANGED' });
      const profileRows = await manager.query('SELECT * FROM rating_v2_profile WHERE id=? LIMIT 1', [currentJob.profile_id]); if (!profileRows.length) throw Object.assign(new Error('Rating profile is unavailable.'), { code: 'RATING_PROFILE_INVALID' }); const profile = profileRows[0]; const config = profileConfig(profile); const rollbackState = safeJson(currentJob.rollback_json, []); const rollback = Array.isArray(rollbackState) ? rollbackState : rollbackState.projections || []; const notificationRollback = Array.isArray(rollbackState) ? [] : rollbackState.notifications || [];
      for (const item of rollback) {
        const current = await projectionForUser(manager, profile, item.user_id, config, true); if (!rollbackIsCurrent(current, item)) throw Object.assign(new Error(`Rating changed after this job for user #${item.user_id}.`), { code: 'RATING_ROLLBACK_STALE' });
        const inserted = await manager.query(`INSERT INTO rating_v2_event (profile_id,user_id,contest_id,kind,delta,rating_before,rating_after,deviation_before,deviation_after,volatility_before,volatility_after,preview_id,reason,source_event_id,job_id,supersedes_event_id,created_by,created_at)
          VALUES (?,?,NULL,'projection_rollback',?,?,?,?,?,?,?,NULL,?,?,?,?,?,UTC_TIMESTAMP(3))`, [profile.id, item.user_id, item.before.rating - current.rating, current.rating, item.before.rating, current.deviation, item.before.deviation, current.volatility, item.before.volatility, reason, `rating-job:${job.id}:rollback:${item.user_id}`, job.id, Number(item.apply_event_id), res.locals.user.id]);
        const eventId = Number(inserted.insertId); await manager.query(`UPDATE rating_v2_current SET rating=?,deviation=?,volatility=?,last_event_id=?,updated_at=UTC_TIMESTAMP(3) WHERE profile_id=? AND user_id=?`, [item.before.rating, item.before.deviation, item.before.volatility, eventId, profile.id, item.user_id]); if (profile.id === 'icpc') await manager.query('UPDATE user SET rating=? WHERE id=?', [item.before.rating, item.user_id]);
      }
      for (let index = notificationRollback.length - 1; index >= 0; index -= 1) {
        const item = notificationRollback[index];
        await ratingNotification.restoreRatingChangeNotification(manager, {
          profileId: item.profile_id,
          contestId: item.contest_id,
          userId: item.user_id,
          previous: item.previous,
          jobId: job.id,
          actorId: res.locals.user.id
        });
      }
      await manager.query("UPDATE rating_v2_job SET stage='rolled_back',rolled_back_at=UTC_TIMESTAMP(3),updated_at=UTC_TIMESTAMP(3) WHERE id=?", [job.id]); return rollback.map(item => Number(item.user_id));
    });
    userIds.forEach(userId => syzoj.model('user').deleteFromCache(userId)); const auditEventId = await syzoj.utils.authorizationV2.recordAudit(req, { action: 'rating:recalculate.rollback', resourceType: 'rating_job', resourceId: job.id, reason, details: { affected_users: userIds.length } }); await api().appendEvent({ stream: `rating-job:${job.id}`, type: 'rating.recalculation.rolled_back', aggregateId: job.id, actor: res.locals.user, payload: { affected_users: userIds.length, audit_event_id: auditEventId } }); return api().send(res, { id: job.id, state: 'completed', stage: 'rolled_back', affected_users: userIds.length, audit_event_id: String(auditEventId) });
  } catch (error) { return api().fail(res, 409, error.code || 'RATING_ROLLBACK_FAILED', error.message); }
});

app.get('/api/v2/rating/jobs/:id/events', async (req, res) => { if (!await requireRatingJobCapability(req, res, 'rating:read')) return; const job = await loadRatingJob(req.params.id); if (!job) return api().fail(res, 404, 'RATING_JOB_NOT_FOUND', 'Rating job was not found.'); return api().sse(req, res, `rating-job:${job.id}`); });

syzoj.utils.ratingV2 = { ensureSchema: ensureRatingV2Schema, run: runRatingJob, serializeJob: serializeRatingJob };
ensureRatingV2Schema().then(async () => {
  const connection = TypeORM.getConnection(); await connection.query("UPDATE rating_v2_job SET state='cancelled',stage='cancelled',updated_at=UTC_TIMESTAMP(3) WHERE state='cancelling'"); await connection.query("UPDATE rating_v2_job SET state='queued',updated_at=UTC_TIMESTAMP(3) WHERE state='running'");
  setTimeout(async () => { const rows = await connection.query("SELECT id FROM rating_v2_job WHERE state='queued' ORDER BY created_at ASC LIMIT 10"); rows.forEach(row => setImmediate(() => runRatingJob(row.id))); }, 5000);
}).catch(error => syzoj.log(`[rating-v2] schema initialization failed: ${error.stack || error.message}`));
