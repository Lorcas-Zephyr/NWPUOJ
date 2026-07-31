'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const ratingNotification = require('../libs/rating-notification');

const root = path.resolve(__dirname, '../..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

function scriptedManager(responses) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      const response = responses[calls.length - 1];
      if (response instanceof Error) throw response;
      return typeof response === 'function' ? response(calls[calls.length - 1]) : response;
    }
  };
}

test('contest deletion recalculation text names the deleted contest and Rating delta', () => {
  const text = ratingNotification.notificationText({
    profileId: 'icpc',
    contestId: 21,
    contestTitle: '后续比赛',
    kind: 'recalculated',
    causeType: 'contest_deleted',
    causeContestId: 18,
    causeContestTitle: '被删除的比赛',
    ratingBefore: 1620,
    ratingAfter: 1588
  });

  assert.equal(text.title, '后续比赛 Rating 已重新计算');
  assert.equal(text.content, '由于比赛《被删除的比赛》已删除，Rating 1620 → 1588（-32）');
  assert.equal(text.delta, -32);
});

test('first Rating change creates one notification, delivery marker, and domain event', async () => {
  const manager = scriptedManager([[], [], { insertId: 41 }, { affectedRows: 1 }, { insertId: 81 }]);
  const result = await ratingNotification.upsertRatingChangeNotification(manager, {
    profileId: 'icpc',
    contestId: 21,
    userId: 7,
    contestTitle: '校赛',
    rank: 3,
    participantCount: 40,
    ratingBefore: 1500,
    ratingAfter: 1532,
    sourceKey: 'rating-event:91',
    now: 1785360000
  });

  assert.equal(result.notificationId, 41);
  assert.equal(result.created, true);
  assert.equal(result.deduplicated, false);
  assert.equal(result.previous, null);
  assert.match(manager.calls[2].sql, /INSERT INTO notification/);
  assert.match(manager.calls[3].sql, /INSERT INTO rating_notification_delivery/);
  assert.match(manager.calls[4].sql, /INSERT INTO api_v2_event/);
  assert.match(manager.calls[2].params[3], /Rating 1500 → 1532（\+32）/);
});

test('same Rating source key is idempotent and performs no second write', async () => {
  const manager = scriptedManager([[{
    profile_id: 'icpc', contest_id: 21, user_id: 7,
    notification_id: 41, source_key: 'rating-event:91'
  }]]);
  const result = await ratingNotification.upsertRatingChangeNotification(manager, {
    profileId: 'icpc', contestId: 21, userId: 7,
    ratingBefore: 1500, ratingAfter: 1532,
    sourceKey: 'rating-event:91', now: 1785360000
  });

  assert.equal(result.deduplicated, true);
  assert.equal(result.notificationId, 41);
  assert.equal(manager.calls.length, 1);
});

test('recalculation updates the tracked notification and captures a rollback snapshot', async () => {
  const delivery = {
    profile_id: 'icpc', contest_id: 21, user_id: 7, notification_id: 41,
    source_key: 'rating-event:91', rating_before: 1500, rating_after: 1532,
    delta: 32, rank_position: 3, participant_count: 40, job_id: null,
    created_at: new Date('2026-07-31T00:00:00Z'), updated_at: new Date('2026-07-31T00:00:00Z')
  };
  const notification = {
    id: 41, recipient_id: 7, type: 'contest_rating', title: '校赛 Rating 已更新',
    content: 'old', source_url: '/contest/21/ranklist', source_id: 21,
    actor_id: null, is_read: 1, created_at: 1785360000, read_at: 1785360100
  };
  const manager = scriptedManager([[delivery], [notification], { affectedRows: 1 }, { affectedRows: 1 }, { insertId: 82 }]);
  const result = await ratingNotification.upsertRatingChangeNotification(manager, {
    profileId: 'icpc', contestId: 21, userId: 7, contestTitle: '校赛',
    ratingBefore: 1532, ratingAfter: 1510, sourceKey: 'rating-event:103',
    kind: 'recalculated', jobId: '11111111-1111-1111-1111-111111111111', now: 1785360200
  });

  assert.equal(result.created, false);
  assert.equal(result.previous.delivery.source_key, 'rating-event:91');
  assert.equal(result.previous.notification.is_read, 1);
  assert.match(manager.calls[2].sql, /is_read=0/);
  assert.match(manager.calls[2].params[2], /Rating 1532 → 1510（-22）/);
});

test('removing an obsolete Rating change returns the data needed for rollback', async () => {
  const delivery = { profile_id: 'icpc', contest_id: 21, user_id: 7, notification_id: 41, source_key: 'rating-event:91' };
  const notification = { id: 41, recipient_id: 7, type: 'contest_rating', title: '校赛 Rating 已更新' };
  const manager = scriptedManager([[delivery], [notification], { affectedRows: 1 }, { affectedRows: 1 }, { insertId: 83 }]);
  const result = await ratingNotification.removeRatingChangeNotification(manager, {
    profileId: 'icpc', contestId: 21, userId: 7
  });

  assert.equal(result.removed, true);
  assert.equal(result.previous.notification.id, 41);
  assert.match(manager.calls[2].sql, /DELETE FROM notification/);
  assert.match(manager.calls[3].sql, /DELETE FROM rating_notification_delivery/);
  assert.match(manager.calls[4].sql, /INSERT INTO api_v2_event/);
});

test('recalculation rollback restores the previous notification and delivery marker', async () => {
  const previous = {
    delivery: {
      profile_id: 'icpc', contest_id: 21, user_id: 7, notification_id: 41,
      source_key: 'rating-event:91', rating_before: 1500, rating_after: 1532,
      delta: 32, rank_position: 3, participant_count: 40, job_id: null,
      created_at: '2026-07-31T00:00:00.000Z', updated_at: '2026-07-31T00:00:00.000Z'
    },
    notification: {
      id: 41, recipient_id: 7, type: 'contest_rating', title: '校赛 Rating 已更新',
      content: 'Rating 1500 → 1532（+32）', source_url: '/contest/21/ranklist',
      source_id: 21, actor_id: null, is_read: 1, created_at: 1785360000, read_at: 1785360100
    }
  };
  const manager = scriptedManager([[{ notification_id: 50 }], { affectedRows: 1 }, [], { insertId: 41 }, { affectedRows: 1 }, { insertId: 84 }]);
  const result = await ratingNotification.restoreRatingChangeNotification(manager, {
    profileId: 'icpc', contestId: 21, userId: 7, previous,
    jobId: '11111111-1111-1111-1111-111111111111', actorId: 1
  });

  assert.equal(result.restored, true);
  assert.match(manager.calls[1].sql, /DELETE FROM notification/);
  assert.match(manager.calls[3].sql, /INSERT INTO notification/);
  assert.match(manager.calls[4].sql, /INSERT INTO rating_notification_delivery/);
  assert.match(manager.calls[5].sql, /INSERT INTO api_v2_event/);
  assert.equal(manager.calls[3].params[0], 41);
  assert.equal(manager.calls[3].params[8], 1);
});

test('Rating publish, recalculation, rollback, and contest deletion use the notification domain', () => {
  const apiModule = read('custom/modules/_api_v2_rating_domain.js');
  const legacyDomain = read('custom/libs/contest-rating.js');

  assert.match(apiModule, /upsertRatingChangeNotification\(manager/);
  assert.match(apiModule, /removeRatingChangeNotification\(manager/);
  assert.match(apiModule, /restoreRatingChangeNotification\(manager/);
  assert.match(apiModule, /removed_contest_events/);
  assert.match(legacyDomain, /causeType: 'contest_deleted'/);
  assert.match(legacyDomain, /sourceKey: `contest-delete:\$\{contestId\}:user:\$\{userId\}`/);
  assert.match(legacyDomain, /sourceUrl: `\/user\/\$\{userId\}`/);
});
