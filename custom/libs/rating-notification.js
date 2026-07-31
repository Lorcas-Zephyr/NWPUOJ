'use strict';

const { appendEvent } = require('./content-domain');

function integer(value, field, options = {}) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || (!options.allowZero && number < 1)) {
    throw new TypeError(`Invalid Rating notification ${field}.`);
  }
  return number;
}

function profileId(value) {
  const profile = String(value || '');
  if (!/^[a-z0-9_-]{1,32}$/.test(profile)) throw new TypeError('Invalid Rating notification profile.');
  return profile;
}

function sourceKey(value) {
  const source = String(value || '');
  if (!source || Buffer.byteLength(source, 'utf8') > 191) throw new TypeError('Invalid Rating notification source.');
  return source;
}

function ratingValue(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(`Invalid Rating notification ${field}.`);
  return Math.round(number);
}

function notificationType(profile) {
  return profile === 'icpc' ? 'contest_rating' : `contest_rating_${profile}`;
}

function signedDelta(value) {
  return value >= 0 ? `+${value}` : String(value);
}

function databaseDate(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) return new Date(value);
  return value;
}

function notificationText(input) {
  const before = ratingValue(input.ratingBefore, 'rating_before');
  const after = ratingValue(input.ratingAfter, 'rating_after');
  const delta = after - before;
  const rank = Number(input.rank);
  const participants = Number(input.participantCount);
  const ranking = Number.isSafeInteger(rank) && rank > 0 && Number.isSafeInteger(participants) && participants > 0
    ? `第 ${rank} / ${participants} 名，`
    : '';
  const profile = profileId(input.profileId);
  const profileSuffix = profile === 'icpc' ? '' : ` · ${String(input.profileName || profile.toUpperCase())}`;
  const action = input.kind === 'recalculated' ? 'Rating 已重新计算' : 'Rating 已更新';
  const cause = input.causeType === 'contest_deleted'
    ? `由于比赛《${String(input.causeContestTitle || `#${input.causeContestId}`)}》已删除，`
    : '';
  return {
    title: `${String(input.contestTitle || `比赛 #${input.contestId}`)} ${action}${profileSuffix}`,
    content: `${cause}${ranking}Rating ${before} → ${after}（${signedDelta(delta)}）`,
    before,
    after,
    delta
  };
}

async function ensureSchema(connection) {
  await connection.query(`CREATE TABLE IF NOT EXISTS rating_notification_delivery (
    profile_id VARCHAR(32) NOT NULL,
    contest_id INT NOT NULL,
    user_id INT NOT NULL,
    notification_id INT NOT NULL,
    source_key VARCHAR(191) NOT NULL,
    rating_before INT NOT NULL,
    rating_after INT NOT NULL,
    delta INT NOT NULL,
    rank_position INT NULL,
    participant_count INT NULL,
    job_id CHAR(36) NULL,
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    PRIMARY KEY(profile_id,contest_id,user_id),
    UNIQUE KEY uq_rating_notification_source(source_key),
    KEY idx_rating_notification_job(job_id),
    KEY idx_rating_notification_id(notification_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}

async function upsertRatingChangeNotification(manager, input) {
  const profile = profileId(input.profileId);
  const contestId = integer(input.contestId, 'contest_id');
  const userId = integer(input.userId, 'user_id');
  const source = sourceKey(input.sourceKey);
  const notificationUrl = String(input.sourceUrl || `/contest/${contestId}/ranklist`);
  const now = integer(input.now == null ? Math.floor(Date.now() / 1000) : input.now, 'timestamp');
  const text = notificationText({ ...input, profileId: profile, contestId });
  const deliveryRows = await manager.query(
    'SELECT * FROM rating_notification_delivery WHERE profile_id=? AND contest_id=? AND user_id=? LIMIT 1 FOR UPDATE',
    [profile, contestId, userId]
  );
  const delivery = deliveryRows[0] || null;
  if (delivery && delivery.source_key === source) {
    return { notificationId: Number(delivery.notification_id), eventId: null, created: false, deduplicated: true, previous: null };
  }

  const type = notificationType(profile);
  let notificationId = null;
  let notification = null;
  if (delivery) {
    const notifications = await manager.query(
      'SELECT * FROM notification WHERE id=? AND recipient_id=? LIMIT 1 FOR UPDATE',
      [delivery.notification_id, userId]
    );
    if (notifications.length) {
      notification = notifications[0];
      notificationId = Number(notification.id);
    }
  } else {
    const notifications = await manager.query(
      'SELECT * FROM notification WHERE recipient_id=? AND type=? AND source_id=? ORDER BY id DESC LIMIT 1 FOR UPDATE',
      [userId, type, contestId]
    );
    if (notifications.length) {
      notification = notifications[0];
      notificationId = Number(notification.id);
    }
  }
  const previous = delivery || notification ? { delivery: delivery || null, notification: notification || null } : null;

  const created = notificationId == null;
  if (created) {
    const inserted = await manager.query(
      `INSERT INTO notification
        (recipient_id,type,title,content,source_url,source_id,actor_id,is_read,created_at,read_at)
       VALUES (?,?,?,?,?,?,NULL,0,?,NULL)`,
      [userId, type, text.title, text.content, notificationUrl, contestId, now]
    );
    notificationId = Number(inserted.insertId);
  } else {
    await manager.query(
      `UPDATE notification SET type=?,title=?,content=?,source_url=?,source_id=?,actor_id=NULL,
         is_read=0,created_at=?,read_at=NULL WHERE id=? AND recipient_id=?`,
      [type, text.title, text.content, notificationUrl, contestId, now, notificationId, userId]
    );
  }

  await manager.query(
    `INSERT INTO rating_notification_delivery
      (profile_id,contest_id,user_id,notification_id,source_key,rating_before,rating_after,delta,
       rank_position,participant_count,job_id,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))
     ON DUPLICATE KEY UPDATE notification_id=VALUES(notification_id),source_key=VALUES(source_key),
       rating_before=VALUES(rating_before),rating_after=VALUES(rating_after),delta=VALUES(delta),
       rank_position=VALUES(rank_position),participant_count=VALUES(participant_count),job_id=VALUES(job_id),
       updated_at=UTC_TIMESTAMP(3)`,
    [
      profile, contestId, userId, notificationId, source, text.before, text.after, text.delta,
      input.rank == null ? null : Number(input.rank),
      input.participantCount == null ? null : Number(input.participantCount),
      input.jobId == null ? null : String(input.jobId)
    ]
  );
  const eventId = await appendEvent(manager, {
    stream: `notifications:user:${userId}`,
    type: created ? 'notification.created' : 'notification.updated',
    aggregateId: notificationId,
    actorId: null,
    payload: {
      notification_id: notificationId,
      source_type: 'contest_rating',
      profile_id: profile,
      contest_id: contestId,
      rating_before: text.before,
      rating_after: text.after,
      delta: text.delta,
      source_key: source,
      cause_type: input.causeType || null,
      cause_contest_id: input.causeContestId == null ? null : Number(input.causeContestId)
    }
  });
  return { notificationId, eventId, created, deduplicated: false, previous };
}

async function removeRatingChangeNotification(manager, input) {
  const profile = profileId(input.profileId);
  const contestId = integer(input.contestId, 'contest_id');
  const userId = integer(input.userId, 'user_id');
  const rows = await manager.query(
    'SELECT * FROM rating_notification_delivery WHERE profile_id=? AND contest_id=? AND user_id=? LIMIT 1 FOR UPDATE',
    [profile, contestId, userId]
  );
  if (!rows.length) return { removed: false, notificationId: null, eventId: null, previous: null };
  const delivery = rows[0];
  const notificationId = Number(delivery.notification_id);
  const notifications = await manager.query(
    'SELECT * FROM notification WHERE id=? AND recipient_id=? LIMIT 1 FOR UPDATE',
    [notificationId, userId]
  );
  const previous = { delivery, notification: notifications[0] || null };
  await manager.query('DELETE FROM notification WHERE id=? AND recipient_id=?', [notificationId, userId]);
  await manager.query(
    'DELETE FROM rating_notification_delivery WHERE profile_id=? AND contest_id=? AND user_id=?',
    [profile, contestId, userId]
  );
  const eventId = await appendEvent(manager, {
    stream: `notifications:user:${userId}`,
    type: 'notification.deleted',
    aggregateId: notificationId,
    actorId: null,
    payload: { notification_id: notificationId, source_type: 'contest_rating', profile_id: profile, contest_id: contestId }
  });
  return { removed: true, notificationId, eventId, previous };
}

async function restoreRatingChangeNotification(manager, input) {
  const profile = profileId(input.profileId);
  const contestId = integer(input.contestId, 'contest_id');
  const userId = integer(input.userId, 'user_id');
  const snapshot = input.previous || null;
  const currentRows = await manager.query(
    'SELECT notification_id FROM rating_notification_delivery WHERE profile_id=? AND contest_id=? AND user_id=? LIMIT 1 FOR UPDATE',
    [profile, contestId, userId]
  );
  const currentNotificationId = currentRows.length ? Number(currentRows[0].notification_id) : null;

  if (!snapshot || !snapshot.delivery || !snapshot.notification) {
    if (currentNotificationId != null) {
      await manager.query('DELETE FROM notification WHERE id=? AND recipient_id=?', [currentNotificationId, userId]);
      await manager.query(
        'DELETE FROM rating_notification_delivery WHERE profile_id=? AND contest_id=? AND user_id=?',
        [profile, contestId, userId]
      );
    }
    if (snapshot && snapshot.notification) {
      const notification = snapshot.notification;
      const restoredNotificationId = Number(notification.id);
      const existing = await manager.query('SELECT id FROM notification WHERE id=? LIMIT 1 FOR UPDATE', [restoredNotificationId]);
      if (!existing.length) {
        await manager.query(
          `INSERT INTO notification
            (id,recipient_id,type,title,content,source_url,source_id,actor_id,is_read,created_at,read_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          [
            restoredNotificationId, userId, notification.type, notification.title, notification.content,
            notification.source_url, notification.source_id, notification.actor_id, notification.is_read,
            notification.created_at, notification.read_at
          ]
        );
      }
    }
  } else {
    const delivery = snapshot.delivery;
    const notification = snapshot.notification;
    const restoredNotificationId = Number(delivery.notification_id);
    if (currentNotificationId != null && currentNotificationId !== restoredNotificationId) {
      await manager.query('DELETE FROM notification WHERE id=? AND recipient_id=?', [currentNotificationId, userId]);
    }
    if (notification) {
      const existing = await manager.query('SELECT id FROM notification WHERE id=? LIMIT 1 FOR UPDATE', [restoredNotificationId]);
      if (existing.length) {
        await manager.query(
          `UPDATE notification SET recipient_id=?,type=?,title=?,content=?,source_url=?,source_id=?,actor_id=?,
             is_read=?,created_at=?,read_at=? WHERE id=?`,
          [
            userId, notification.type, notification.title, notification.content, notification.source_url,
            notification.source_id, notification.actor_id, notification.is_read, notification.created_at,
            notification.read_at, restoredNotificationId
          ]
        );
      } else {
        await manager.query(
          `INSERT INTO notification
            (id,recipient_id,type,title,content,source_url,source_id,actor_id,is_read,created_at,read_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          [
            restoredNotificationId, userId, notification.type, notification.title, notification.content,
            notification.source_url, notification.source_id, notification.actor_id, notification.is_read,
            notification.created_at, notification.read_at
          ]
        );
      }
    }
    await manager.query(
      `INSERT INTO rating_notification_delivery
        (profile_id,contest_id,user_id,notification_id,source_key,rating_before,rating_after,delta,
         rank_position,participant_count,job_id,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE notification_id=VALUES(notification_id),source_key=VALUES(source_key),
         rating_before=VALUES(rating_before),rating_after=VALUES(rating_after),delta=VALUES(delta),
         rank_position=VALUES(rank_position),participant_count=VALUES(participant_count),job_id=VALUES(job_id),
         created_at=VALUES(created_at),updated_at=VALUES(updated_at)`,
      [
        profile, contestId, userId, restoredNotificationId, delivery.source_key,
        delivery.rating_before, delivery.rating_after, delivery.delta, delivery.rank_position,
        delivery.participant_count, delivery.job_id, databaseDate(delivery.created_at), databaseDate(delivery.updated_at)
      ]
    );
  }

  const eventId = await appendEvent(manager, {
    stream: `notifications:user:${userId}`,
    type: 'notification.rating_restored',
    aggregateId: currentNotificationId || snapshot && snapshot.delivery && snapshot.delivery.notification_id || `${profile}:${contestId}:${userId}`,
    actorId: input.actorId == null ? null : Number(input.actorId),
    payload: { source_type: 'contest_rating', profile_id: profile, contest_id: contestId, job_id: input.jobId || null }
  });
  return { restored: !!(snapshot && snapshot.delivery), eventId };
}

module.exports = {
  ensureSchema,
  notificationText,
  notificationType,
  removeRatingChangeNotification,
  restoreRatingChangeNotification,
  upsertRatingChangeNotification
};
