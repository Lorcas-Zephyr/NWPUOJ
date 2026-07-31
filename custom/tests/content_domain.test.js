'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const content = require('../libs/content-domain');

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

test('notification read-all stores Unix seconds and writes an event atomically', async () => {
  const manager = scriptedManager([{ affectedRows: 3 }, { insertId: 71 }]);
  const result = await content.markAllNotificationsRead(manager, { userId: 4, now: 1785360000 });

  assert.deepEqual(result, { updated: 3, eventId: '71' });
  assert.match(manager.calls[0].sql, /read_at=\?/);
  assert.doesNotMatch(manager.calls[0].sql, /UTC_TIMESTAMP/);
  assert.deepEqual(manager.calls[0].params, [1785360000, 4]);
  assert.match(manager.calls[1].sql, /INSERT INTO api_v2_event/);
});

test('single notification read locks ownership and writes its event atomically', async () => {
  const manager = scriptedManager([[{ id: 8, source_url: '/problem/1', is_read: 0, read_at: null }], { affectedRows: 1 }, { insertId: 72 }]);
  const result = await content.markNotificationRead(manager, { notificationId: 8, userId: 4, now: 1785360000 });

  assert.deepEqual(result, { id: 8, sourceUrl: '/problem/1', readAt: 1785360000, updated: 1, eventId: '72' });
  assert.match(manager.calls[0].sql, /id=\? AND recipient_id=\? LIMIT 1 FOR UPDATE/);
  assert.deepEqual(manager.calls[1].params, [1785360000, 8, 4]);
  assert.match(manager.calls[2].sql, /INSERT INTO api_v2_event/);
});

test('notification delete locks ownership before deleting data and appending its event', async () => {
  const manager = scriptedManager([[{ id: 8 }], { affectedRows: 1 }, { insertId: 73 }]);
  const result = await content.deleteNotification(manager, { notificationId: 8, userId: 4 });

  assert.deepEqual(result, { id: 8, deleted: true, eventId: '73' });
  assert.match(manager.calls[0].sql, /FOR UPDATE/);
  assert.match(manager.calls[1].sql, /DELETE FROM notification WHERE id=\? AND recipient_id=\?/);
  assert.match(manager.calls[2].sql, /INSERT INTO api_v2_event/);
});

test('user-tag grant locks the target and stores audit plus domain event atomically', async () => {
  const manager = scriptedManager([
    [{ id: 9, username: 'member', is_admin: 0 }],
    [],
    { affectedRows: 1 },
    { insertId: 801 }
  ]);
  const audits = [];
  const result = await content.grantUserTag(manager, {
    targetUserId: 9,
    actorId: 1,
    now: 1785360000,
    recordAudit: async (event, currentManager) => {
      audits.push(event);
      assert.equal(currentManager, manager);
      return '701';
    }
  });

  assert.equal(result.restored, false);
  assert.equal(result.auditEventId, '701');
  assert.equal(result.eventId, '801');
  assert.match(manager.calls[0].sql, /FROM user WHERE id=\? LIMIT 1 FOR UPDATE/);
  assert.match(manager.calls[1].sql, /FROM user_tag WHERE user_id=\? LIMIT 1 FOR UPDATE/);
  assert.match(manager.calls[2].sql, /INSERT INTO user_tag/);
  assert.match(manager.calls[3].sql, /INSERT INTO api_v2_event/);
  assert.equal(audits[0].action, 'admin:user-tag.grant');
});

test('user-tag grant rejects duplicate active access before audit or event writes', async () => {
  const manager = scriptedManager([
    [{ id: 9, username: 'member', is_admin: 0 }],
    [{ user_id: 9, is_disabled: 0 }]
  ]);
  await assert.rejects(
    content.grantUserTag(manager, { targetUserId: 9, actorId: 1, now: 1, recordAudit: async () => 'never' }),
    error => error.code === 'USER_TAG_GRANT_EXISTS' && error.statusCode === 409
  );
  assert.equal(manager.calls.length, 2);
});

test('user-tag disable protects the actor and site administrators', async () => {
  const own = scriptedManager([]);
  await assert.rejects(
    content.disableUserTag(own, { targetUserId: 1, actorId: 1, now: 1, recordAudit: async () => 'never' }),
    error => error.code === 'SELF_USER_TAG_DISABLE_FORBIDDEN' && error.statusCode === 403
  );
  assert.equal(own.calls.length, 0);

  const administrator = scriptedManager([[{ id: 2, username: 'admin', is_admin: 1 }]]);
  await assert.rejects(
    content.disableUserTag(administrator, { targetUserId: 2, actorId: 1, now: 1, recordAudit: async () => 'never' }),
    error => error.code === 'ADMIN_USER_TAG_PROTECTED' && error.statusCode === 403
  );
  assert.equal(administrator.calls.length, 1);
});

test('user-tag disable creates a deny record with audit and event when no grant exists', async () => {
  const manager = scriptedManager([
    [{ id: 9, username: 'member', is_admin: 0 }],
    [],
    { affectedRows: 1 },
    { insertId: 802 }
  ]);
  const result = await content.disableUserTag(manager, {
    targetUserId: 9,
    actorId: 1,
    now: 1785360000,
    recordAudit: async (_event, currentManager) => {
      assert.equal(currentManager, manager);
      return '702';
    }
  });

  assert.equal(result.changed, true);
  assert.equal(result.auditEventId, '702');
  assert.equal(result.eventId, '802');
  assert.match(manager.calls[2].sql, /INSERT INTO user_tag/);
  assert.deepEqual(manager.calls[2].params, [9, 1, 1785360000, null, 1785360000]);
  assert.match(manager.calls[3].sql, /INSERT INTO api_v2_event/);
});

test('global user-tag setting uses ETag protection and stores audit plus event atomically', async () => {
  const current = { enabled: 1, updated_by: 1, updated_at: '2026-07-31T00:00:00.000Z' };
  const manager = scriptedManager([[current], { affectedRows: 1 }, { insertId: 803 }]);
  let matched = false;
  const result = await content.updateUserTagGlobalSetting(manager, {
    actorId: 1,
    enabled: false,
    ifMatch: value => { matched = value === current; return true; },
    recordAudit: async (event, currentManager) => {
      assert.equal(currentManager, manager);
      assert.equal(event.action, 'admin:user-tag.setting.update');
      return '703';
    }
  });

  assert.equal(matched, true);
  assert.deepEqual(result, { enabled: false, changed: true, auditEventId: '703', eventId: '803' });
  assert.match(manager.calls[0].sql, /user_tag_global_setting.*FOR UPDATE/);
  assert.match(manager.calls[1].sql, /UPDATE user_tag_global_setting SET enabled=\?/);
  assert.match(manager.calls[2].sql, /INSERT INTO api_v2_event/);
});

test('notification center uses only v2 writes without a legacy form fallback', () => {
  const view = read('custom/views/notifications.ejs');
  const route = read('custom/modules/_api_v2_content_domain.js');

  assert.match(route, /app\.post\('\/api\/v2\/notifications\/:id\/read'/);
  assert.match(route, /app\.delete\('\/api\/v2\/notifications\/:id'/);
  assert.match(route, /app\.get\(\['\/api\/v2\/notifications', '\/api\/v2\/me\/notifications'\]/);
  for (const action of ['read-all', 'read', 'delete']) assert.match(view, new RegExp('data-notification-v2="' + action + '"'));
  assert.doesNotMatch(view, /API_DOMAIN_DISABLED/);
  assert.doesNotMatch(view, /HTMLFormElement\.prototype\.submit\.call\(form\)/);
  assert.match(view, /'Idempotency-Key': operationKey\(\)/);
});

test('message send locks recipient policy before creating the message and event', async () => {
  const manager = scriptedManager([[{ id: 9 }], [{ disable_messages: 0 }], { insertId: 31 }, { insertId: 90 }]);
  const result = await content.sendMessage(manager, {
    senderId: 4,
    receiverId: 9,
    content: '  hello  ',
    now: 1785360000
  });

  assert.equal(result.id, 31);
  assert.equal(result.content, 'hello');
  assert.match(manager.calls[0].sql, /user WHERE id=\? LIMIT 1 FOR UPDATE/);
  assert.match(manager.calls[1].sql, /user_message_setting.*FOR UPDATE/);
  assert.match(manager.calls[2].sql, /INSERT INTO private_message/);
  assert.match(manager.calls[3].sql, /INSERT INTO api_v2_event/);
});

test('disabled message recipient rejects without creating message or event', async () => {
  const manager = scriptedManager([[{ id: 9 }], [{ disable_messages: 1 }]]);
  await assert.rejects(
    content.sendMessage(manager, { senderId: 4, receiverId: 9, content: 'hello', now: 1 }),
    error => error.code === 'MESSAGES_DISABLED' && error.statusCode === 409
  );
  assert.equal(manager.calls.length, 2);
});

test('message policy override preserves administrator delivery and the legacy length limit', async () => {
  const manager = scriptedManager([[{ id: 9 }], [{ disable_messages: 1 }], { insertId: 32 }, { insertId: 91 }]);
  const result = await content.sendMessage(manager, {
    senderId: 4,
    receiverId: 9,
    content: 'administrator notice',
    bypassRecipientPolicy: true,
    now: 1785360000
  });
  assert.equal(result.id, 32);
  assert.match(manager.calls[1].sql, /user_message_setting.*FOR UPDATE/);
  assert.match(manager.calls[2].sql, /INSERT INTO private_message/);

  const oversized = scriptedManager([]);
  await assert.rejects(
    content.sendMessage(oversized, { senderId: 4, receiverId: 9, content: 'x'.repeat(5001), now: 1 }),
    error => error.code === 'VALIDATION_FAILED' && error.statusCode === 422
  );
  assert.equal(oversized.calls.length, 0);
});

test('message forms use only v2 writes without a legacy fallback', () => {
  const shared = read('custom/views/messages_v2_script.ejs');
  const conversation = read('custom/views/messages_conversation.ejs');
  const compose = read('custom/views/messages_new.ejs');
  const settings = read('custom/views/messages_settings.ejs');
  const route = read('custom/modules/_api_v2_content_domain.js');

  assert.match(conversation, /data-message-v2="reply"/);
  assert.match(compose, /data-message-v2="new"/);
  assert.match(settings, /data-message-v2="settings"/);
  assert.match(compose, /\/api\/v2\/search\/users\//);
  assert.match(shared, /\/api\/v2\/messages\/conversations\//);
  assert.match(shared, /method: 'PATCH'/);
  assert.match(shared, /'If-Match': etag/);
  assert.doesNotMatch(shared, /API_DOMAIN_DISABLED/);
  assert.doesNotMatch(shared, /HTMLFormElement\.prototype\.submit\.call\(form\)/);
  assert.match(shared, /'Idempotency-Key': operationKey\(\)/);
  assert.match(route, /syzoj\.utils\.isEmailVerified\(user\.id\)/);
  assert.match(route, /bypassRecipientPolicy: access\.bypassRecipientPolicy/);
});

test('conversation read marks only inbound messages and emits an event when needed', async () => {
  const manager = scriptedManager([
    [{ id: 9 }],
    [
      { id: 1, sender_id: 9, receiver_id: 4, content: 'in', public_time: 1, is_read: 0 },
      { id: 2, sender_id: 4, receiver_id: 9, content: 'out', public_time: 2, is_read: 1 }
    ],
    { affectedRows: 1 },
    { insertId: 91 }
  ]);
  const result = await content.readConversation(manager, { userId: 4, peerId: 9 });

  assert.equal(result.updated, 1);
  assert.equal(result.rows[0].is_read, 1);
  assert.equal(result.eventId, '91');
  assert.match(manager.calls[1].sql, /FOR UPDATE$/);
});

test('conversation list uses stable keyset pagination and returns an opaque cursor payload', async () => {
  const manager = scriptedManager([[
    { user_id: 9, username: 'nine', last_time: 30, unread: 2 },
    { user_id: 8, username: 'eight', last_time: 20, unread: 0 },
    { user_id: 7, username: 'seven', last_time: 10, unread: 1 }
  ]]);
  const result = await content.listConversations(manager, { userId: 4, limit: 2, cursor: null });

  assert.equal(result.rows.length, 2);
  assert.deepEqual(result.nextCursor, { last_time: 20, user_id: 8 });
  assert.match(manager.calls[0].sql, /FROM \( SELECT CASE WHEN message\.sender_id=\?/);
  assert.match(manager.calls[0].sql, /ORDER BY conversation\.last_time DESC,conversation\.user_id DESC/);
  assert.deepEqual(manager.calls[0].params, [4, 4, 4, 4, 4, 3]);

  const invalid = scriptedManager([]);
  await assert.rejects(
    content.listConversations(invalid, { userId: 4, limit: 2, cursor: { last_time: 'bad', user_id: 8 } }),
    error => error.code === 'INVALID_CURSOR' && error.statusCode === 400
  );
  assert.equal(invalid.calls.length, 0);
});

test('conversation message pages return chronological rows from a newest-first locked scan', async () => {
  const manager = scriptedManager([
    [{ id: 9 }],
    [
      { id: 5, sender_id: 9, receiver_id: 4, content: 'new', public_time: 5, is_read: 1 },
      { id: 4, sender_id: 4, receiver_id: 9, content: 'middle', public_time: 4, is_read: 1 },
      { id: 3, sender_id: 9, receiver_id: 4, content: 'old', public_time: 3, is_read: 1 }
    ],
    { affectedRows: 0 }
  ]);
  const result = await content.readConversation(manager, {
    userId: 4,
    peerId: 9,
    limit: 2,
    beforeId: null
  });

  assert.deepEqual(result.rows.map(row => row.id), [4, 5]);
  assert.equal(result.nextCursor, 4);
  assert.match(manager.calls[1].sql, /ORDER BY id DESC LIMIT \? FOR UPDATE/);
  assert.deepEqual(manager.calls[1].params, [4, 9, 9, 4, 3]);
});

test('message deletion is user-scoped, transactional, and emits a content event', async () => {
  const manager = scriptedManager([
    [{ id: 21, sender_id: 4, receiver_id: 9, sender_deleted: 0, receiver_deleted: 0 }],
    { affectedRows: 1 },
    { insertId: 95 }
  ]);
  const result = await content.deleteMessageForUser(manager, { messageId: 21, userId: 4 });
  assert.deepEqual(result, { id: 21, peerId: 9, permanentlyDeleted: false, eventId: '95' });
  assert.match(manager.calls[0].sql, /private_message.*FOR UPDATE/);
  assert.match(manager.calls[1].sql, /UPDATE private_message SET sender_deleted=\?,receiver_deleted=\?/);
  assert.deepEqual(manager.calls[1].params, [1, 0, 21]);
  assert.match(manager.calls[2].sql, /INSERT INTO api_v2_event/);

  const finalDelete = scriptedManager([
    [{ id: 22, sender_id: 4, receiver_id: 9, sender_deleted: 0, receiver_deleted: 1 }],
    { affectedRows: 1 },
    { insertId: 96 }
  ]);
  const deleted = await content.deleteMessageForUser(finalDelete, { messageId: 22, userId: 4 });
  assert.equal(deleted.permanentlyDeleted, true);
  assert.match(finalDelete.calls[1].sql, /DELETE FROM private_message/);
});

test('conversation deletion changes only the current user visibility flags', async () => {
  const manager = scriptedManager([{ affectedRows: 3 }, { affectedRows: 2 }, { insertId: 97 }]);
  const result = await content.deleteConversationForUser(manager, { userId: 4, peerId: 9 });
  assert.deepEqual(result, { peerId: 9, deleted: 5, eventId: '97' });
  assert.match(manager.calls[0].sql, /SET sender_deleted=1 WHERE sender_id=\? AND receiver_id=\?/);
  assert.deepEqual(manager.calls[0].params, [4, 9]);
  assert.match(manager.calls[1].sql, /SET receiver_deleted=1 WHERE sender_id=\? AND receiver_id=\?/);
  assert.deepEqual(manager.calls[1].params, [9, 4]);
  assert.match(manager.calls[2].sql, /INSERT INTO api_v2_event/);
});

test('message settings lock current state and reject stale ETags before upsert', async () => {
  const stale = scriptedManager([[{ disable_messages: 0, update_time: 1 }]]);
  await assert.rejects(
    content.updateMessageSettings(stale, {
      userId: 4,
      disabled: true,
      now: 2,
      ifMatch: () => false
    }),
    error => error.code === 'ETAG_MISMATCH' && error.statusCode === 412
  );
  assert.equal(stale.calls.length, 1);
  assert.match(stale.calls[0].sql, /FOR UPDATE/);

  const manager = scriptedManager([
    [{ disable_messages: 0, update_time: 1 }],
    { affectedRows: 1 },
    { insertId: 94 }
  ]);
  const result = await content.updateMessageSettings(manager, {
    userId: 4,
    disabled: true,
    now: 2,
    ifMatch: () => true
  });
  assert.deepEqual(result, { disabled: true, now: 2, eventId: '94' });
  assert.match(manager.calls[1].sql, /ON DUPLICATE KEY UPDATE/);
  assert.match(manager.calls[2].sql, /INSERT INTO api_v2_event/);
});

test('discussion creation locks an attached problem and persists its event atomically', async () => {
  const manager = scriptedManager([
    [{ id: 12, user_id: 4, is_public: 1 }],
    { insertId: 30 },
    { insertId: 95 }
  ]);
  const result = await content.createDiscussion(manager, {
    actorId: 4,
    title: '  Training notes  ',
    content: '  Explain the invariant.  ',
    problemId: 12,
    canUseHiddenProblem: false,
    now: 1785360000
  });

  assert.equal(result.id, 30);
  assert.equal(result.title, 'Training notes');
  assert.equal(result.content, 'Explain the invariant.');
  assert.equal(result.eventId, '95');
  assert.match(manager.calls[0].sql, /problem WHERE id=\? LIMIT 1 FOR UPDATE/);
  assert.match(manager.calls[1].sql, /INSERT INTO article/);
  assert.match(manager.calls[2].sql, /INSERT INTO api_v2_event/);
});

test('discussion creation hides inaccessible private problems without writing', async () => {
  const manager = scriptedManager([[{ id: 12, user_id: 9, is_public: 0 }]]);
  await assert.rejects(
    content.createDiscussion(manager, {
      actorId: 4,
      title: 'Notes',
      content: 'Body',
      problemId: 12,
      canUseHiddenProblem: false,
      now: 1
    }),
    error => error.code === 'PROBLEM_NOT_FOUND' && error.statusCode === 404
  );
  assert.equal(manager.calls.length, 1);
});

test('discussion update protects ownership and concurrent revisions', async () => {
  const current = {
    id: 30,
    title: 'Old title',
    content: 'Old body',
    user_id: 4,
    problem_id: 12,
    is_notice: 0,
    update_time: 10
  };
  const manager = scriptedManager([[current], { affectedRows: 1 }, { insertId: 951 }]);
  const result = await content.updateDiscussion(manager, {
    discussionId: 30,
    actorId: 4,
    title: '  New title  ',
    content: '  New body  ',
    isModerator: false,
    isNotice: true,
    now: 20,
    ifMatch: value => value === current
  });
  assert.deepEqual(result, {
    id: 30,
    title: 'New title',
    content: 'New body',
    problemId: 12,
    isNotice: false,
    now: 20,
    eventId: '951'
  });
  assert.match(manager.calls[0].sql, /FROM article WHERE id=\? LIMIT 1 FOR UPDATE/);
  assert.deepEqual(manager.calls[1].params, ['New title', 'New body', 0, 20, 30]);
  assert.match(manager.calls[2].sql, /INSERT INTO api_v2_event/);

  const stale = scriptedManager([[current]]);
  await assert.rejects(
    content.updateDiscussion(stale, {
      discussionId: 30,
      actorId: 4,
      title: 'New title',
      content: 'New body',
      isModerator: false,
      now: 20,
      ifMatch: () => false
    }),
    error => error.code === 'ETAG_MISMATCH' && error.statusCode === 412
  );
  assert.equal(stale.calls.length, 1);
});

test('discussion replies enforce the locked state after acquiring the row lock', async () => {
  const member = scriptedManager([[{ id: 30, allow_comment: 0 }]]);
  await assert.rejects(
    content.replyToDiscussion(member, {
      discussionId: 30,
      actorId: 4,
      content: 'reply',
      isModerator: false,
      now: 1
    }),
    error => error.code === 'DISCUSSION_LOCKED' && error.statusCode === 409
  );
  assert.equal(member.calls.length, 1);
  assert.match(member.calls[0].sql, /WHERE article\.id=\? LIMIT 1 FOR UPDATE/);

  const moderator = scriptedManager([
    [{ id: 30, allow_comment: 0 }],
    { insertId: 41 },
    { affectedRows: 1 },
    { insertId: 96 }
  ]);
  const result = await content.replyToDiscussion(moderator, {
    discussionId: 30,
    actorId: 7,
    content: 'moderator reply',
    isModerator: true,
    now: 1785360000
  });
  assert.equal(result.id, 41);
  assert.equal(result.eventId, '96');
  assert.match(moderator.calls[2].sql, /comments_num=\(SELECT COUNT\(\*\)/);
  assert.match(moderator.calls[3].sql, /INSERT INTO api_v2_event/);

  const hidden = scriptedManager([[
    { id: 30, allow_comment: 1, user_id: 9, problem_id: 12, problem_is_public: 0, problem_user_id: 8 }
  ]]);
  await assert.rejects(
    content.replyToDiscussion(hidden, {
      discussionId: 30,
      actorId: 4,
      content: 'guessed discussion',
      isModerator: false,
      canViewHiddenProblem: false,
      allowedProblemIds: [],
      now: 1
    }),
    error => error.code === 'DISCUSSION_NOT_FOUND' && error.statusCode === 404
  );
  assert.equal(hidden.calls.length, 1);
});

test('discussion deletion authorizes the owner and persists audit and domain events atomically', async () => {
  const manager = scriptedManager([
    [{ id: 30, user_id: 4, problem_id: 12 }],
    { affectedRows: 2 },
    { affectedRows: 1 },
    { insertId: 98 }
  ]);
  let auditManager = null;
  const result = await content.deleteDiscussion(manager, {
    discussionId: 30,
    actorId: 4,
    isModerator: false,
    recordAudit: async (event, currentManager) => {
      auditManager = currentManager;
      assert.equal(event.action, 'discussion:delete');
      assert.deepEqual(event.details, { problem_id: 12 });
      return '47';
    }
  });

  assert.equal(auditManager, manager);
  assert.deepEqual(result, { id: 30, problemId: 12, auditEventId: '47', eventId: '98' });
  assert.match(manager.calls[0].sql, /article WHERE id=\? LIMIT 1 FOR UPDATE/);
  assert.match(manager.calls[1].sql, /DELETE FROM article_comment/);
  assert.match(manager.calls[2].sql, /DELETE FROM article WHERE/);
  assert.match(manager.calls[3].sql, /INSERT INTO api_v2_event/);

  const foreign = scriptedManager([[{ id: 30, user_id: 9, problem_id: null }]]);
  await assert.rejects(
    content.deleteDiscussion(foreign, {
      discussionId: 30,
      actorId: 4,
      isModerator: false,
      recordAudit: async () => 'unused'
    }),
    error => error.code === 'DISCUSSION_FORBIDDEN' && error.statusCode === 403
  );
  assert.equal(foreign.calls.length, 1);
});

test('discussion reply deletion allows the reply author, discussion owner, or moderator', async () => {
  const manager = scriptedManager([
    [{ user_id: 9, discussion_user_id: 4 }],
    { affectedRows: 1 },
    { affectedRows: 1 },
    { insertId: 99 }
  ]);
  const result = await content.deleteDiscussionReply(manager, {
    discussionId: 30,
    replyId: 41,
    actorId: 4,
    isModerator: false,
    recordAudit: async (event, currentManager) => {
      assert.equal(currentManager, manager);
      assert.equal(event.action, 'discussion:reply.delete');
      assert.deepEqual(event.details, { discussion_id: 30 });
      return '48';
    }
  });

  assert.deepEqual(result, { id: 41, discussionId: 30, auditEventId: '48', eventId: '99' });
  assert.match(manager.calls[0].sql, /article_comment reply[\s\S]*FOR UPDATE/);
  assert.match(manager.calls[1].sql, /DELETE FROM article_comment/);
  assert.match(manager.calls[2].sql, /comments_num=\(SELECT COUNT\(\*\)/);
  assert.match(manager.calls[3].sql, /INSERT INTO api_v2_event/);

  const foreign = scriptedManager([[{ user_id: 9, discussion_user_id: 8 }]]);
  await assert.rejects(
    content.deleteDiscussionReply(foreign, {
      discussionId: 30,
      replyId: 41,
      actorId: 4,
      isModerator: false,
      recordAudit: async () => 'unused'
    }),
    error => error.code === 'DISCUSSION_FORBIDDEN' && error.statusCode === 403
  );
  assert.equal(foreign.calls.length, 1);
});

test('discussion lock keeps row update, audit, and event on one manager', async () => {
  const manager = scriptedManager([
    [{ id: 30, allow_comment: 1 }],
    { affectedRows: 1 },
    { insertId: 97 }
  ]);
  let auditManager = null;
  const result = await content.setDiscussionLock(manager, {
    discussionId: 30,
    actorId: 7,
    isModerator: true,
    locked: true,
    now: 1785360000,
    reason: 'lock discussion',
    recordAudit: async (event, currentManager) => {
      auditManager = currentManager;
      assert.equal(event.action, 'discussion:lock');
      assert.deepEqual(event.details, { previous_locked: false, locked: true, changed: true });
      return '46';
    }
  });

  assert.equal(auditManager, manager);
  assert.equal(result.auditEventId, '46');
  assert.equal(result.eventId, '97');
  assert.match(manager.calls[0].sql, /FOR UPDATE/);
  assert.match(manager.calls[1].sql, /UPDATE article SET allow_comment/);
  assert.match(manager.calls[2].sql, /INSERT INTO api_v2_event/);
});

test('solution API maps the legacy accepted state to approved', () => {
  assert.equal(content.apiSolutionStatus('accepted'), 'approved');
  assert.equal(content.apiSolutionStatus('pending'), 'pending');
  assert.equal(content.apiSolutionStatus('rejected'), 'rejected');
});

test('solution creation locks problem policy and creates a draft with its event', async () => {
  const manager = scriptedManager([
    [{ id: 12, user_id: 9, is_public: 1 }],
    [{ disable_submission: 0 }],
    { insertId: 61 },
    { insertId: 102 }
  ]);
  const result = await content.createSolution(manager, {
    actorId: 4,
    problemId: 12,
    title: '  Proof  ',
    content: '  The invariant holds.  ',
    submitForReview: false,
    allowComment: true,
    isModerator: false,
    canUseHiddenProblem: false,
    now: 1785360000
  });

  assert.equal(result.id, 61);
  assert.equal(result.status, 'draft');
  assert.equal(result.title, 'Proof');
  assert.equal(result.content, 'The invariant holds.');
  assert.match(manager.calls[0].sql, /problem WHERE id=\? LIMIT 1 FOR UPDATE/);
  assert.match(manager.calls[1].sql, /problem_solution_setting.*FOR UPDATE/);
  assert.match(manager.calls[2].sql, /INSERT INTO problem_solution/);
  assert.equal(manager.calls[2].params[4], 'draft');
  assert.match(manager.calls[3].sql, /INSERT INTO api_v2_event/);
});

test('solution creation rejects hidden problems and disabled submissions before insert', async () => {
  const hidden = scriptedManager([[{ id: 12, user_id: 9, is_public: 0 }]]);
  await assert.rejects(
    content.createSolution(hidden, {
      actorId: 4,
      problemId: 12,
      title: 'Proof',
      content: 'Body',
      isModerator: false,
      canUseHiddenProblem: false,
      now: 1
    }),
    error => error.code === 'PROBLEM_NOT_FOUND' && error.statusCode === 404
  );
  assert.equal(hidden.calls.length, 1);

  const disabled = scriptedManager([
    [{ id: 12, user_id: 9, is_public: 1 }],
    [{ disable_submission: 1 }]
  ]);
  await assert.rejects(
    content.createSolution(disabled, {
      actorId: 4,
      problemId: 12,
      title: 'Proof',
      content: 'Body',
      isModerator: false,
      canUseHiddenProblem: false,
      now: 1
    }),
    error => error.code === 'SOLUTION_SUBMISSION_DISABLED' && error.statusCode === 409
  );
  assert.equal(disabled.calls.length, 2);
});

test('solution editing locks the aggregate, checks its revision, and resubmits author changes for review', async () => {
  const manager = scriptedManager([
    [{ id: 61, problem_id: 12, user_id: 4, status: 'rejected', title: 'Old', content: 'Old body', allow_comment: 1, update_time: 1 }],
    { affectedRows: 1 },
    { insertId: 120 }
  ]);
  const result = await content.updateSolution(manager, {
    solutionId: 61,
    actorId: 4,
    isModerator: false,
    title: ' Revised proof ',
    content: ' Revised body ',
    allowComment: false,
    now: 1785360000,
    reason: '编辑题解',
    ifMatch: () => true,
    recordAudit: async (event, currentManager) => {
      assert.equal(currentManager, manager);
      assert.equal(event.action, 'solution:update');
      assert.deepEqual(event.details, { problem_id: 12, author_id: 4, previous_status: 'rejected', status: 'pending' });
      return '64';
    }
  });
  assert.deepEqual(result, {
    id: 61, problemId: 12, title: 'Revised proof', content: 'Revised body',
    status: 'pending', allowComment: false, updateTime: 1785360000,
    auditEventId: '64', eventId: '120'
  });
  assert.match(manager.calls[0].sql, /problem_solution WHERE id=\? LIMIT 1 FOR UPDATE/);
  assert.match(manager.calls[1].sql, /status=\?,update_time=\?/);
  assert.deepEqual(manager.calls[1].params.slice(0, 5), ['Revised proof', 'Revised body', 0, 'pending', 1785360000]);
  assert.match(manager.calls[2].sql, /INSERT INTO api_v2_event/);

  const stale = scriptedManager([[
    { id: 61, problem_id: 12, user_id: 4, status: 'pending', title: 'Changed', content: 'Body', allow_comment: 1, update_time: 2 }
  ]]);
  await assert.rejects(
    content.updateSolution(stale, {
      solutionId: 61, actorId: 4, title: 'Mine', content: 'Body', now: 3,
      ifMatch: () => false, recordAudit: async () => 'unused'
    }),
    error => error.code === 'ETAG_MISMATCH' && error.statusCode === 412
  );
  assert.equal(stale.calls.length, 1);
});

test('solution comments atomically recount, notify the author and mentions, and emit one aggregate event', async () => {
  const manager = scriptedManager([
    [{ id: 61, title: 'Proof', problem_id: 12, user_id: 4, status: 'accepted', allow_comment: 1 }],
    { insertId: 71 },
    { affectedRows: 1 },
    [{ id: 4 }, { id: 8 }],
    { insertId: 201 },
    { insertId: 301 },
    { insertId: 202 },
    { insertId: 302 },
    { insertId: 303 }
  ]);
  const result = await content.createSolutionComment(manager, {
    solutionId: 61,
    actorId: 7,
    actorName: 'member',
    isModerator: false,
    content: ' Thanks @reader ',
    mentionUserIds: [8, 8, 7],
    now: 1785360000
  });
  assert.equal(result.id, 71);
  assert.equal(result.eventId, '303');
  assert.deepEqual(result.notifications, [
    { id: 201, recipientId: 4, eventId: '301' },
    { id: 202, recipientId: 8, eventId: '302' }
  ]);
  assert.match(manager.calls[0].sql, /problem_solution WHERE id=\? LIMIT 1 FOR UPDATE/);
  assert.match(manager.calls[1].sql, /INSERT INTO problem_solution_comment/);
  assert.match(manager.calls[2].sql, /comments_num=\(SELECT COUNT\(\*\)/);
  assert.match(manager.calls[3].sql, /SELECT id FROM user WHERE id IN/);
  assert.equal(manager.calls[4].params[1], 'solution_comment');
  assert.equal(manager.calls[6].params[1], 'solution_comment_mention');
  assert.match(manager.calls[8].sql, /INSERT INTO api_v2_event/);

  const closed = scriptedManager([[
    { id: 61, title: 'Proof', problem_id: 12, user_id: 4, status: 'accepted', allow_comment: 0 }
  ]]);
  await assert.rejects(
    content.createSolutionComment(closed, {
      solutionId: 61, actorId: 7, isModerator: false, content: 'No access', now: 1
    }),
    error => error.code === 'SOLUTION_FORBIDDEN' && error.statusCode === 403
  );
  assert.equal(closed.calls.length, 1);
});

test('solution review submission locks ownership, clears rejection, and emits an event', async () => {
  const manager = scriptedManager([
    [{ id: 61, problem_id: 12, user_id: 4, status: 'rejected', disable_submission: 0 }],
    { affectedRows: 1 },
    { insertId: 103 }
  ]);
  const result = await content.submitSolutionReview(manager, {
    solutionId: 61,
    actorId: 4,
    isModerator: false,
    now: 1785360000,
    ifMatch: () => true
  });

  assert.equal(result.status, 'pending');
  assert.equal(result.eventId, '103');
  assert.match(manager.calls[0].sql, /problem_solution solution.*FOR UPDATE/);
  assert.match(manager.calls[1].sql, /status='pending',reject_reason=NULL/);
  assert.match(manager.calls[2].sql, /INSERT INTO api_v2_event/);

  const foreign = scriptedManager([[
    { id: 61, problem_id: 12, user_id: 9, status: 'draft', disable_submission: 0 }
  ]]);
  await assert.rejects(
    content.submitSolutionReview(foreign, { solutionId: 61, actorId: 4, now: 1 }),
    error => error.code === 'SOLUTION_FORBIDDEN' && error.statusCode === 403
  );
  assert.equal(foreign.calls.length, 1);
});

test('solution rejection requires an author-facing reason before database access', async () => {
  const manager = scriptedManager([]);
  await assert.rejects(
    content.reviewSolution(manager, {
      solutionId: 61,
      reviewerId: 7,
      isModerator: true,
      decision: 'rejected',
      reason: '   ',
      now: 1,
      recordAudit: async () => 'unused'
    }),
    error => error.code === 'VALIDATION_FAILED' && error.fields.reason === 'required'
  );
  assert.equal(manager.calls.length, 0);
});

test('solution approval stores accepted and atomically records audit, notification, and events', async () => {
  const manager = scriptedManager([
    [{ id: 61, problem_id: 12, user_id: 4, title: 'Proof', status: 'pending', public_time: null, update_time: 1 }],
    { affectedRows: 1 },
    { insertId: 71 },
    { insertId: 104 },
    { insertId: 105 }
  ]);
  let auditManager = null;
  const result = await content.reviewSolution(manager, {
    solutionId: 61,
    reviewerId: 7,
    reviewerName: 'moderator',
    isModerator: true,
    decision: 'approved',
    reason: '题解审核通过',
    now: 1785360000,
    ifMatch: () => true,
    recordAudit: async (event, currentManager) => {
      auditManager = currentManager;
      assert.equal(event.action, 'solution:approved');
      assert.equal(event.reason, '题解审核通过');
      return '52';
    }
  });

  assert.equal(result.status, 'approved');
  assert.equal(result.notificationId, 71);
  assert.equal(result.notificationEventId, '104');
  assert.equal(result.eventId, '105');
  assert.equal(auditManager, manager);
  assert.equal(manager.calls[1].params[0], 'accepted');
  assert.match(manager.calls[2].sql, /INSERT INTO notification/);
  assert.match(manager.calls[3].sql, /INSERT INTO api_v2_event/);
  assert.match(manager.calls[4].sql, /INSERT INTO api_v2_event/);
});

test('solution rejection stores the reason while self-review skips duplicate notification', async () => {
  const manager = scriptedManager([
    [{ id: 61, problem_id: 12, user_id: 7, title: 'Proof', status: 'pending', public_time: null, update_time: 1 }],
    { affectedRows: 1 },
    { insertId: 106 }
  ]);
  const result = await content.reviewSolution(manager, {
    solutionId: 61,
    reviewerId: 7,
    reviewerName: 'moderator',
    isModerator: true,
    decision: 'rejected',
    reason: 'Please explain the complexity.',
    now: 1785360000,
    recordAudit: async event => {
      assert.equal(event.reason, 'Please explain the complexity.');
      return '53';
    }
  });

  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'Please explain the complexity.');
  assert.equal(result.notificationId, null);
  assert.equal(manager.calls.length, 3);
  assert.equal(manager.calls[1].params[1], 'Please explain the complexity.');
});

test('solution review rejects stale status before update, audit, or notification', async () => {
  const manager = scriptedManager([[
    { id: 61, problem_id: 12, user_id: 4, title: 'Proof', status: 'accepted' }
  ]]);
  await assert.rejects(
    content.reviewSolution(manager, {
      solutionId: 61,
      reviewerId: 7,
      isModerator: true,
      decision: 'approved',
      now: 1,
      recordAudit: async () => 'unused'
    }),
    error => error.code === 'SOLUTION_NOT_REVIEWABLE' && error.statusCode === 409
  );
  assert.equal(manager.calls.length, 1);
});

test('solution withdrawal is owner-only and stores audit plus event with the state change', async () => {
  const manager = scriptedManager([
    [{ id: 61, problem_id: 12, user_id: 4, status: 'accepted' }],
    { affectedRows: 1 },
    { insertId: 111 }
  ]);
  const result = await content.withdrawSolution(manager, {
    solutionId: 61,
    actorId: 4,
    now: 1785360000,
    recordAudit: async (event, currentManager) => {
      assert.equal(currentManager, manager);
      assert.equal(event.action, 'solution:withdraw');
      assert.deepEqual(event.details, { problem_id: 12, previous_status: 'accepted' });
      return '61';
    }
  });
  assert.deepEqual(result, {
    id: 61, problemId: 12, status: 'withdrawn', updateTime: 1785360000,
    auditEventId: '61', eventId: '111'
  });
  assert.match(manager.calls[0].sql, /problem_solution WHERE id=\? LIMIT 1 FOR UPDATE/);
  assert.match(manager.calls[1].sql, /status='withdrawn'/);
  assert.match(manager.calls[2].sql, /INSERT INTO api_v2_event/);

  const foreign = scriptedManager([[{ id: 61, problem_id: 12, user_id: 9, status: 'accepted' }]]);
  await assert.rejects(
    content.withdrawSolution(foreign, {
      solutionId: 61, actorId: 4, now: 1, recordAudit: async () => 'unused'
    }),
    error => error.code === 'SOLUTION_FORBIDDEN' && error.statusCode === 403
  );
  assert.equal(foreign.calls.length, 1);
});

test('solution deletion removes comments and the aggregate in one audited transaction', async () => {
  const manager = scriptedManager([
    [{ id: 61, problem_id: 12, user_id: 9, status: 'rejected' }],
    { affectedRows: 3 },
    { affectedRows: 1 },
    { insertId: 112 }
  ]);
  const result = await content.deleteSolution(manager, {
    solutionId: 61,
    actorId: 7,
    isModerator: true,
    recordAudit: async (event, currentManager) => {
      assert.equal(currentManager, manager);
      assert.equal(event.action, 'solution:delete');
      assert.deepEqual(event.details, { problem_id: 12, author_id: 9, previous_status: 'rejected' });
      return '62';
    }
  });
  assert.deepEqual(result, { id: 61, problemId: 12, auditEventId: '62', eventId: '112' });
  assert.match(manager.calls[1].sql, /DELETE FROM problem_solution_comment/);
  assert.match(manager.calls[2].sql, /DELETE FROM problem_solution WHERE/);
  assert.match(manager.calls[3].sql, /INSERT INTO api_v2_event/);
});

test('solution comment deletion preserves author and moderator permissions and recounts comments', async () => {
  const manager = scriptedManager([
    [{ user_id: 9, solution_user_id: 4 }],
    { affectedRows: 1 },
    { affectedRows: 1 },
    { insertId: 113 }
  ]);
  const result = await content.deleteSolutionComment(manager, {
    solutionId: 61,
    commentId: 71,
    actorId: 4,
    isModerator: false,
    recordAudit: async (event, currentManager) => {
      assert.equal(currentManager, manager);
      assert.equal(event.action, 'solution:comment.delete');
      return '63';
    }
  });
  assert.deepEqual(result, { id: 71, solutionId: 61, auditEventId: '63', eventId: '113' });
  assert.match(manager.calls[0].sql, /problem_solution_comment comment[\s\S]*FOR UPDATE/);
  assert.match(manager.calls[1].sql, /DELETE FROM problem_solution_comment/);
  assert.match(manager.calls[2].sql, /comments_num=\(SELECT COUNT\(\*\)/);
  assert.match(manager.calls[3].sql, /INSERT INTO api_v2_event/);

  const foreign = scriptedManager([[{ user_id: 9, solution_user_id: 8 }]]);
  await assert.rejects(
    content.deleteSolutionComment(foreign, {
      solutionId: 61, commentId: 71, actorId: 4, isModerator: false,
      recordAudit: async () => 'unused'
    }),
    error => error.code === 'SOLUTION_FORBIDDEN' && error.statusCode === 403
  );
  assert.equal(foreign.calls.length, 1);
});

test('announcement creation keeps content, audit, event, and returned row on one manager', async () => {
  const stored = {
    id: 81, title: 'Notice', content: 'Body', level: 'important', start_time: 10,
    end_time: 20, is_active: 1, public_time: 5, update_time: 5
  };
  const manager = scriptedManager([{ insertId: 81 }, { insertId: 107 }, [stored]]);
  let auditManager = null;
  const result = await content.createAnnouncement(manager, {
    actorId: 7,
    value: {
      title: 'Notice', content: 'Body', level: 'important', start_time: 10,
      end_time: 20, is_active: true
    },
    now: 5,
    reason: 'publish notice',
    recordAudit: async (event, currentManager) => {
      auditManager = currentManager;
      assert.equal(event.action, 'admin:announcement.create');
      return '54';
    }
  });

  assert.equal(result.row, stored);
  assert.equal(result.auditEventId, '54');
  assert.equal(result.eventId, '107');
  assert.equal(auditManager, manager);
  assert.match(manager.calls[0].sql, /INSERT INTO announcement/);
  assert.match(manager.calls[1].sql, /INSERT INTO api_v2_event/);
  assert.match(manager.calls[2].sql, /SELECT \* FROM announcement/);
});

test('announcement update checks ETag after row lock and validates against locked state', async () => {
  const current = {
    id: 81, title: 'Old', content: 'Old body', level: 'info', start_time: 10,
    end_time: 20, is_active: 1, public_time: 5, update_time: 5
  };
  const updated = Object.assign({}, current, { title: 'New', content: 'New body', update_time: 6 });
  const manager = scriptedManager([[current], { affectedRows: 1 }, { insertId: 108 }, [updated]]);
  let validatedCurrent = null;
  const result = await content.updateAnnouncement(manager, {
    announcementId: 81,
    actorId: 7,
    now: 6,
    reason: 'update notice',
    ifMatch: row => row === current,
    validate: row => {
      validatedCurrent = row;
      return {
        errors: {},
        value: {
          title: 'New', content: 'New body', level: 'info', start_time: 10,
          end_time: 20, is_active: true
        }
      };
    },
    recordAudit: async () => '55'
  });

  assert.equal(validatedCurrent, current);
  assert.equal(result.row, updated);
  assert.match(manager.calls[0].sql, /FOR UPDATE/);
  assert.match(manager.calls[1].sql, /UPDATE announcement SET/);
  assert.match(manager.calls[2].sql, /INSERT INTO api_v2_event/);

  const stale = scriptedManager([[current]]);
  await assert.rejects(
    content.updateAnnouncement(stale, {
      announcementId: 81,
      actorId: 7,
      now: 6,
      ifMatch: () => false,
      validate: () => { throw new Error('must not validate stale resource'); },
      recordAudit: async () => 'unused'
    }),
    error => error.code === 'ETAG_MISMATCH' && error.statusCode === 412
  );
  assert.equal(stale.calls.length, 1);
});

test('announcement deletion locks the current resource and persists audit plus event', async () => {
  const current = {
    id: 81, title: 'Notice', content: 'Body', level: 'important', start_time: 10,
    end_time: 20, is_active: 1, public_time: 5, update_time: 5
  };
  const manager = scriptedManager([[current], { affectedRows: 1 }, { insertId: 109 }]);
  let auditManager = null;
  const result = await content.deleteAnnouncement(manager, {
    announcementId: 81,
    actorId: 7,
    reason: 'remove notice',
    ifMatch: row => row === current,
    recordAudit: async (event, currentManager) => {
      auditManager = currentManager;
      assert.equal(event.action, 'admin:announcement.delete');
      return '56';
    }
  });

  assert.equal(result.deleted, true);
  assert.equal(result.auditEventId, '56');
  assert.equal(result.eventId, '109');
  assert.equal(auditManager, manager);
  assert.match(manager.calls[0].sql, /FOR UPDATE/);
  assert.match(manager.calls[1].sql, /DELETE FROM announcement/);
  assert.match(manager.calls[2].sql, /INSERT INTO api_v2_event/);

  const stale = scriptedManager([[current]]);
  await assert.rejects(
    content.deleteAnnouncement(stale, {
      announcementId: 81, actorId: 7, ifMatch: () => false,
      recordAudit: async () => 'unused'
    }),
    error => error.code === 'ETAG_MISMATCH' && error.statusCode === 412
  );
  assert.equal(stale.calls.length, 1);
});

test('banner creation and update share atomic audit and event behavior', async () => {
  const stored = {
    id: 91, title: 'Banner', image_path: '/self/banner/a.png', link_url: '/contests',
    sort_order: 2, is_active: 1, start_time: null, end_time: null, created_by: 7, created_at: 5
  };
  const created = scriptedManager([{ insertId: 91 }, { insertId: 109 }, [stored]]);
  const createResult = await content.createBanner(created, {
    actorId: 7,
    value: {
      title: 'Banner', image_path: '/self/banner/a.png', link_url: '/contests',
      sort_order: 2, is_active: true, start_time: null, end_time: null
    },
    now: 5,
    reason: 'create banner',
    recordAudit: async (_event, manager) => {
      assert.equal(manager, created);
      return '56';
    }
  });
  assert.equal(createResult.row, stored);
  assert.equal(createResult.eventId, '109');

  const updatedRow = Object.assign({}, stored, { sort_order: 3 });
  const updated = scriptedManager([[stored], { affectedRows: 1 }, { insertId: 110 }, [updatedRow]]);
  const updateResult = await content.updateBanner(updated, {
    bannerId: 91,
    actorId: 7,
    reason: 'move banner',
    ifMatch: () => true,
    validate: () => ({
      errors: {},
      value: {
        title: 'Banner', image_path: '/self/banner/a.png', link_url: '/contests',
        sort_order: 3, is_active: true, start_time: null, end_time: null
      }
    }),
    recordAudit: async (_event, manager) => {
      assert.equal(manager, updated);
      return '57';
    }
  });
  assert.equal(updateResult.row, updatedRow);
  assert.match(updated.calls[0].sql, /FOR UPDATE/);
  assert.match(updated.calls[1].sql, /UPDATE homepage_banner SET/);
  assert.match(updated.calls[2].sql, /INSERT INTO api_v2_event/);
});

test('banner update validation failure leaves content, audit, and event untouched', async () => {
  const current = { id: 91, title: 'Banner', image_path: '/a.png', sort_order: 1, is_active: 1 };
  const manager = scriptedManager([[current]]);
  await assert.rejects(
    content.updateBanner(manager, {
      bannerId: 91,
      actorId: 7,
      ifMatch: () => true,
      validate: () => ({ errors: { image_url: 'invalid' }, value: null }),
      recordAudit: async () => 'unused'
    }),
    error => error.code === 'VALIDATION_FAILED' && error.fields.image_url === 'invalid'
  );
  assert.equal(manager.calls.length, 1);
});

test('banner deletion returns the image path only after atomic audit and event persistence', async () => {
  const current = {
    id: 91, title: 'Banner', image_path: '/self/banner/a.png', link_url: '/contests',
    sort_order: 2, is_active: 1, start_time: null, end_time: null, created_by: 7, created_at: 5
  };
  const manager = scriptedManager([[current], { affectedRows: 1 }, { insertId: 111 }]);
  let auditManager = null;
  const result = await content.deleteBanner(manager, {
    bannerId: 91,
    actorId: 7,
    reason: 'remove banner',
    ifMatch: () => true,
    recordAudit: async (event, currentManager) => {
      auditManager = currentManager;
      assert.equal(event.action, 'admin:banner.delete');
      return '58';
    }
  });

  assert.equal(result.row.image_path, '/self/banner/a.png');
  assert.equal(result.auditEventId, '58');
  assert.equal(result.eventId, '111');
  assert.equal(auditManager, manager);
  assert.match(manager.calls[0].sql, /FOR UPDATE/);
  assert.match(manager.calls[1].sql, /DELETE FROM homepage_banner/);
  assert.match(manager.calls[2].sql, /INSERT INTO api_v2_event/);
});

test('clipboard creation persists data, audit, and event with a bounded share token', async () => {
  const manager = scriptedManager([{ insertId: 51 }, { insertId: 98 }]);
  let auditManager = null;
  const result = await content.createClipboard(manager, {
    actorId: 4,
    title: 'Snippet',
    content: 'const answer = 42;',
    visibility: 'link',
    shareExpires: 1785446400,
    now: 1785360000,
    generateToken: () => 'abcdefghijklmnopqrstuvwx',
    recordAudit: async (event, currentManager) => {
      auditManager = currentManager;
      assert.equal(event.action, 'clipboard:create');
      return '47';
    }
  });

  assert.equal(result.id, 51);
  assert.equal(result.share_token, 'abcdefghijklmnopqrstuvwx');
  assert.equal(result.share_expires, 1785446400);
  assert.equal(result.auditEventId, '47');
  assert.equal(result.eventId, '98');
  assert.equal(auditManager, manager);
  assert.match(manager.calls[0].sql, /INSERT INTO clipboard_item/);
  assert.match(manager.calls[1].sql, /INSERT INTO api_v2_event/);
});

test('clipboard content preserves empty legacy notes and enforces the UTF-8 100 KiB limit', async () => {
  const empty = scriptedManager([{ insertId: 52 }, { insertId: 101 }]);
  const result = await content.createClipboard(empty, {
    actorId: 4,
    title: 'Empty note',
    content: '',
    visibility: 'private',
    now: 1785360000,
    generateToken: () => 'abcdefghijklmnopqrstuvwx',
    recordAudit: async () => '50'
  });
  assert.equal(result.content, '');
  assert.equal(empty.calls[0].params[2], '');

  const oversized = scriptedManager([]);
  await assert.rejects(
    content.createClipboard(oversized, {
      actorId: 4,
      title: 'Large note',
      content: '中'.repeat(34134),
      visibility: 'private',
      now: 1,
      generateToken: () => 'abcdefghijklmnopqrstuvwx',
      recordAudit: async () => 'unused'
    }),
    error => error.code === 'VALIDATION_FAILED' && /UTF-8 bytes/.test(error.fields.content)
  );
  assert.equal(oversized.calls.length, 0);
});

test('clipboard updates reject foreign owners and stale ETags before any write', async () => {
  const foreign = scriptedManager([[{ id: 51, user_id: 9, title: 'A', content: 'B', visibility: 'private' }]]);
  await assert.rejects(
    content.updateClipboard(foreign, {
      clipboardId: 51,
      actorId: 4,
      patch: { title: 'Changed' },
      now: 1,
      generateToken: () => 'abcdefghijklmnopqrstuvwx',
      recordAudit: async () => 'unused'
    }),
    error => error.code === 'CLIPBOARD_FORBIDDEN' && error.statusCode === 403
  );
  assert.equal(foreign.calls.length, 1);

  const stale = scriptedManager([[{ id: 51, user_id: 4, title: 'A', content: 'B', visibility: 'private' }]]);
  await assert.rejects(
    content.updateClipboard(stale, {
      clipboardId: 51,
      actorId: 4,
      patch: { title: 'Changed' },
      now: 1,
      generateToken: () => 'abcdefghijklmnopqrstuvwx',
      ifMatch: () => false,
      recordAudit: async () => 'unused'
    }),
    error => error.code === 'ETAG_MISMATCH' && error.statusCode === 412
  );
  assert.equal(stale.calls.length, 1);
});

test('clipboard visibility transition clears obsolete sharing state atomically', async () => {
  const manager = scriptedManager([
    [{ id: 51, user_id: 4, title: 'A', content: 'B', visibility: 'link', share_token: 'oldtokenabcdefghijkl', share_expires: 99, public_time: 1, update_time: 1 }],
    { affectedRows: 1 },
    { insertId: 99 }
  ]);
  const result = await content.updateClipboard(manager, {
    clipboardId: 51,
    actorId: 4,
    patch: { visibility: 'public' },
    now: 2,
    generateToken: () => 'abcdefghijklmnopqrstuvwx',
    ifMatch: () => true,
    recordAudit: async () => '48'
  });

  assert.equal(result.visibility, 'public');
  assert.equal(result.share_token, null);
  assert.equal(result.share_expires, null);
  assert.deepEqual(manager.calls[1].params, ['A', 'B', 'public', null, null, 2, 51]);
  assert.match(manager.calls[2].sql, /INSERT INTO api_v2_event/);
});

test('clipboard update persists an edited link expiry with the same aggregate write', async () => {
  const manager = scriptedManager([
    [{ id: 51, user_id: 4, title: 'A', content: 'B', visibility: 'link', share_token: 'oldtokenabcdefghijkl', share_expires: null, public_time: 1, update_time: 1 }],
    { affectedRows: 1 },
    { insertId: 102 }
  ]);
  const result = await content.updateClipboard(manager, {
    clipboardId: 51,
    actorId: 4,
    patch: { visibility: 'link', share_expires: 1785446400 },
    now: 1785360000,
    generateToken: () => 'abcdefghijklmnopqrstuvwx',
    ifMatch: () => true,
    recordAudit: async () => '51'
  });
  assert.equal(result.share_expires, 1785446400);
  assert.equal(manager.calls[1].params[4], 1785446400);
});

test('clipboard sharing rotates the token and validates expiry before locking', async () => {
  const manager = scriptedManager([
    [{ id: 51, user_id: 4, title: 'A', content: 'B', visibility: 'private', public_time: 1, update_time: 1 }],
    { affectedRows: 1 },
    { insertId: 100 }
  ]);
  const result = await content.shareClipboard(manager, {
    clipboardId: 51,
    actorId: 4,
    expiresInDays: 7,
    now: 1785360000,
    generateToken: () => 'zyxwvutsrqponmlkjihgfedc',
    ifMatch: () => true,
    recordAudit: async () => '49'
  });
  assert.equal(result.share_token, 'zyxwvutsrqponmlkjihgfedc');
  assert.equal(result.share_expires, 1785964800);
  assert.deepEqual(manager.calls[1].params, ['zyxwvutsrqponmlkjihgfedc', 1785964800, 1785360000, 51]);

  const invalid = scriptedManager([]);
  await assert.rejects(
    content.shareClipboard(invalid, {
      clipboardId: 51,
      actorId: 4,
      expiresInDays: 366,
      now: 1,
      generateToken: () => 'abcdefghijklmnopqrstuvwx',
      recordAudit: async () => 'unused'
    }),
    error => error.code === 'VALIDATION_FAILED' && error.statusCode === 422
  );
  assert.equal(invalid.calls.length, 0);
});

test('clipboard link regeneration preserves the current expiry when none is supplied', async () => {
  const manager = scriptedManager([
    [{ id: 51, user_id: 4, title: 'A', content: 'B', visibility: 'link', share_token: 'oldtokenabcdefghijkl', share_expires: 1785446400, public_time: 1, update_time: 1 }],
    { affectedRows: 1 },
    { insertId: 103 }
  ]);
  const result = await content.shareClipboard(manager, {
    clipboardId: 51,
    actorId: 4,
    now: 1785360000,
    generateToken: () => 'zyxwvutsrqponmlkjihgfedc',
    ifMatch: () => true,
    recordAudit: async () => '52'
  });
  assert.equal(result.share_expires, 1785446400);
  assert.equal(manager.calls[1].params[1], 1785446400);
});

test('clipboard forms use v2 writes with ETags and no legacy fallback', () => {
  const shared = read('custom/views/clipboard_v2_script.ejs');
  const editor = read('custom/views/clipboard_edit.ejs');
  const view = read('custom/views/clipboard_view.ejs');
  assert.match(editor, /data-clipboard-v2="save"/);
  assert.match(view, /data-clipboard-v2="share"/);
  assert.match(view, /data-clipboard-v2="delete"/);
  assert.match(shared, /method = 'PATCH'/);
  assert.match(shared, /method = 'DELETE'/);
  assert.match(shared, /headers\['If-Match'\] = version\.etag/);
  assert.doesNotMatch(shared, /API_DOMAIN_DISABLED/);
  assert.doesNotMatch(shared, /HTMLFormElement\.prototype\.submit\.call\(form\)/);
  assert.match(shared, /'Idempotency-Key': operationKey\(\)/);
});

test('shared clipboard lookup rejects malformed and expired tokens as not found', async () => {
  const malformed = scriptedManager([]);
  await assert.rejects(
    content.readSharedClipboard(malformed, { token: 'short', now: 1785360000 }),
    error => error.code === 'CLIPBOARD_NOT_FOUND' && error.statusCode === 404
  );
  assert.equal(malformed.calls.length, 0);

  const expired = scriptedManager([[]]);
  await assert.rejects(
    content.readSharedClipboard(expired, { token: 'abcdefghijklmnopqrstuvwx', now: 1785360000 }),
    error => error.code === 'CLIPBOARD_NOT_FOUND' && error.statusCode === 404
  );
  assert.match(expired.calls[0].sql, /share_expires IS NULL OR share_expires>\?/);
  assert.deepEqual(expired.calls[0].params, ['abcdefghijklmnopqrstuvwx', 1785360000]);
});

test('clipboard deletion locks ownership and records audit plus event', async () => {
  const manager = scriptedManager([
    [{ id: 51, user_id: 4, visibility: 'private' }],
    { affectedRows: 1 },
    { insertId: 101 }
  ]);
  let auditManager = null;
  const result = await content.deleteClipboard(manager, {
    clipboardId: 51,
    actorId: 4,
    ifMatch: () => true,
    recordAudit: async (event, currentManager) => {
      auditManager = currentManager;
      assert.equal(event.action, 'clipboard:delete');
      return '50';
    }
  });

  assert.deepEqual(result, { id: 51, deleted: true, auditEventId: '50', eventId: '101' });
  assert.equal(auditManager, manager);
  assert.match(manager.calls[0].sql, /FOR UPDATE/);
  assert.match(manager.calls[1].sql, /DELETE FROM clipboard_item/);
  assert.match(manager.calls[2].sql, /INSERT INTO api_v2_event/);
});

test('ticket ownership permits creators and managers but denies unrelated members', () => {
  const ticket = { creator_id: 4 };
  assert.equal(content.ticketAccess(ticket, 4, false), true);
  assert.equal(content.ticketAccess(ticket, 9, true), true);
  assert.equal(content.ticketAccess(ticket, 9, false), false);
});

test('ticket creation validates quota and persists relation metadata atomically', async () => {
  const manager = scriptedManager([
    [{ id: 4 }],
    [{ total: 4 }],
    [{ id: 12 }],
    { insertId: 8 },
    { insertId: 90 }
  ]);
  let auditManager = null;
  const result = await content.createTicket(manager, {
    creatorId: 4,
    isManager: false,
    category: 'problem',
    subtype: 'text_polish',
    title: 'Fix statement wording',
    description: '',
    relationId: 12,
    now: 1785360000,
    recordAudit: async (event, currentManager) => {
      auditManager = currentManager;
      assert.equal(event.action, 'ticket:create');
      return '43';
    }
  });
  assert.equal(result.id, 8);
  assert.equal(result.relationType, 'problem');
  assert.equal(result.relationId, 12);
  assert.equal(auditManager, manager);
  assert.match(manager.calls[0].sql, /user WHERE id=\? LIMIT 1 FOR UPDATE/);
  assert.match(manager.calls[1].sql, /COUNT\(\*\).*created_at>=\?/);
  assert.match(manager.calls[2].sql, /problem WHERE id=\? LIMIT 1 FOR UPDATE/);
  assert.match(manager.calls[3].sql, /relation_type,relation_id,extra_data/);
  assert.equal(manager.calls[3].params[3], '');
});

test('ticket creation enforces report metadata, type pairs, and the transactional daily limit', async () => {
  const limited = scriptedManager([[{ id: 4 }], [{ total: 5 }]]);
  await assert.rejects(
    content.createTicket(limited, {
      creatorId: 4, isManager: false, category: 'general', subtype: 'bug_suggest',
      title: 'Report a bug', description: '', now: 1785360000, recordAudit: async () => 'unused'
    }),
    error => error.code === 'TICKET_DAILY_LIMIT_REACHED' && error.statusCode === 429
  );
  assert.equal(limited.calls.length, 2);

  const invalid = scriptedManager([]);
  await assert.rejects(
    content.createTicket(invalid, {
      creatorId: 4, category: 'problem', subtype: 'user_report', title: 'Invalid pair', now: 1
    }),
    error => error.code === 'VALIDATION_FAILED' && !!error.fields.subtype
  );
  assert.equal(invalid.calls.length, 0);

  const report = scriptedManager([
    [{ id: 4 }],
    [{ total: 0 }],
    [{ id: 9 }],
    { insertId: 9 },
    { insertId: 91 }
  ]);
  await content.createTicket(report, {
    creatorId: 4, isManager: false, category: 'report', subtype: 'user_report',
    title: 'Report this account', description: 'Details', relationId: 9,
    reportReason: 'abusive content', now: 1785360000, recordAudit: async () => '44'
  });
  assert.equal(report.calls[3].params[7], JSON.stringify({ report_reason: 'abusive content' }));

  const manager = scriptedManager([[{ id: 4 }], { insertId: 10 }, { insertId: 92 }]);
  await content.createTicket(manager, {
    creatorId: 4, isManager: true, category: 'general', subtype: 'academic',
    title: 'Academic suggestion', description: '', now: 1785360000, recordAudit: async () => '45'
  });
  assert.equal(manager.calls.filter(call => /COUNT\(\*\)/.test(call.sql)).length, 0);
  assert.match(manager.calls[1].sql, /INSERT INTO ticket/);
});

test('ticket reply updates status and records its event through one manager', async () => {
  const manager = scriptedManager([
    [{ id: 8, title: 'Help', creator_id: 4, assignee_id: 9, status: 'pending' }],
    { insertId: 22 },
    { affectedRows: 1 },
    { insertId: 41 },
    { insertId: 91 },
    { insertId: 92 }
  ]);
  const result = await content.replyToTicket(manager, {
    ticketId: 8,
    actorId: 9,
    actorName: 'operator',
    isManager: true,
    content: 'Handled',
    now: 1785360000
  });

  assert.equal(result.status, 'in_progress');
  assert.match(manager.calls[0].sql, /ticket WHERE id=\? LIMIT 1 FOR UPDATE/);
  assert.match(manager.calls[1].sql, /INSERT INTO ticket_reply/);
  assert.deepEqual(manager.calls[2].params, [1785360000, 'in_progress', 8]);
  assert.match(manager.calls[3].sql, /INSERT INTO notification/);
  assert.match(manager.calls[4].sql, /INSERT INTO api_v2_event/);
  assert.match(manager.calls[5].sql, /INSERT INTO api_v2_event/);
  assert.equal(result.notificationId, 41);
});

test('closed and foreign tickets reject replies before any write', async () => {
  const closed = scriptedManager([[{ id: 8, creator_id: 4, status: 'closed' }]]);
  await assert.rejects(
    content.replyToTicket(closed, { ticketId: 8, actorId: 4, isManager: false, content: 'x', now: 1 }),
    error => error.code === 'TICKET_CLOSED'
  );
  assert.equal(closed.calls.length, 1);

  const foreign = scriptedManager([[{ id: 8, creator_id: 4, status: 'pending' }]]);
  await assert.rejects(
    content.replyToTicket(foreign, { ticketId: 8, actorId: 7, isManager: false, content: 'x', now: 1 }),
    error => error.code === 'TICKET_FORBIDDEN' && error.statusCode === 403
  );
  assert.equal(foreign.calls.length, 1);
});

test('ticket replies hide internal notes, require manager assignment, and reject all terminal states', async () => {
  const unassigned = scriptedManager([[{ id: 8, title: 'Help', creator_id: 4, assignee_id: null, status: 'pending' }]]);
  await assert.rejects(
    content.replyToTicket(unassigned, { ticketId: 8, actorId: 9, isManager: true, content: 'x', now: 1 }),
    error => error.code === 'TICKET_ASSIGNMENT_REQUIRED' && error.statusCode === 409
  );
  assert.equal(unassigned.calls.length, 1);

  for (const status of ['resolved', 'rejected']) {
    const terminal = scriptedManager([[{ id: 8, title: 'Help', creator_id: 4, assignee_id: null, status }]]);
    await assert.rejects(
      content.replyToTicket(terminal, { ticketId: 8, actorId: 4, isManager: false, content: 'x', now: 1 }),
      error => error.code === 'TICKET_CLOSED'
    );
    assert.equal(terminal.calls.length, 1);
  }

  const internal = scriptedManager([
    [{ id: 8, title: 'Help', creator_id: 4, assignee_id: 9, status: 'in_progress' }],
    { insertId: 23 },
    { affectedRows: 1 },
    { insertId: 93 }
  ]);
  const result = await content.replyToTicket(internal, {
    ticketId: 8, actorId: 9, actorName: 'operator', isManager: true,
    isInternal: true, content: 'staff only', now: 2
  });
  assert.equal(result.isInternal, true);
  assert.equal(result.notificationId, null);
  assert.equal(internal.calls.length, 4);
  assert.equal(internal.calls[1].params[3], 1);
});

test('ticket reply frontend prefers v2 and private replies are filtered from member reads', () => {
  const view = read('custom/views/ticket.ejs');
  const createView = read('custom/views/ticket_new.ejs');
  const shared = read('custom/views/ticket_v2_script.ejs');
  const route = read('custom/modules/_api_v2_content_domain.js');
  assert.match(view, /data-ticket-v2="reply"/);
  assert.match(createView, /data-ticket-v2="create"/);
  assert.match(shared, /fetch\('\/api\/v2\/tickets'/);
  assert.match(shared, /relation_id: form\.elements\.relation_id/);
  assert.match(shared, /report_reason: form\.elements\.report_reason/);
  assert.match(shared, /\/api\/v2\/tickets\/.*\/replies/);
  assert.match(shared, /is_internal: internal/);
  for (const action of ['close', 'assign', 'status', 'admin-close']) {
    assert.match(view, new RegExp('data-ticket-v2="' + action + '"'));
  }
  assert.match(shared, /\/api\/v2\/admin\/tickets\/.*\/status/);
  assert.match(shared, /\/api\/v2\/admin\/tickets\/.*\/close/);
  assert.doesNotMatch(shared, /API_DOMAIN_DISABLED/);
  assert.doesNotMatch(shared, /HTMLFormElement\.prototype\.submit\.call\(form\)/);
  assert.match(shared, /'Idempotency-Key': operationKey\(\)/);
  assert.match(route, /isManager \? '' : 'AND reply\.is_internal=0'/);
  assert.match(route, /is_internal: !!reply\.is_internal/);
  assert.match(route, /ticketManagerAccess\(user, row\)/);
  assert.match(route, /scope: `ticket:\$\{id\}`/);
  assert.match(route, /req\.body\.is_internal === true/);
  assert.match(route, /contentDomain\.setTicketStatus/);
  assert.match(route, /recentLoginSatisfied\(req\)/);
});

test('ticket assignment keeps update, timeline, audit, and event on the transaction manager', async () => {
  const manager = scriptedManager([
    [{ id: 8, creator_id: 4, assignee_id: null, status: 'pending' }],
    [{ id: 9 }],
    { affectedRows: 1 },
    { insertId: 22 },
    { insertId: 93 }
  ]);
  let auditManager = null;
  const result = await content.assignTicket(manager, {
    ticketId: 8,
    actorId: 5,
    assigneeId: 9,
    assigneeName: 'operator',
    isManager: true,
    now: 1785360000,
    recordAudit: async (event, currentManager) => {
      auditManager = currentManager;
      assert.equal(event.action, 'ticket:assign');
      return '44';
    }
  });

  assert.equal(auditManager, manager);
  assert.equal(result.auditEventId, '44');
  assert.equal(result.status, 'in_progress');
  assert.match(manager.calls[3].sql, /INSERT INTO ticket_reply/);
  assert.match(manager.calls[3].params[2], /operator 已认领此工单/);
  assert.match(manager.calls[4].sql, /INSERT INTO api_v2_event/);
});

test('ticket close enforces owner or manager access and records timeline, audit, and event', async () => {
  const manager = scriptedManager([
    [{ id: 8, title: 'Help', creator_id: 4, status: 'in_progress' }],
    { affectedRows: 1 },
    { insertId: 23 },
    { insertId: 94 }
  ]);
  let auditManager = null;
  const result = await content.closeTicket(manager, {
    ticketId: 8,
    actorId: 4,
    isManager: false,
    requireManager: false,
    now: 1785360000,
    recordAudit: async (event, currentManager) => {
      auditManager = currentManager;
      assert.equal(event.details.previous_status, 'in_progress');
      return '45';
    }
  });

  assert.equal(result.status, 'closed');
  assert.equal(auditManager, manager);
  assert.match(manager.calls[1].sql, /status='closed'/);
  assert.match(manager.calls[2].sql, /INSERT INTO ticket_reply/);
  assert.equal(manager.calls[2].params[2], '工单创建者已撤回此工单。');
  assert.match(manager.calls[3].sql, /INSERT INTO api_v2_event/);

  const foreign = scriptedManager([[{ id: 8, creator_id: 4, status: 'pending' }]]);
  await assert.rejects(
    content.closeTicket(foreign, {
      ticketId: 8,
      actorId: 7,
      isManager: false,
      requireManager: false,
      now: 1,
      recordAudit: async () => 'unused'
    }),
    error => error.code === 'TICKET_FORBIDDEN'
  );
  assert.equal(foreign.calls.length, 1);
});

test('ticket status transition records timeline, audit, creator notification, and domain events', async () => {
  const manager = scriptedManager([
    [{ id: 8, title: 'Help', creator_id: 4, assignee_id: 9, status: 'in_progress' }],
    { affectedRows: 1 },
    { insertId: 24 },
    { insertId: 71 },
    { insertId: 95 },
    { insertId: 96 }
  ]);
  let auditManager = null;
  const result = await content.setTicketStatus(manager, {
    ticketId: 8,
    actorId: 9,
    actorName: 'operator',
    isManager: true,
    status: 'resolved',
    now: 1785360000,
    recordAudit: async (event, currentManager) => {
      auditManager = currentManager;
      assert.equal(event.action, 'ticket:status.update');
      assert.deepEqual(event.details, { from: 'in_progress', to: 'resolved' });
      return '46';
    }
  });

  assert.equal(auditManager, manager);
  assert.equal(result.status, 'resolved');
  assert.equal(result.changed, true);
  assert.equal(result.notificationId, 71);
  assert.match(manager.calls[2].sql, /INSERT INTO ticket_reply/);
  assert.match(manager.calls[2].params[2], /处理中.*已处理/);
  assert.match(manager.calls[3].sql, /INSERT INTO notification/);
  assert.match(manager.calls[4].sql, /INSERT INTO api_v2_event/);
  assert.match(manager.calls[5].sql, /INSERT INTO api_v2_event/);

  const unassigned = scriptedManager([
    [{ id: 8, title: 'Help', creator_id: 4, assignee_id: null, status: 'pending' }]
  ]);
  await assert.rejects(
    content.setTicketStatus(unassigned, {
      ticketId: 8,
      actorId: 9,
      isManager: true,
      status: 'resolved',
      now: 1,
      recordAudit: async () => 'unused'
    }),
    error => error.code === 'TICKET_ASSIGNMENT_REQUIRED'
  );
  assert.equal(unassigned.calls.length, 1);
});

test('transaction rollback discards ticket writes when event persistence fails', async () => {
  const committed = [];
  const connection = {
    async transaction(work) {
      const staged = [];
      let call = 0;
      const manager = {
        async query(sql) {
          call += 1;
          if (call === 1) return [{ id: 8, creator_id: 4, status: 'pending' }];
          if (call === 2) { staged.push('reply'); return { insertId: 22 }; }
          if (call === 3) { staged.push('status'); return { affectedRows: 1 }; }
          if (/INSERT INTO api_v2_event/.test(sql)) throw new Error('event storage unavailable');
          throw new Error('unexpected query');
        }
      };
      try {
        const result = await work(manager);
        committed.push(...staged);
        return result;
      } catch (error) {
        staged.length = 0;
        throw error;
      }
    }
  };

  await assert.rejects(
    connection.transaction(manager => content.replyToTicket(manager, {
      ticketId: 8,
      actorId: 4,
      isManager: false,
      content: 'reply',
      now: 1
    })),
    /event storage unavailable/
  );
  assert.deepEqual(committed, []);
});

test('transaction rollback discards discussion reply and count when event persistence fails', async () => {
  const committed = [];
  const connection = {
    async transaction(work) {
      const staged = [];
      const manager = {
        async query(sql) {
          if (/FROM article/.test(sql) && /FOR UPDATE/.test(sql)) return [{ id: 30, allow_comment: 1 }];
          if (/INSERT INTO article_comment/.test(sql)) { staged.push('reply'); return { insertId: 41 }; }
          if (/UPDATE article SET/.test(sql)) { staged.push('count'); return { affectedRows: 1 }; }
          if (/INSERT INTO api_v2_event/.test(sql)) throw new Error('event storage unavailable');
          throw new Error('unexpected query');
        }
      };
      try {
        const result = await work(manager);
        committed.push(...staged);
        return result;
      } catch (error) {
        staged.length = 0;
        throw error;
      }
    }
  };

  await assert.rejects(
    connection.transaction(manager => content.replyToDiscussion(manager, {
      discussionId: 30,
      actorId: 4,
      content: 'reply',
      isModerator: false,
      now: 1
    })),
    /event storage unavailable/
  );
  assert.deepEqual(committed, []);
});

test('transaction rollback discards clipboard update and audit when event persistence fails', async () => {
  const committed = [];
  const connection = {
    async transaction(work) {
      const staged = [];
      const manager = {
        async query(sql) {
          if (/SELECT \* FROM clipboard_item/.test(sql)) {
            return [{ id: 51, user_id: 4, title: 'A', content: 'B', visibility: 'private', public_time: 1, update_time: 1 }];
          }
          if (/UPDATE clipboard_item/.test(sql)) { staged.push('clipboard'); return { affectedRows: 1 }; }
          if (/INSERT INTO auth_audit_event/.test(sql)) { staged.push('audit'); return { insertId: 51 }; }
          if (/INSERT INTO api_v2_event/.test(sql)) throw new Error('event storage unavailable');
          throw new Error('unexpected query');
        }
      };
      try {
        const result = await work(manager);
        committed.push(...staged);
        return result;
      } catch (error) {
        staged.length = 0;
        throw error;
      }
    }
  };

  await assert.rejects(
    connection.transaction(manager => content.updateClipboard(manager, {
      clipboardId: 51,
      actorId: 4,
      patch: { title: 'Changed' },
      now: 2,
      generateToken: () => 'abcdefghijklmnopqrstuvwx',
      recordAudit: async (_event, currentManager) => {
        assert.equal(currentManager, manager);
        const result = await currentManager.query('INSERT INTO auth_audit_event VALUES ()');
        return String(result.insertId);
      }
    })),
    /event storage unavailable/
  );
  assert.deepEqual(committed, []);
});

test('transaction rollback discards solution review, audit, and notification when event persistence fails', async () => {
  const committed = [];
  const connection = {
    async transaction(work) {
      const staged = [];
      const manager = {
        async query(sql) {
          if (/SELECT \* FROM problem_solution/.test(sql)) {
            return [{ id: 61, problem_id: 12, user_id: 4, title: 'Proof', status: 'pending' }];
          }
          if (/UPDATE problem_solution/.test(sql)) { staged.push('solution'); return { affectedRows: 1 }; }
          if (/INSERT INTO auth_audit_event/.test(sql)) { staged.push('audit'); return { insertId: 54 }; }
          if (/INSERT INTO notification/.test(sql)) { staged.push('notification'); return { insertId: 72 }; }
          if (/INSERT INTO api_v2_event/.test(sql)) throw new Error('event storage unavailable');
          throw new Error('unexpected query');
        }
      };
      try {
        const result = await work(manager);
        committed.push(...staged);
        return result;
      } catch (error) {
        staged.length = 0;
        throw error;
      }
    }
  };

  await assert.rejects(
    connection.transaction(manager => content.reviewSolution(manager, {
      solutionId: 61,
      reviewerId: 7,
      reviewerName: 'moderator',
      isModerator: true,
      decision: 'approved',
      now: 2,
      recordAudit: async (_event, currentManager) => {
        const result = await currentManager.query('INSERT INTO auth_audit_event VALUES ()');
        return String(result.insertId);
      }
    })),
    /event storage unavailable/
  );
  assert.deepEqual(committed, []);
});

test('transaction rollback discards announcement and audit when event persistence fails', async () => {
  const committed = [];
  const connection = {
    async transaction(work) {
      const staged = [];
      const manager = {
        async query(sql) {
          if (/INSERT INTO announcement/.test(sql)) { staged.push('announcement'); return { insertId: 81 }; }
          if (/INSERT INTO auth_audit_event/.test(sql)) { staged.push('audit'); return { insertId: 58 }; }
          if (/INSERT INTO api_v2_event/.test(sql)) throw new Error('event storage unavailable');
          throw new Error('unexpected query');
        }
      };
      try {
        const result = await work(manager);
        committed.push(...staged);
        return result;
      } catch (error) {
        staged.length = 0;
        throw error;
      }
    }
  };

  await assert.rejects(
    connection.transaction(manager => content.createAnnouncement(manager, {
      actorId: 7,
      value: {
        title: 'Notice', content: 'Body', level: 'info', start_time: 1,
        end_time: 2, is_active: true
      },
      now: 1,
      recordAudit: async (_event, currentManager) => {
        const result = await currentManager.query('INSERT INTO auth_audit_event VALUES ()');
        return String(result.insertId);
      }
    })),
    /event storage unavailable/
  );
  assert.deepEqual(committed, []);
});

test('content API routes use transactions and stable permission/error handling', () => {
  const route = read('custom/modules/_api_v2_content_domain.js');
  const userTagsView = read('custom/views/admin_user_tags.ejs');
  const workflow = read('custom/modules/_api_v2_problem_workflows.js');
  const admin = read('custom/modules/_api_v2_admin_domain.js');
  const authorization = read('custom/modules/_api_v2_authorization.js');

  assert.match(route, /function contentTransaction\(work\).*\.transaction\(work\)/);
  assert.match(route, /contentDomain\.markAllNotificationsRead/);
  assert.match(route, /contentDomain\.sendMessage/);
  assert.match(route, /contentDomain\.listConversations/);
  assert.match(route, /contentDomain\.createDiscussion/);
  assert.match(route, /contentDomain\.replyToDiscussion/);
  assert.match(route, /contentDomain\.setDiscussionLock/);
  assert.match(route, /function discussionVisibilityFilter/);
  assert.match(route, /LEFT JOIN problem ON problem\.id=article\.problem_id/);
  assert.match(route, /contentDomain\.createClipboard/);
  assert.match(route, /contentDomain\.updateClipboard/);
  assert.match(route, /contentDomain\.shareClipboard/);
  assert.match(route, /contentDomain\.deleteClipboard/);
  assert.match(route, /app\.get\('\/api\/v2\/admin\/user-tags'/);
  assert.match(route, /app\.post\('\/api\/v2\/admin\/user-tags\/grants'/);
  assert.match(route, /app\.post\('\/api\/v2\/admin\/user-tags\/:id\/disable'/);
  assert.match(route, /app\.get\('\/api\/v2\/admin\/user-tags\/settings'/);
  assert.match(route, /app\.patch\('\/api\/v2\/admin\/user-tags\/settings'/);
  assert.match(route, /contentDomain\.grantUserTag/);
  assert.match(route, /contentDomain\.disableUserTag/);
  assert.match(route, /contentDomain\.updateUserTagGlobalSetting/);
  assert.match(route, /api\(\)\.ifMatch\(req, userTagSettingResource\(current\)\)/);
  assert.match(route, /api\(\)\.setResourceEtag\(res, resource\)/);
  assert.match(route, /refreshUserTagsCache/);
  assert.match(userTagsView, /data-user-tag-v2="grant"/);
  assert.match(userTagsView, /data-user-tag-v2="restore"/);
  assert.match(userTagsView, /data-user-tag-v2="disable"/);
  assert.match(userTagsView, /\/api\/v2\/admin\/user-tags\/grants/);
  assert.doesNotMatch(userTagsView, /API_DOMAIN_DISABLED/);
  assert.match(userTagsView, /data-user-tags-global-toggle/);
  assert.match(userTagsView, /\/api\/v2\/admin\/user-tags\/settings/);
  assert.match(userTagsView, /'If-Match': settingsEtag/);
  assert.match(userTagsView, /include admin_footer/);
  assert.doesNotMatch(userTagsView, /include footer/);
  assert.match(route, /contentDomain\.replyToTicket/);
  assert.match(route, /contentDomain\.assignTicket/);
  assert.match(route, /contentDomain\.setTicketStatus/);
  assert.match(route, /contentDomain\.closeTicket/);
  assert.match(route, /current => api\(\)\.ifMatch\(req, serializeClipboard\(current\)\)/);
  assert.doesNotMatch(route, /ClipboardItem\.(?:create|findById|findOne)/);
  assert.doesNotMatch(route, /item\.(?:save|destroy)\(\)/);
  assert.equal((route.match(/Capability required: clipboard:own\./g) || []).length, 6);
  assert.match(route, /TICKET_ASSIGNEE_INELIGIBLE/);
  assert.match(route, /ticketManagerAccess\(assignee, accessRows\[0\]\)/);
  assert.match(route, /RECENT_LOGIN_REQUIRED/);
  assert.doesNotMatch(route, /read_at=UTC_TIMESTAMP\(\)/);
  assert.match(route, /expected \? error\.code : 'CONTENT_WRITE_FAILED'/);
  assert.match(workflow, /contentDomain\.createSolution/);
  assert.match(workflow, /contentDomain\.updateSolution/);
  assert.match(workflow, /contentDomain\.createSolutionComment/);
  assert.match(workflow, /contentDomain\.submitSolutionReview/);
  assert.match(workflow, /contentDomain\.reviewSolution/);
  assert.match(workflow, /solution\.status='accepted'/);
  assert.match(workflow, /contentDomain\.apiSolutionStatus/);
  assert.match(workflow, /app\.get\('\/api\/v2\/solutions\/:id'/);
  assert.match(workflow, /app\.patch\('\/api\/v2\/solutions\/:id'/);
  assert.match(workflow, /app\.post\('\/api\/v2\/solutions\/:id\/comments'/);
  assert.match(workflow, /current => api\(\)\.ifMatch\(req, solutionRevision\(current\)\)/);
  assert.match(workflow, /setResourceEtag\(res, solutionRevision\(visible\.row\)\)/);
  assert.doesNotMatch(workflow, /SET status=\?,reject_reason=\?.*status='pending'/);
  assert.match(admin, /contentDomain\.createAnnouncement/);
  assert.match(admin, /contentDomain\.updateAnnouncement/);
  assert.match(admin, /contentDomain\.deleteAnnouncement/);
  assert.match(admin, /contentDomain\.createBanner/);
  assert.match(admin, /contentDomain\.updateBanner/);
  assert.match(admin, /contentDomain\.deleteBanner/);
  assert.match(admin, /current => api\(\)\.ifMatch\(req, announcementResource\(current\)\)/);
  assert.match(admin, /current => api\(\)\.ifMatch\(req, bannerResource\(current\)\)/);
  assert.doesNotMatch(admin, /await api\(\)\.appendEvent\(\{ stream: `content:(?:announcement|banner)/);
  assert.match(authorization, /async function recordAudit\(req, event, manager = null\)/);
  assert.match(authorization, /const queryable = manager \|\| TypeORM\.getConnection\(\)/);
});
