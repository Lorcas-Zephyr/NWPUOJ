'use strict';

function contentError(code, message, statusCode = 409, fields = {}) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  error.fields = fields;
  return error;
}

function positiveId(value, field) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw contentError('VALIDATION_FAILED', `${field} must be a positive integer.`, 422, {
      [field]: 'positive integer required'
    });
  }
  return id;
}

function requiredText(value, field, maximum) {
  const text = String(value == null ? '' : value).trim();
  if (!text) {
    throw contentError('VALIDATION_FAILED', `${field} is required.`, 422, { [field]: 'required' });
  }
  if (maximum && text.length > maximum) {
    throw contentError('VALIDATION_FAILED', `${field} is too long.`, 422, {
      [field]: `maximum ${maximum} characters`
    });
  }
  return text;
}

function ticketAccess(ticket, actorId, isManager) {
  return !!ticket && (isManager || Number(ticket.creator_id) === Number(actorId));
}

const TICKET_TYPE_RULES = Object.freeze({
  problem: Object.freeze({ relation: 'problem', required: true, subtypes: Object.freeze(['general', 'text_polish', 'tag_diff']) }),
  contest: Object.freeze({ relation: 'contest', required: true, subtypes: Object.freeze(['general']) }),
  article: Object.freeze({ relation: 'article', required: true, subtypes: Object.freeze(['recommend_apply', 'recommend_revoke']) }),
  user: Object.freeze({ relation: 'user', required: false, subtypes: Object.freeze(['appeal', 'privilege_change', 'unban']) }),
  report: Object.freeze({ relation: 'user', required: true, subtypes: Object.freeze(['user_report']) }),
  general: Object.freeze({ relation: null, required: false, subtypes: Object.freeze(['bug_suggest', 'academic', 'general_inquiry']) })
});
const TICKET_STATUS_LABELS = Object.freeze({
  pending: '待处理', in_progress: '处理中', resolved: '已处理', rejected: '已驳回', closed: '已关闭'
});

function ticketTypeRule(category, subtype) {
  const rule = TICKET_TYPE_RULES[category];
  if (!rule) {
    throw contentError('VALIDATION_FAILED', 'Ticket category is invalid.', 422, { category: 'unsupported category' });
  }
  if (!rule.subtypes.includes(subtype)) {
    throw contentError('VALIDATION_FAILED', 'Ticket subtype is invalid.', 422, { subtype: 'unsupported subtype' });
  }
  return rule;
}

async function appendEvent(manager, input) {
  const result = await manager.query(
    `INSERT INTO api_v2_event
      (stream,type,aggregate_id,actor_id,payload_json,created_at)
     VALUES (?,?,?,?,?,UTC_TIMESTAMP(3))`,
    [
      input.stream,
      input.type,
      input.aggregateId == null ? null : String(input.aggregateId),
      input.actorId == null ? null : Number(input.actorId),
      JSON.stringify(input.payload || {})
    ]
  );
  return String(result.insertId);
}

async function markAllNotificationsRead(manager, input) {
  const userId = positiveId(input.userId, 'user_id');
  const now = Number(input.now);
  const result = await manager.query(
    'UPDATE notification SET is_read=1,read_at=? WHERE recipient_id=? AND is_read=0',
    [now, userId]
  );
  const updated = Number(result.affectedRows || 0);
  const eventId = await appendEvent(manager, {
    stream: `notifications:user:${userId}`,
    type: 'notifications.read_all',
    aggregateId: userId,
    actorId: userId,
    payload: { updated, read_at: now }
  });
  return { updated, eventId };
}

async function markNotificationRead(manager, input) {
  const notificationId = positiveId(input.notificationId, 'notification_id');
  const userId = positiveId(input.userId, 'user_id');
  const now = Number(input.now);
  const rows = await manager.query(
    'SELECT id,source_url,is_read,read_at FROM notification WHERE id=? AND recipient_id=? LIMIT 1 FOR UPDATE',
    [notificationId, userId]
  );
  if (!rows.length) throw contentError('NOTIFICATION_NOT_FOUND', 'Notification was not found.', 404);
  const current = rows[0];
  const updated = current.is_read ? 0 : 1;
  if (updated) {
    await manager.query('UPDATE notification SET is_read=1,read_at=? WHERE id=? AND recipient_id=?', [now, notificationId, userId]);
  }
  const eventId = updated ? await appendEvent(manager, {
    stream: `notifications:user:${userId}`,
    type: 'notification.read',
    aggregateId: notificationId,
    actorId: userId,
    payload: { notification_id: notificationId, read_at: now }
  }) : null;
  return {
    id: notificationId,
    sourceUrl: current.source_url || null,
    readAt: updated ? now : Number(current.read_at || now),
    updated,
    eventId
  };
}

async function deleteNotification(manager, input) {
  const notificationId = positiveId(input.notificationId, 'notification_id');
  const userId = positiveId(input.userId, 'user_id');
  const rows = await manager.query(
    'SELECT id FROM notification WHERE id=? AND recipient_id=? LIMIT 1 FOR UPDATE',
    [notificationId, userId]
  );
  if (!rows.length) throw contentError('NOTIFICATION_NOT_FOUND', 'Notification was not found.', 404);
  await manager.query('DELETE FROM notification WHERE id=? AND recipient_id=?', [notificationId, userId]);
  const eventId = await appendEvent(manager, {
    stream: `notifications:user:${userId}`,
    type: 'notification.deleted',
    aggregateId: notificationId,
    actorId: userId,
    payload: { notification_id: notificationId }
  });
  return { id: notificationId, deleted: true, eventId };
}

async function sendMessage(manager, input) {
  const senderId = positiveId(input.senderId, 'sender_id');
  const receiverId = positiveId(input.receiverId, 'receiver_id');
  if (senderId === receiverId) {
    throw contentError('VALIDATION_FAILED', 'A message cannot be sent to the same user.', 422, {
      receiver_id: 'must differ from sender'
    });
  }
  const content = requiredText(input.content, 'content', 5000);
  const receivers = await manager.query('SELECT id FROM user WHERE id=? LIMIT 1 FOR UPDATE', [receiverId]);
  if (!receivers.length) {
    throw contentError('MESSAGE_RECIPIENT_NOT_FOUND', 'The recipient was not found.', 404);
  }
  const settings = await manager.query(
    'SELECT disable_messages FROM user_message_setting WHERE user_id=? LIMIT 1 FOR UPDATE',
    [receiverId]
  );
  if (!input.bypassRecipientPolicy && settings[0] && settings[0].disable_messages) {
    throw contentError('MESSAGES_DISABLED', 'The recipient is not accepting messages.', 409);
  }
  const result = await manager.query(
    `INSERT INTO private_message
      (sender_id,receiver_id,content,public_time,is_read,sender_deleted,receiver_deleted)
     VALUES (?,?,?,?,0,0,0)`,
    [senderId, receiverId, content, Number(input.now)]
  );
  const messageId = Number(result.insertId);
  const participants = [senderId, receiverId].sort((left, right) => left - right);
  const eventId = await appendEvent(manager, {
    stream: `message:conversation:${participants[0]}:${participants[1]}`,
    type: 'message.sent',
    aggregateId: messageId,
    actorId: senderId,
    payload: { message_id: messageId, sender_id: senderId, receiver_id: receiverId }
  });
  return { id: messageId, senderId, receiverId, content, eventId };
}

async function listConversations(manager, input) {
  const userId = positiveId(input.userId, 'user_id');
  const limit = Number(input.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw contentError('VALIDATION_FAILED', 'Conversation limit is invalid.', 422, {
      limit: 'integer from 1 to 100'
    });
  }
  let cursor = null;
  if (input.cursor != null) {
    const lastTime = Number(input.cursor.last_time);
    const peerId = Number(input.cursor.user_id);
    if (!Number.isSafeInteger(lastTime) || lastTime < 0 || !Number.isSafeInteger(peerId) || peerId < 1) {
      throw contentError('INVALID_CURSOR', 'The conversation cursor is invalid.', 400);
    }
    cursor = { last_time: lastTime, user_id: peerId };
  }
  const cursorSql = cursor ? 'WHERE (conversation.last_time<? OR (conversation.last_time=? AND conversation.user_id<?))' : '';
  const params = [userId, userId, userId, userId];
  if (cursor) params.push(cursor.last_time, cursor.last_time, cursor.user_id);
  params.push(limit + 1);
  const rows = await manager.query(
    `SELECT conversation.user_id,peer.username,conversation.last_time,conversation.unread
       FROM (
         SELECT CASE WHEN message.sender_id=? THEN message.receiver_id ELSE message.sender_id END AS user_id,
                MAX(message.public_time) AS last_time,
                SUM(message.receiver_id=? AND message.is_read=0 AND message.receiver_deleted=0) AS unread
           FROM private_message message
          WHERE (message.sender_id=? AND message.sender_deleted=0)
             OR (message.receiver_id=? AND message.receiver_deleted=0)
          GROUP BY CASE WHEN message.sender_id=? THEN message.receiver_id ELSE message.sender_id END
       ) conversation
       INNER JOIN user peer ON peer.id=conversation.user_id
       ${cursorSql}
      ORDER BY conversation.last_time DESC,conversation.user_id DESC
      LIMIT ?`,
    [userId, ...params]
  );
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    rows: page,
    nextCursor: rows.length > limit && last
      ? { last_time: Number(last.last_time), user_id: Number(last.user_id) }
      : null
  };
}

async function readConversation(manager, input) {
  const userId = positiveId(input.userId, 'user_id');
  const peerId = positiveId(input.peerId, 'peer_id');
  if (userId === peerId) {
    throw contentError('VALIDATION_FAILED', 'A conversation requires another user.', 422, {
      peer_id: 'must differ from user'
    });
  }
  const peers = await manager.query('SELECT id FROM user WHERE id=? LIMIT 1', [peerId]);
  if (!peers.length) throw contentError('MESSAGE_RECIPIENT_NOT_FOUND', 'The user was not found.', 404);
  const limit = input.limit == null ? 100 : Number(input.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw contentError('VALIDATION_FAILED', 'Message limit is invalid.', 422, {
      limit: 'integer from 1 to 200'
    });
  }
  const beforeId = input.beforeId == null ? null : Number(input.beforeId);
  if (beforeId != null && (!Number.isSafeInteger(beforeId) || beforeId < 1)) {
    throw contentError('INVALID_CURSOR', 'The message cursor is invalid.', 400);
  }
  const rows = await manager.query(
    `SELECT id,sender_id,receiver_id,content,public_time,is_read
       FROM private_message
      WHERE ((sender_id=? AND receiver_id=? AND sender_deleted=0)
         OR (sender_id=? AND receiver_id=? AND receiver_deleted=0))
        ${beforeId == null ? '' : 'AND id<?'}
      ORDER BY id DESC LIMIT ? FOR UPDATE`,
    beforeId == null
      ? [userId, peerId, peerId, userId, limit + 1]
      : [userId, peerId, peerId, userId, beforeId, limit + 1]
  );
  const result = await manager.query(
    'UPDATE private_message SET is_read=1 WHERE sender_id=? AND receiver_id=? AND is_read=0',
    [peerId, userId]
  );
  const updated = Number(result.affectedRows || 0);
  let eventId = null;
  if (updated) {
    const participants = [userId, peerId].sort((left, right) => left - right);
    eventId = await appendEvent(manager, {
      stream: `message:conversation:${participants[0]}:${participants[1]}`,
      type: 'message.read',
      aggregateId: userId,
      actorId: userId,
      payload: { reader_id: userId, sender_id: peerId, updated }
    });
  }
  return {
    rows: rows.slice(0, limit).reverse().map(row => Object.assign({}, row, {
      is_read: Number(row.receiver_id) === userId ? 1 : row.is_read
    })),
    updated,
    eventId,
    nextCursor: rows.length > limit ? Number(rows[limit - 1].id) : null
  };
}

async function deleteMessageForUser(manager, input) {
  const messageId = positiveId(input.messageId, 'message_id');
  const userId = positiveId(input.userId, 'user_id');
  const rows = await manager.query(
    'SELECT id,sender_id,receiver_id,sender_deleted,receiver_deleted FROM private_message WHERE id=? LIMIT 1 FOR UPDATE',
    [messageId]
  );
  if (!rows.length) throw contentError('MESSAGE_NOT_FOUND', 'The message was not found.', 404);
  const message = rows[0];
  const isSender = Number(message.sender_id) === userId;
  const isReceiver = Number(message.receiver_id) === userId;
  if (!isSender && !isReceiver) throw contentError('MESSAGE_FORBIDDEN', 'You cannot delete this message.', 403);
  const senderDeleted = !!message.sender_deleted || isSender;
  const receiverDeleted = !!message.receiver_deleted || isReceiver;
  if (senderDeleted && receiverDeleted) {
    await manager.query('DELETE FROM private_message WHERE id=?', [messageId]);
  } else {
    await manager.query('UPDATE private_message SET sender_deleted=?,receiver_deleted=? WHERE id=?', [senderDeleted ? 1 : 0, receiverDeleted ? 1 : 0, messageId]);
  }
  const peerId = isSender ? Number(message.receiver_id) : Number(message.sender_id);
  const participants = [userId, peerId].sort((left, right) => left - right);
  const eventId = await appendEvent(manager, {
    stream: `message:conversation:${participants[0]}:${participants[1]}`,
    type: 'message.deleted_for_user',
    aggregateId: messageId,
    actorId: userId,
    payload: { message_id: messageId, user_id: userId, peer_id: peerId, permanently_deleted: senderDeleted && receiverDeleted }
  });
  return { id: messageId, peerId, permanentlyDeleted: senderDeleted && receiverDeleted, eventId };
}

async function deleteConversationForUser(manager, input) {
  const userId = positiveId(input.userId, 'user_id');
  const peerId = positiveId(input.peerId, 'peer_id');
  if (userId === peerId) throw contentError('VALIDATION_FAILED', 'A conversation requires another user.', 422, { peer_id: 'must differ from user' });
  const sent = await manager.query(
    'UPDATE private_message SET sender_deleted=1 WHERE sender_id=? AND receiver_id=? AND sender_deleted=0',
    [userId, peerId]
  );
  const received = await manager.query(
    'UPDATE private_message SET receiver_deleted=1 WHERE sender_id=? AND receiver_id=? AND receiver_deleted=0',
    [peerId, userId]
  );
  const deleted = Number(sent.affectedRows || 0) + Number(received.affectedRows || 0);
  const participants = [userId, peerId].sort((left, right) => left - right);
  const eventId = await appendEvent(manager, {
    stream: `message:conversation:${participants[0]}:${participants[1]}`,
    type: 'message.conversation_deleted_for_user',
    aggregateId: userId,
    actorId: userId,
    payload: { user_id: userId, peer_id: peerId, deleted }
  });
  return { peerId, deleted, eventId };
}

async function updateMessageSettings(manager, input) {
  const userId = positiveId(input.userId, 'user_id');
  const disabled = !!input.disabled;
  const now = Number(input.now);
  const rows = await manager.query(
    'SELECT disable_messages,update_time FROM user_message_setting WHERE user_id=? LIMIT 1 FOR UPDATE',
    [userId]
  );
  const current = rows[0] || { disable_messages: 0, update_time: null };
  if (input.ifMatch && !input.ifMatch(current)) {
    throw contentError('ETAG_MISMATCH', 'Message settings changed. Refresh them and try again.', 412);
  }
  await manager.query(
    `INSERT INTO user_message_setting (user_id,disable_messages,update_time)
     VALUES (?,?,?)
     ON DUPLICATE KEY UPDATE
       disable_messages=VALUES(disable_messages),update_time=VALUES(update_time)`,
    [userId, disabled ? 1 : 0, now]
  );
  const eventId = await appendEvent(manager, {
    stream: `message-settings:user:${userId}`,
    type: 'message.settings.updated',
    aggregateId: userId,
    actorId: userId,
    payload: { disable_messages: disabled, updated_at: now }
  });
  return { disabled, now, eventId };
}

async function createTicket(manager, input) {
  const creatorId = positiveId(input.creatorId, 'creator_id');
  const title = requiredText(input.title, 'title', 200);
  const category = requiredText(input.category || 'general', 'category', 20);
  const subtype = requiredText(input.subtype || 'general', 'subtype', 60);
  const rule = ticketTypeRule(category, subtype);
  if (title.length < 5) {
    throw contentError('VALIDATION_FAILED', 'Ticket title is too short.', 422, { title: 'minimum 5 characters' });
  }
  const description = String(input.description == null ? '' : input.description).trim();
  if (description.length > 100000) {
    throw contentError('VALIDATION_FAILED', 'Ticket description is too long.', 422, { description: 'maximum 100000 characters' });
  }
  const now = Number(input.now);
  await manager.query('SELECT id FROM user WHERE id=? LIMIT 1 FOR UPDATE', [creatorId]);
  if (!input.isManager) {
    const counts = await manager.query(
      'SELECT COUNT(*) AS total FROM ticket WHERE creator_id=? AND created_at>=?',
      [creatorId, now - 86400]
    );
    if (Number(counts[0] && counts[0].total || 0) >= 5) {
      throw contentError('TICKET_DAILY_LIMIT_REACHED', 'The daily ticket creation limit has been reached.', 429);
    }
  }
  let relationId = input.relationId == null || input.relationId === '' ? null : positiveId(input.relationId, 'relation_id');
  if (category === 'user' && relationId == null) relationId = creatorId;
  if (rule.required && relationId == null) {
    throw contentError('VALIDATION_FAILED', 'A related resource is required.', 422, { relation_id: 'required' });
  }
  if (relationId != null && rule.relation) {
    const relationTables = { problem: 'problem', contest: 'contest', article: 'article', user: 'user' };
    const rows = await manager.query(`SELECT id FROM ${relationTables[rule.relation]} WHERE id=? LIMIT 1 FOR UPDATE`, [relationId]);
    if (!rows.length) {
      throw contentError('VALIDATION_FAILED', 'The related resource was not found.', 422, { relation_id: 'not found' });
    }
  }
  let extraData = null;
  if (category === 'report') {
    const reportReason = requiredText(input.reportReason, 'report_reason', 5000);
    extraData = JSON.stringify({ report_reason: reportReason });
  }
  const result = await manager.query(
    `INSERT INTO ticket
      (category,subtype,title,description,creator_id,assignee_id,status,relation_type,relation_id,extra_data,is_public,created_at,updated_at)
     VALUES (?,?,?,?,?,NULL,'pending',?,?,?,0,?,?)`,
    [category, subtype, title, description, creatorId, rule.relation, relationId, extraData, now, now]
  );
  const ticketId = Number(result.insertId);
  const auditEventId = await input.recordAudit({
    action: 'ticket:create',
    resourceType: 'ticket',
    resourceId: ticketId
  }, manager);
  const eventId = await appendEvent(manager, {
    stream: `ticket:${ticketId}`,
    type: 'ticket.created',
    aggregateId: ticketId,
    actorId: creatorId,
    payload: { ticket_id: ticketId, category, audit_event_id: auditEventId }
  });
  return { id: ticketId, title, status: 'pending', category, subtype, relationType: rule.relation, relationId, now, auditEventId, eventId };
}

async function replyToTicket(manager, input) {
  const ticketId = positiveId(input.ticketId, 'ticket_id');
  const actorId = positiveId(input.actorId, 'actor_id');
  const content = requiredText(input.content, 'content', 50000);
  const tickets = await manager.query(
    'SELECT id,title,creator_id,assignee_id,status FROM ticket WHERE id=? LIMIT 1 FOR UPDATE',
    [ticketId]
  );
  if (!tickets.length) throw contentError('TICKET_NOT_FOUND', 'Ticket was not found.', 404);
  const ticket = tickets[0];
  if (!ticketAccess(ticket, actorId, input.isManager)) {
    throw contentError('TICKET_FORBIDDEN', 'You cannot reply to this ticket.', 403);
  }
  if (['closed', 'rejected', 'resolved'].includes(ticket.status)) {
    throw contentError('TICKET_CLOSED', 'A completed ticket cannot receive replies.', 409);
  }
  const isCreator = Number(ticket.creator_id) === actorId;
  if (input.isManager && !isCreator && Number(ticket.assignee_id) !== actorId) {
    throw contentError('TICKET_ASSIGNMENT_REQUIRED', 'Assign the ticket to yourself before replying.', 409);
  }
  const isInternal = !!input.isManager && !!input.isInternal;
  const now = Number(input.now);
  const result = await manager.query(
    'INSERT INTO ticket_reply (ticket_id,user_id,content,is_internal,is_status_change,created_at) VALUES (?,?,?, ?,0,?)',
    [ticketId, actorId, content, isInternal ? 1 : 0, now]
  );
  const nextStatus = input.isManager && !isCreator && ticket.status === 'pending' ? 'in_progress' : ticket.status;
  await manager.query('UPDATE ticket SET updated_at=?,status=? WHERE id=?', [now, nextStatus, ticketId]);
  const replyId = Number(result.insertId);
  let notificationId = null;
  let notificationEventId = null;
  if (!isInternal && !isCreator) {
    const preview = content.length > 100 ? content.substring(0, 100) + '...' : content;
    const notification = await manager.query(
      `INSERT INTO notification
        (recipient_id,type,title,content,source_url,source_id,actor_id,is_read,created_at,read_at)
       VALUES (?,?,?,?,?,?,?,0,?,NULL)`,
      [
        Number(ticket.creator_id), 'ticket_replied', `您的工单《${ticket.title}》收到新回复`,
        `${input.actorName || actorId}：${preview}`, `/ticket/${ticketId}`, ticketId, actorId, now
      ]
    );
    notificationId = Number(notification.insertId);
    notificationEventId = await appendEvent(manager, {
      stream: `notifications:user:${Number(ticket.creator_id)}`,
      type: 'notification.created',
      aggregateId: notificationId,
      actorId,
      payload: { notification_id: notificationId, source_type: 'ticket', source_id: ticketId }
    });
  }
  const eventId = await appendEvent(manager, {
    stream: `ticket:${ticketId}`,
    type: 'ticket.reply.created',
    aggregateId: ticketId,
    actorId,
    payload: {
      ticket_id: ticketId,
      reply_id: replyId,
      previous_status: ticket.status,
      status: nextStatus,
      is_internal: isInternal,
      notification_id: notificationId
    }
  });
  return { id: replyId, ticketId, content, now, status: nextStatus, isInternal, notificationId, notificationEventId, eventId };
}

async function assignTicket(manager, input) {
  const ticketId = positiveId(input.ticketId, 'ticket_id');
  const actorId = positiveId(input.actorId, 'actor_id');
  const assigneeId = positiveId(input.assigneeId, 'assignee_id');
  if (!input.isManager) throw contentError('TICKET_FORBIDDEN', 'You cannot assign this ticket.', 403);
  const tickets = await manager.query(
    'SELECT id,creator_id,assignee_id,status FROM ticket WHERE id=? LIMIT 1 FOR UPDATE',
    [ticketId]
  );
  if (!tickets.length) throw contentError('TICKET_NOT_FOUND', 'Ticket was not found.', 404);
  if (tickets[0].status === 'closed') {
    throw contentError('TICKET_CLOSED', 'A closed ticket cannot be reassigned.', 409);
  }
  const assignees = await manager.query('SELECT id FROM user WHERE id=? LIMIT 1 FOR UPDATE', [assigneeId]);
  if (!assignees.length) {
    throw contentError('VALIDATION_FAILED', 'The assignee was not found.', 422, {
      assignee_id: 'unknown user'
    });
  }
  const previousStatus = tickets[0].status;
  const nextStatus = previousStatus === 'pending' ? 'in_progress' : previousStatus;
  await manager.query(
    'UPDATE ticket SET assignee_id=?,status=?,updated_at=? WHERE id=?',
    [assigneeId, nextStatus, Number(input.now), ticketId]
  );
  const assignmentCopy = tickets[0].assignee_id && Number(tickets[0].assignee_id) !== assigneeId
    ? `工单已转交给 ${input.assigneeName || assigneeId} 处理。`
    : `${input.assigneeName || assigneeId} 已认领此工单。`;
  await manager.query(
    'INSERT INTO ticket_reply (ticket_id,user_id,content,is_internal,is_status_change,created_at) VALUES (?,?,?,0,1,?)',
    [ticketId, actorId, assignmentCopy, Number(input.now)]
  );
  const auditEventId = await input.recordAudit({
    action: 'ticket:assign',
    resourceType: 'ticket',
    resourceId: ticketId,
    reason: input.reason || null,
    details: {
      previous_assignee_id: tickets[0].assignee_id,
      assignee_id: assigneeId,
      previous_status: previousStatus,
      status: nextStatus
    }
  }, manager);
  const eventId = await appendEvent(manager, {
    stream: `ticket:${ticketId}`,
    type: 'ticket.assigned',
    aggregateId: ticketId,
    actorId,
    payload: { ticket_id: ticketId, assignee_id: assigneeId, status: nextStatus, audit_event_id: auditEventId }
  });
  return { id: ticketId, assigneeId, status: nextStatus, auditEventId, eventId };
}

async function closeTicket(manager, input) {
  const ticketId = positiveId(input.ticketId, 'ticket_id');
  const actorId = positiveId(input.actorId, 'actor_id');
  const tickets = await manager.query(
    'SELECT id,title,creator_id,status FROM ticket WHERE id=? LIMIT 1 FOR UPDATE',
    [ticketId]
  );
  if (!tickets.length) throw contentError('TICKET_NOT_FOUND', 'Ticket was not found.', 404);
  const ticket = tickets[0];
  if (!ticketAccess(ticket, actorId, input.isManager) || (input.requireManager && !input.isManager)) {
    throw contentError('TICKET_FORBIDDEN', 'You cannot close this ticket.', 403);
  }
  if (ticket.status === 'closed') {
    throw contentError('TICKET_ALREADY_CLOSED', 'The ticket is already closed.', 409);
  }
  await manager.query("UPDATE ticket SET status='closed',updated_at=? WHERE id=?", [Number(input.now), ticketId]);
  const creatorClose = Number(ticket.creator_id) === actorId && !input.requireManager;
  await manager.query(
    'INSERT INTO ticket_reply (ticket_id,user_id,content,is_internal,is_status_change,created_at) VALUES (?,?,?,0,1,?)',
    [ticketId, actorId, creatorClose ? '工单创建者已撤回此工单。' : '工单由管理员关闭。', Number(input.now)]
  );
  const auditEventId = await input.recordAudit({
    action: 'ticket:close',
    resourceType: 'ticket',
    resourceId: ticketId,
    reason: input.reason || null,
    details: { previous_status: ticket.status }
  }, manager);
  const eventId = await appendEvent(manager, {
    stream: `ticket:${ticketId}`,
    type: 'ticket.closed',
    aggregateId: ticketId,
    actorId,
    payload: { ticket_id: ticketId, previous_status: ticket.status, audit_event_id: auditEventId }
  });
  return { id: ticketId, status: 'closed', auditEventId, eventId };
}

async function setTicketStatus(manager, input) {
  const ticketId = positiveId(input.ticketId, 'ticket_id');
  const actorId = positiveId(input.actorId, 'actor_id');
  const status = String(input.status || '');
  if (!Object.prototype.hasOwnProperty.call(TICKET_STATUS_LABELS, status) || status === 'closed' || status === 'pending') {
    throw contentError('VALIDATION_FAILED', 'Ticket status is invalid.', 422, {
      status: 'in_progress, resolved, or rejected required'
    });
  }
  if (!input.isManager) throw contentError('TICKET_FORBIDDEN', 'You cannot change this ticket status.', 403);
  const rows = await manager.query(
    'SELECT id,title,creator_id,assignee_id,status FROM ticket WHERE id=? LIMIT 1 FOR UPDATE',
    [ticketId]
  );
  if (!rows.length) throw contentError('TICKET_NOT_FOUND', 'Ticket was not found.', 404);
  const ticket = rows[0];
  if (Number(ticket.assignee_id) !== actorId) {
    throw contentError('TICKET_ASSIGNMENT_REQUIRED', 'Assign the ticket to yourself before changing its status.', 409);
  }
  if (ticket.status === status) {
    return { id: ticketId, status, changed: false, auditEventId: null, notificationId: null, notificationEventId: null, eventId: null };
  }
  const now = Number(input.now);
  await manager.query('UPDATE ticket SET status=?,updated_at=? WHERE id=?', [status, now, ticketId]);
  await manager.query(
    'INSERT INTO ticket_reply (ticket_id,user_id,content,is_internal,is_status_change,created_at) VALUES (?,?,?,0,1,?)',
    [
      ticketId, actorId,
      `工单状态由「${TICKET_STATUS_LABELS[ticket.status] || ticket.status}」变更为「${TICKET_STATUS_LABELS[status]}」。`,
      now
    ]
  );
  const auditEventId = await input.recordAudit({
    action: 'ticket:status.update',
    resourceType: 'ticket',
    resourceId: ticketId,
    reason: input.reason || null,
    details: { from: ticket.status, to: status }
  }, manager);
  let notificationId = null;
  let notificationEventId = null;
  if (Number(ticket.creator_id) !== actorId) {
    const notification = await manager.query(
      `INSERT INTO notification
        (recipient_id,type,title,content,source_url,source_id,actor_id,is_read,created_at,read_at)
       VALUES (?,?,?,?,?,?,?,0,?,NULL)`,
      [
        Number(ticket.creator_id), 'ticket_status_changed',
        `您的工单《${ticket.title}》状态已变为：${TICKET_STATUS_LABELS[status]}`,
        `操作员：${input.actorName || actorId}`, `/ticket/${ticketId}`, ticketId, actorId, now
      ]
    );
    notificationId = Number(notification.insertId);
    notificationEventId = await appendEvent(manager, {
      stream: `notifications:user:${Number(ticket.creator_id)}`,
      type: 'notification.created',
      aggregateId: notificationId,
      actorId,
      payload: { notification_id: notificationId, source_type: 'ticket', source_id: ticketId }
    });
  }
  const eventId = await appendEvent(manager, {
    stream: `ticket:${ticketId}`,
    type: 'ticket.status.updated',
    aggregateId: ticketId,
    actorId,
    payload: {
      ticket_id: ticketId, previous_status: ticket.status, status,
      audit_event_id: auditEventId, notification_id: notificationId
    }
  });
  return { id: ticketId, status, changed: true, auditEventId, notificationId, notificationEventId, eventId };
}

function optionalPositiveId(value, field) {
  if (value == null || value === '') return null;
  return positiveId(value, field);
}

function clipboardVisibility(value, fallback) {
  if (value == null || value === '') return fallback;
  const visibility = String(value);
  if (!['private', 'link', 'public'].includes(visibility)) {
    throw contentError('VALIDATION_FAILED', 'Clipboard visibility is invalid.', 422, {
      visibility: 'private, link, or public required'
    });
  }
  return visibility;
}

function clipboardToken(input) {
  const token = String(input.generateToken());
  if (!/^[A-Za-z0-9_-]{20,40}$/.test(token)) {
    throw contentError('CLIPBOARD_TOKEN_GENERATION_FAILED', 'A share token could not be generated.', 500);
  }
  return token;
}

function clipboardText(value, field, maximumBytes) {
  const text = String(value == null ? '' : value);
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > maximumBytes) {
    throw contentError('VALIDATION_FAILED', `${field} is too long.`, 422, {
      [field]: `maximum ${maximumBytes} UTF-8 bytes`
    });
  }
  return text;
}

function clipboardExpiry(value, now) {
  if (value == null || value === '') return null;
  const expires = Number(value);
  if (!Number.isSafeInteger(expires) || expires <= Number(now)) {
    throw contentError('VALIDATION_FAILED', 'Share expiry must be a future Unix timestamp.', 422, {
      share_expires: 'future Unix timestamp required'
    });
  }
  return expires;
}

function clipboardDays(value) {
  const days = value == null || value === '' ? 0 : Number(value);
  if (!Number.isSafeInteger(days) || days < 0 || days > 365) {
    throw contentError('VALIDATION_FAILED', 'Share expiry must be between 0 and 365 days.', 422, {
      expires_in_days: 'integer from 0 to 365'
    });
  }
  return days;
}

function assertClipboardOwner(item, actorId) {
  if (Number(item.user_id) !== Number(actorId)) {
    throw contentError('CLIPBOARD_FORBIDDEN', 'You do not own this clipboard item.', 403);
  }
}

async function createDiscussion(manager, input) {
  const actorId = positiveId(input.actorId, 'actor_id');
  const title = requiredText(input.title, 'title', 80);
  const content = requiredText(input.content, 'content', 100000);
  const problemId = optionalPositiveId(input.problemId, 'problem_id');
  if (problemId) {
    const problems = await manager.query(
      'SELECT id,user_id,is_public FROM problem WHERE id=? LIMIT 1 FOR UPDATE',
      [problemId]
    );
    if (!problems.length) throw contentError('PROBLEM_NOT_FOUND', 'Problem was not found.', 404);
    const problem = problems[0];
    const allowedProblemIds = (input.allowedProblemIds || []).map(Number);
    if (!problem.is_public && Number(problem.user_id) !== actorId && !input.canUseHiddenProblem && !allowedProblemIds.includes(problemId)) {
      throw contentError('PROBLEM_NOT_FOUND', 'Problem was not found.', 404);
    }
  }
  const now = Number(input.now);
  const result = await manager.query(
    `INSERT INTO article
      (title,content,user_id,problem_id,public_time,update_time,sort_time,comments_num,allow_comment,is_notice)
     VALUES (?,?,?,?,?,?,?,0,1,?)`,
    [title, content, actorId, problemId, now, now, now, input.canSetNotice && input.isNotice ? 1 : 0]
  );
  const discussionId = Number(result.insertId);
  const eventId = await appendEvent(manager, {
    stream: `discussion:${discussionId}`,
    type: 'discussion.created',
    aggregateId: discussionId,
    actorId,
    payload: { discussion_id: discussionId, problem_id: problemId }
  });
  return { id: discussionId, title, content, problemId, now, eventId };
}

async function updateDiscussion(manager, input) {
  const discussionId = positiveId(input.discussionId, 'discussion_id');
  const actorId = positiveId(input.actorId, 'actor_id');
  const title = requiredText(input.title, 'title', 80);
  const content = requiredText(input.content, 'content', 100000);
  const rows = await manager.query(
    'SELECT id,title,content,user_id,problem_id,is_notice,update_time FROM article WHERE id=? LIMIT 1 FOR UPDATE',
    [discussionId]
  );
  if (!rows.length) throw contentError('DISCUSSION_NOT_FOUND', 'Discussion was not found.', 404);
  const current = rows[0];
  if (!input.isModerator && Number(current.user_id) !== actorId) {
    throw contentError('DISCUSSION_FORBIDDEN', 'You cannot edit this discussion.', 403);
  }
  if (input.ifMatch && !input.ifMatch(current)) {
    throw contentError('ETAG_MISMATCH', 'The discussion changed. Refresh it and try again.', 412);
  }
  const isNotice = input.isModerator && input.isNotice != null ? !!input.isNotice : !!current.is_notice;
  const now = Number(input.now);
  await manager.query(
    'UPDATE article SET title=?,content=?,is_notice=?,update_time=? WHERE id=?',
    [title, content, isNotice ? 1 : 0, now, discussionId]
  );
  const eventId = await appendEvent(manager, {
    stream: `discussion:${discussionId}`,
    type: 'discussion.updated',
    aggregateId: discussionId,
    actorId,
    payload: { discussion_id: discussionId, problem_id: current.problem_id == null ? null : Number(current.problem_id) }
  });
  return {
    id: discussionId,
    title,
    content,
    problemId: current.problem_id == null ? null : Number(current.problem_id),
    isNotice,
    now,
    eventId
  };
}

async function replyToDiscussion(manager, input) {
  const discussionId = positiveId(input.discussionId, 'discussion_id');
  const actorId = positiveId(input.actorId, 'actor_id');
  const content = requiredText(input.content, 'content', 100000);
  const articles = await manager.query(
    `SELECT article.id,article.allow_comment,article.user_id,article.problem_id,
            problem.is_public AS problem_is_public,problem.user_id AS problem_user_id
       FROM article
       LEFT JOIN problem ON problem.id=article.problem_id
      WHERE article.id=? LIMIT 1 FOR UPDATE`,
    [discussionId]
  );
  if (!articles.length) throw contentError('DISCUSSION_NOT_FOUND', 'Discussion was not found.', 404);
  const article = articles[0];
  const allowedProblemIds = (input.allowedProblemIds || []).map(Number);
  if (article.problem_id != null && !article.problem_is_public &&
      Number(article.user_id) !== actorId && Number(article.problem_user_id) !== actorId &&
      !input.canViewHiddenProblem && !allowedProblemIds.includes(Number(article.problem_id))) {
    throw contentError('DISCUSSION_NOT_FOUND', 'Discussion was not found.', 404);
  }
  if (!article.allow_comment && !input.isModerator) {
    throw contentError('DISCUSSION_LOCKED', 'Discussion is locked.', 409);
  }
  const now = Number(input.now);
  const result = await manager.query(
    'INSERT INTO article_comment (content,article_id,user_id,public_time) VALUES (?,?,?,?)',
    [content, discussionId, actorId, now]
  );
  const replyId = Number(result.insertId);
  await manager.query(
    `UPDATE article SET
       comments_num=(SELECT COUNT(*) FROM article_comment WHERE article_id=?),
       update_time=?,sort_time=?
     WHERE id=?`,
    [discussionId, now, now, discussionId]
  );
  const eventId = await appendEvent(manager, {
    stream: `discussion:${discussionId}`,
    type: 'discussion.reply.created',
    aggregateId: discussionId,
    actorId,
    payload: { discussion_id: discussionId, reply_id: replyId }
  });
  return { id: replyId, discussionId, content, now, eventId };
}

async function deleteDiscussion(manager, input) {
  const discussionId = positiveId(input.discussionId, 'discussion_id');
  const actorId = positiveId(input.actorId, 'actor_id');
  const rows = await manager.query('SELECT id,user_id,problem_id FROM article WHERE id=? LIMIT 1 FOR UPDATE', [discussionId]);
  if (!rows.length) throw contentError('DISCUSSION_NOT_FOUND', 'The discussion was not found.', 404);
  const discussion = rows[0];
  if (!input.isModerator && Number(discussion.user_id) !== actorId) {
    throw contentError('DISCUSSION_FORBIDDEN', 'You cannot delete this discussion.', 403);
  }
  await manager.query('DELETE FROM article_comment WHERE article_id=?', [discussionId]);
  await manager.query('DELETE FROM article WHERE id=?', [discussionId]);
  const auditEventId = await input.recordAudit({
    action: 'discussion:delete',
    resourceType: 'discussion',
    resourceId: discussionId,
    details: { problem_id: discussion.problem_id == null ? null : Number(discussion.problem_id) }
  }, manager);
  const eventId = await appendEvent(manager, {
    stream: `discussion:${discussionId}`,
    type: 'discussion.deleted',
    aggregateId: discussionId,
    actorId,
    payload: { discussion_id: discussionId, problem_id: discussion.problem_id == null ? null : Number(discussion.problem_id), audit_event_id: auditEventId }
  });
  return { id: discussionId, problemId: discussion.problem_id == null ? null : Number(discussion.problem_id), auditEventId, eventId };
}

async function deleteDiscussionReply(manager, input) {
  const discussionId = positiveId(input.discussionId, 'discussion_id');
  const replyId = positiveId(input.replyId, 'reply_id');
  const actorId = positiveId(input.actorId, 'actor_id');
  const rows = await manager.query(
    `SELECT reply.user_id,discussion.user_id AS discussion_user_id
       FROM article_comment reply
       INNER JOIN article discussion ON discussion.id=reply.article_id
      WHERE reply.id=? AND reply.article_id=? LIMIT 1 FOR UPDATE`,
    [replyId, discussionId]
  );
  if (!rows.length) throw contentError('DISCUSSION_NOT_FOUND', 'The discussion reply was not found.', 404);
  const reply = rows[0];
  if (!input.isModerator && Number(reply.user_id) !== actorId && Number(reply.discussion_user_id) !== actorId) {
    throw contentError('DISCUSSION_FORBIDDEN', 'You cannot delete this discussion reply.', 403);
  }
  await manager.query('DELETE FROM article_comment WHERE id=? AND article_id=?', [replyId, discussionId]);
  await manager.query(
    `UPDATE article SET
       comments_num=(SELECT COUNT(*) FROM article_comment WHERE article_id=?),
       sort_time=COALESCE((SELECT MAX(public_time) FROM article_comment WHERE article_id=?),public_time)
     WHERE id=?`,
    [discussionId, discussionId, discussionId]
  );
  const auditEventId = await input.recordAudit({
    action: 'discussion:reply.delete',
    resourceType: 'discussion_reply',
    resourceId: replyId,
    details: { discussion_id: discussionId }
  }, manager);
  const eventId = await appendEvent(manager, {
    stream: `discussion:${discussionId}`,
    type: 'discussion.reply.deleted',
    aggregateId: discussionId,
    actorId,
    payload: { discussion_id: discussionId, reply_id: replyId, audit_event_id: auditEventId }
  });
  return { id: replyId, discussionId, auditEventId, eventId };
}

async function setDiscussionLock(manager, input) {
  const discussionId = positiveId(input.discussionId, 'discussion_id');
  const actorId = positiveId(input.actorId, 'actor_id');
  if (!input.isModerator) {
    throw contentError('DISCUSSION_FORBIDDEN', 'You cannot moderate this discussion.', 403);
  }
  const rows = await manager.query(
    'SELECT id,allow_comment FROM article WHERE id=? LIMIT 1 FOR UPDATE',
    [discussionId]
  );
  if (!rows.length) throw contentError('DISCUSSION_NOT_FOUND', 'Discussion was not found.', 404);
  const locked = !!input.locked;
  const previousLocked = !rows[0].allow_comment;
  const now = Number(input.now);
  if (previousLocked !== locked) {
    await manager.query('UPDATE article SET allow_comment=?,update_time=? WHERE id=?', [locked ? 0 : 1, now, discussionId]);
  }
  const auditEventId = await input.recordAudit({
    action: locked ? 'discussion:lock' : 'discussion:unlock',
    resourceType: 'discussion',
    resourceId: discussionId,
    reason: input.reason || null,
    details: { previous_locked: previousLocked, locked, changed: previousLocked !== locked }
  }, manager);
  const eventId = await appendEvent(manager, {
    stream: `discussion:${discussionId}`,
    type: locked ? 'discussion.locked' : 'discussion.unlocked',
    aggregateId: discussionId,
    actorId,
    payload: {
      discussion_id: discussionId,
      previous_locked: previousLocked,
      locked,
      changed: previousLocked !== locked,
      audit_event_id: auditEventId
    }
  });
  return { id: discussionId, locked, changed: previousLocked !== locked, auditEventId, eventId };
}

function apiSolutionStatus(databaseStatus) {
  return databaseStatus === 'accepted' ? 'approved' : databaseStatus;
}

function solutionDecision(value) {
  const decision = String(value || '');
  if (!['approved', 'rejected'].includes(decision)) {
    throw contentError('VALIDATION_FAILED', 'Decision must be approved or rejected.', 422, {
      decision: 'approved or rejected required'
    });
  }
  return decision;
}

async function createSolution(manager, input) {
  const actorId = positiveId(input.actorId, 'actor_id');
  const problemId = positiveId(input.problemId, 'problem_id');
  const title = requiredText(input.title, 'title', 80);
  const body = requiredText(input.content, 'content', 200000);
  const status = input.submitForReview ? 'pending' : 'draft';
  const problems = await manager.query(
    'SELECT id,user_id,is_public FROM problem WHERE id=? LIMIT 1 FOR UPDATE',
    [problemId]
  );
  if (!problems.length) throw contentError('PROBLEM_NOT_FOUND', 'Problem was not found.', 404);
  const problem = problems[0];
  if (!problem.is_public && Number(problem.user_id) !== actorId && !input.canUseHiddenProblem) {
    throw contentError('PROBLEM_NOT_FOUND', 'Problem was not found.', 404);
  }
  const settings = await manager.query(
    'SELECT disable_submission FROM problem_solution_setting WHERE problem_id=? LIMIT 1 FOR UPDATE',
    [problemId]
  );
  if (settings[0] && settings[0].disable_submission && !input.isModerator) {
    throw contentError('SOLUTION_SUBMISSION_DISABLED', 'Solution submissions are disabled for this problem.', 409);
  }
  const now = Number(input.now);
  const result = await manager.query(
    `INSERT INTO problem_solution
      (title,content,problem_id,user_id,status,public_time,update_time,reject_reason,reviewer_id,reviewed_at,allow_comment,comments_num)
     VALUES (?,?,?,?,?,NULL,?,NULL,NULL,NULL,?,0)`,
    [title, body, problemId, actorId, status, now, input.allowComment === false ? 0 : 1]
  );
  const solutionId = Number(result.insertId);
  const eventId = await appendEvent(manager, {
    stream: `solution:${solutionId}`,
    type: status === 'pending' ? 'solution.review.submitted' : 'solution.draft.created',
    aggregateId: solutionId,
    actorId,
    payload: { solution_id: solutionId, problem_id: problemId, status }
  });
  return {
    id: solutionId, problemId, userId: actorId, title, content: body,
    status, publicTime: null, updateTime: now, allowComment: input.allowComment !== false, eventId
  };
}

async function updateSolution(manager, input) {
  const solutionId = positiveId(input.solutionId, 'solution_id');
  const actorId = positiveId(input.actorId, 'actor_id');
  const title = requiredText(input.title, 'title', 80);
  const body = requiredText(input.content, 'content', 200000);
  const rows = await manager.query(
    'SELECT * FROM problem_solution WHERE id=? LIMIT 1 FOR UPDATE',
    [solutionId]
  );
  if (!rows.length) throw contentError('SOLUTION_NOT_FOUND', 'Solution was not found.', 404);
  const current = rows[0];
  if (!input.isModerator && Number(current.user_id) !== actorId) {
    throw contentError('SOLUTION_FORBIDDEN', 'You cannot edit this solution.', 403);
  }
  if (input.ifMatch && !input.ifMatch(current)) {
    throw contentError('ETAG_MISMATCH', 'The solution changed. Refresh it and try again.', 412);
  }
  const now = Number(input.now);
  const status = input.isModerator ? current.status : 'pending';
  await manager.query(
    `UPDATE problem_solution SET
       title=?,content=?,allow_comment=?,status=?,update_time=?,
       reject_reason=CASE WHEN ?='pending' THEN NULL ELSE reject_reason END,
       reviewer_id=CASE WHEN ?='pending' THEN NULL ELSE reviewer_id END,
       reviewed_at=CASE WHEN ?='pending' THEN NULL ELSE reviewed_at END
     WHERE id=?`,
    [title, body, input.allowComment === false ? 0 : 1, status, now, status, status, status, solutionId]
  );
  const auditEventId = await input.recordAudit({
    action: 'solution:update',
    resourceType: 'solution',
    resourceId: solutionId,
    reason: input.reason || null,
    details: {
      problem_id: Number(current.problem_id), author_id: Number(current.user_id),
      previous_status: current.status, status
    }
  }, manager);
  const eventId = await appendEvent(manager, {
    stream: `solution:${solutionId}`,
    type: 'solution.updated',
    aggregateId: solutionId,
    actorId,
    payload: {
      solution_id: solutionId, problem_id: Number(current.problem_id),
      previous_status: current.status, status, audit_event_id: auditEventId
    }
  });
  return {
    id: solutionId, problemId: Number(current.problem_id), title, content: body,
    status: apiSolutionStatus(status), allowComment: input.allowComment !== false,
    updateTime: now, auditEventId, eventId
  };
}

async function createSolutionComment(manager, input) {
  const solutionId = positiveId(input.solutionId, 'solution_id');
  const actorId = positiveId(input.actorId, 'actor_id');
  const body = requiredText(input.content, 'content', 5000);
  const rows = await manager.query(
    'SELECT id,title,problem_id,user_id,status,allow_comment FROM problem_solution WHERE id=? LIMIT 1 FOR UPDATE',
    [solutionId]
  );
  if (!rows.length) throw contentError('SOLUTION_NOT_FOUND', 'Solution was not found.', 404);
  const current = rows[0];
  if (
    current.status !== 'accepted' ||
    (!current.allow_comment && !input.isModerator && Number(current.user_id) !== actorId)
  ) {
    throw contentError('SOLUTION_FORBIDDEN', 'You cannot comment on this solution.', 403);
  }
  const now = Number(input.now);
  const inserted = await manager.query(
    'INSERT INTO problem_solution_comment (content,solution_id,user_id,public_time) VALUES (?,?,?,?)',
    [body, solutionId, actorId, now]
  );
  const commentId = Number(inserted.insertId);
  await manager.query(
    `UPDATE problem_solution
        SET comments_num=(SELECT COUNT(*) FROM problem_solution_comment WHERE solution_id=?)
      WHERE id=?`,
    [solutionId, solutionId]
  );

  const requestedRecipients = [Number(current.user_id), ...(input.mentionUserIds || []).map(Number)]
    .filter(id => Number.isSafeInteger(id) && id > 0 && id !== actorId);
  const recipientIds = [...new Set(requestedRecipients)];
  let allowedRecipients = recipientIds;
  if (recipientIds.length) {
    const placeholders = recipientIds.map(() => '?').join(',');
    const existing = await manager.query(`SELECT id FROM user WHERE id IN (${placeholders}) FOR UPDATE`, recipientIds);
    const existingIds = new Set(existing.map(row => Number(row.id)));
    allowedRecipients = recipientIds.filter(id => existingIds.has(id));
  }
  const notifications = [];
  for (const recipientId of allowedRecipients) {
    const authorNotification = recipientId === Number(current.user_id);
    const notification = await manager.query(
      `INSERT INTO notification
        (recipient_id,type,title,content,source_url,source_id,actor_id,is_read,created_at,read_at)
       VALUES (?,?,?,?,?,?,?,0,?,NULL)`,
      [
        recipientId, authorNotification ? 'solution_comment' : 'solution_comment_mention',
        authorNotification
          ? `${input.actorName || actorId} 评论了你的题解`
          : `${input.actorName || actorId} 在题解评论里提到了你`,
        body.length > 100 ? `${body.slice(0, 100)}...` : body,
        `/solution/${solutionId}`, solutionId, actorId, now
      ]
    );
    const notificationId = Number(notification.insertId);
    const notificationEventId = await appendEvent(manager, {
      stream: `notifications:user:${recipientId}`,
      type: 'notification.created',
      aggregateId: notificationId,
      actorId,
      payload: { notification_id: notificationId, source_type: 'solution_comment', source_id: commentId }
    });
    notifications.push({ id: notificationId, recipientId, eventId: notificationEventId });
  }
  const eventId = await appendEvent(manager, {
    stream: `solution:${solutionId}`,
    type: 'solution.comment.created',
    aggregateId: solutionId,
    actorId,
    payload: {
      solution_id: solutionId, comment_id: commentId,
      notification_ids: notifications.map(item => item.id)
    }
  });
  return { id: commentId, solutionId, content: body, now, notifications, eventId };
}

async function submitSolutionReview(manager, input) {
  const solutionId = positiveId(input.solutionId, 'solution_id');
  const actorId = positiveId(input.actorId, 'actor_id');
  const rows = await manager.query(
    `SELECT solution.*,COALESCE(setting.disable_submission,0) AS disable_submission
       FROM problem_solution solution
       LEFT JOIN problem_solution_setting setting ON setting.problem_id=solution.problem_id
      WHERE solution.id=? LIMIT 1 FOR UPDATE`,
    [solutionId]
  );
  if (!rows.length) throw contentError('SOLUTION_NOT_FOUND', 'Solution was not found.', 404);
  const current = rows[0];
  if (Number(current.user_id) !== actorId) {
    throw contentError('SOLUTION_FORBIDDEN', 'You do not own this solution.', 403);
  }
  if (input.ifMatch && !input.ifMatch(current)) {
    throw contentError('ETAG_MISMATCH', 'The solution changed. Refresh it and try again.', 412);
  }
  if (!['draft', 'rejected'].includes(current.status)) {
    throw contentError('SOLUTION_NOT_SUBMITTABLE', 'Only a draft or rejected solution can be submitted for review.', 409);
  }
  if (current.disable_submission && !input.isModerator) {
    throw contentError('SOLUTION_SUBMISSION_DISABLED', 'Solution submissions are disabled for this problem.', 409);
  }
  const now = Number(input.now);
  await manager.query(
    `UPDATE problem_solution SET
       status='pending',reject_reason=NULL,reviewer_id=NULL,reviewed_at=NULL,update_time=?
     WHERE id=?`,
    [now, solutionId]
  );
  const eventId = await appendEvent(manager, {
    stream: `solution:${solutionId}`,
    type: 'solution.review.submitted',
    aggregateId: solutionId,
    actorId,
    payload: { solution_id: solutionId, problem_id: Number(current.problem_id), previous_status: current.status }
  });
  return { id: solutionId, problemId: Number(current.problem_id), status: 'pending', updateTime: now, eventId };
}

async function reviewSolution(manager, input) {
  const solutionId = positiveId(input.solutionId, 'solution_id');
  const reviewerId = positiveId(input.reviewerId, 'reviewer_id');
  if (!input.isModerator) {
    throw contentError('SOLUTION_FORBIDDEN', 'You cannot review this solution.', 403);
  }
  const decision = solutionDecision(input.decision);
  const reason = decision === 'rejected'
    ? requiredText(input.reason, 'reason', 255)
    : String(input.reason || '').trim().slice(0, 255) || '题解审核通过';
  const rows = await manager.query('SELECT * FROM problem_solution WHERE id=? LIMIT 1 FOR UPDATE', [solutionId]);
  if (!rows.length) throw contentError('SOLUTION_NOT_FOUND', 'Solution was not found.', 404);
  const current = rows[0];
  if (input.ifMatch && !input.ifMatch(current)) {
    throw contentError('ETAG_MISMATCH', 'The solution changed. Refresh it and try again.', 412);
  }
  if (current.status !== 'pending') {
    throw contentError('SOLUTION_NOT_REVIEWABLE', 'Only a pending solution can be reviewed.', 409);
  }
  const databaseStatus = decision === 'approved' ? 'accepted' : 'rejected';
  const now = Number(input.now);
  await manager.query(
    `UPDATE problem_solution SET
       status=?,reject_reason=?,reviewer_id=?,reviewed_at=?,
       public_time=CASE WHEN ?='accepted' THEN ? ELSE public_time END,update_time=?
     WHERE id=?`,
    [databaseStatus, decision === 'rejected' ? reason : null, reviewerId, now, databaseStatus, now, now, solutionId]
  );
  const auditEventId = await input.recordAudit({
    action: `solution:${decision}`,
    resourceType: 'solution',
    resourceId: solutionId,
    reason,
    details: {
      problem_id: Number(current.problem_id),
      author_id: Number(current.user_id),
      previous_status: current.status,
      status: decision
    }
  }, manager);
  let notificationId = null;
  let notificationEventId = null;
  if (Number(current.user_id) !== reviewerId) {
    const notificationTitle = decision === 'approved'
      ? `您的题解《${current.title || '无标题'}》已通过审核`
      : `您的题解《${current.title || '无标题'}》未通过审核`;
    const notificationContent = decision === 'approved'
      ? `审核员：${input.reviewerName || reviewerId}`
      : `审核员：${input.reviewerName || reviewerId}\n原因：${reason}`;
    const notification = await manager.query(
      `INSERT INTO notification
        (recipient_id,type,title,content,source_url,source_id,actor_id,is_read,created_at,read_at)
       VALUES (?,?,?,?,?,?,?,0,?,NULL)`,
      [
        Number(current.user_id), decision === 'approved' ? 'solution_approved' : 'solution_rejected',
        notificationTitle, notificationContent, `/solution/${solutionId}`, solutionId, reviewerId, now
      ]
    );
    notificationId = Number(notification.insertId);
    notificationEventId = await appendEvent(manager, {
      stream: `notifications:user:${Number(current.user_id)}`,
      type: 'notification.created',
      aggregateId: notificationId,
      actorId: reviewerId,
      payload: { notification_id: notificationId, source_type: 'solution', source_id: solutionId }
    });
  }
  const eventId = await appendEvent(manager, {
    stream: `solution:${solutionId}`,
    type: `solution.review.${decision}`,
    aggregateId: solutionId,
    actorId: reviewerId,
    payload: {
      solution_id: solutionId,
      problem_id: Number(current.problem_id),
      status: decision,
      audit_event_id: auditEventId,
      notification_id: notificationId
    }
  });
  return {
    id: solutionId, problemId: Number(current.problem_id), authorId: Number(current.user_id),
    status: apiSolutionStatus(databaseStatus), reason: decision === 'rejected' ? reason : null,
    updateTime: now, auditEventId, notificationId, notificationEventId, eventId
  };
}

async function withdrawSolution(manager, input) {
  const solutionId = positiveId(input.solutionId, 'solution_id');
  const actorId = positiveId(input.actorId, 'actor_id');
  const rows = await manager.query(
    'SELECT id,problem_id,user_id,status FROM problem_solution WHERE id=? LIMIT 1 FOR UPDATE',
    [solutionId]
  );
  if (!rows.length) throw contentError('SOLUTION_NOT_FOUND', 'Solution was not found.', 404);
  const current = rows[0];
  if (Number(current.user_id) !== actorId) {
    throw contentError('SOLUTION_FORBIDDEN', 'You cannot withdraw this solution.', 403);
  }
  if (current.status === 'withdrawn') {
    throw contentError('SOLUTION_ALREADY_WITHDRAWN', 'The solution has already been withdrawn.', 409);
  }
  const now = Number(input.now);
  await manager.query(
    "UPDATE problem_solution SET status='withdrawn',update_time=? WHERE id=?",
    [now, solutionId]
  );
  const auditEventId = await input.recordAudit({
    action: 'solution:withdraw',
    resourceType: 'solution',
    resourceId: solutionId,
    details: { problem_id: Number(current.problem_id), previous_status: current.status }
  }, manager);
  const eventId = await appendEvent(manager, {
    stream: `solution:${solutionId}`,
    type: 'solution.withdrawn',
    aggregateId: solutionId,
    actorId,
    payload: {
      solution_id: solutionId, problem_id: Number(current.problem_id),
      previous_status: current.status, audit_event_id: auditEventId
    }
  });
  return {
    id: solutionId, problemId: Number(current.problem_id), status: 'withdrawn',
    updateTime: now, auditEventId, eventId
  };
}

async function deleteSolution(manager, input) {
  const solutionId = positiveId(input.solutionId, 'solution_id');
  const actorId = positiveId(input.actorId, 'actor_id');
  const rows = await manager.query(
    'SELECT id,problem_id,user_id,status FROM problem_solution WHERE id=? LIMIT 1 FOR UPDATE',
    [solutionId]
  );
  if (!rows.length) throw contentError('SOLUTION_NOT_FOUND', 'Solution was not found.', 404);
  const current = rows[0];
  if (!input.isModerator && Number(current.user_id) !== actorId) {
    throw contentError('SOLUTION_FORBIDDEN', 'You cannot delete this solution.', 403);
  }
  await manager.query('DELETE FROM problem_solution_comment WHERE solution_id=?', [solutionId]);
  await manager.query('DELETE FROM problem_solution WHERE id=?', [solutionId]);
  const auditEventId = await input.recordAudit({
    action: 'solution:delete',
    resourceType: 'solution',
    resourceId: solutionId,
    details: {
      problem_id: Number(current.problem_id), author_id: Number(current.user_id),
      previous_status: current.status
    }
  }, manager);
  const eventId = await appendEvent(manager, {
    stream: `solution:${solutionId}`,
    type: 'solution.deleted',
    aggregateId: solutionId,
    actorId,
    payload: {
      solution_id: solutionId, problem_id: Number(current.problem_id),
      author_id: Number(current.user_id), audit_event_id: auditEventId
    }
  });
  return { id: solutionId, problemId: Number(current.problem_id), auditEventId, eventId };
}

async function deleteSolutionComment(manager, input) {
  const solutionId = positiveId(input.solutionId, 'solution_id');
  const commentId = positiveId(input.commentId, 'comment_id');
  const actorId = positiveId(input.actorId, 'actor_id');
  const rows = await manager.query(
    `SELECT comment.user_id,solution.user_id AS solution_user_id
       FROM problem_solution_comment comment
       INNER JOIN problem_solution solution ON solution.id=comment.solution_id
      WHERE comment.id=? AND comment.solution_id=? LIMIT 1 FOR UPDATE`,
    [commentId, solutionId]
  );
  if (!rows.length) throw contentError('SOLUTION_COMMENT_NOT_FOUND', 'Solution comment was not found.', 404);
  const current = rows[0];
  if (
    !input.isModerator &&
    Number(current.user_id) !== actorId &&
    Number(current.solution_user_id) !== actorId
  ) {
    throw contentError('SOLUTION_FORBIDDEN', 'You cannot delete this solution comment.', 403);
  }
  await manager.query(
    'DELETE FROM problem_solution_comment WHERE id=? AND solution_id=?',
    [commentId, solutionId]
  );
  await manager.query(
    `UPDATE problem_solution
        SET comments_num=(SELECT COUNT(*) FROM problem_solution_comment WHERE solution_id=?)
      WHERE id=?`,
    [solutionId, solutionId]
  );
  const auditEventId = await input.recordAudit({
    action: 'solution:comment.delete',
    resourceType: 'solution_comment',
    resourceId: commentId,
    details: { solution_id: solutionId }
  }, manager);
  const eventId = await appendEvent(manager, {
    stream: `solution:${solutionId}`,
    type: 'solution.comment.deleted',
    aggregateId: solutionId,
    actorId,
    payload: { solution_id: solutionId, comment_id: commentId, audit_event_id: auditEventId }
  });
  return { id: commentId, solutionId, auditEventId, eventId };
}

async function createAnnouncement(manager, input) {
  const actorId = positiveId(input.actorId, 'actor_id');
  const value = input.value;
  const now = Number(input.now);
  const inserted = await manager.query(
    `INSERT INTO announcement
      (title,content,level,start_time,end_time,is_active,public_time,update_time)
     VALUES (?,?,?,?,?,?,?,?)`,
    [value.title, value.content, value.level, value.start_time, value.end_time, value.is_active ? 1 : 0, now, now]
  );
  const announcementId = Number(inserted.insertId);
  const auditEventId = await input.recordAudit({
    action: 'admin:announcement.create',
    resourceType: 'announcement',
    resourceId: announcementId,
    reason: input.reason || null,
    details: {
      title: value.title, level: value.level, active: value.is_active,
      starts_at: value.start_time, ends_at: value.end_time
    }
  }, manager);
  const eventId = await appendEvent(manager, {
    stream: `content:announcement:${announcementId}`,
    type: 'announcement.created',
    aggregateId: announcementId,
    actorId,
    payload: { audit_event_id: auditEventId }
  });
  const rows = await manager.query('SELECT * FROM announcement WHERE id=? LIMIT 1', [announcementId]);
  return { row: rows[0], auditEventId, eventId };
}

async function updateAnnouncement(manager, input) {
  const actorId = positiveId(input.actorId, 'actor_id');
  const announcementId = positiveId(input.announcementId, 'announcement_id');
  const rows = await manager.query('SELECT * FROM announcement WHERE id=? LIMIT 1 FOR UPDATE', [announcementId]);
  if (!rows.length) throw contentError('ANNOUNCEMENT_NOT_FOUND', 'Announcement was not found.', 404);
  const current = rows[0];
  if (input.ifMatch && !input.ifMatch(current)) {
    throw contentError('ETAG_MISMATCH', 'Announcement changed. Reload it before saving.', 412);
  }
  const normalized = input.validate(current);
  if (Object.keys(normalized.errors || {}).length) {
    throw contentError('VALIDATION_FAILED', 'Announcement fields are invalid.', 422, normalized.errors);
  }
  const value = normalized.value;
  const now = Number(input.now);
  await manager.query(
    `UPDATE announcement SET
       title=?,content=?,level=?,start_time=?,end_time=?,is_active=?,update_time=?
     WHERE id=?`,
    [value.title, value.content, value.level, value.start_time, value.end_time, value.is_active ? 1 : 0, now, announcementId]
  );
  const auditEventId = await input.recordAudit({
    action: 'admin:announcement.update',
    resourceType: 'announcement',
    resourceId: announcementId,
    reason: input.reason || null,
    details: {
      before: {
        title: current.title, level: current.level, active: !!current.is_active,
        starts_at: current.start_time, ends_at: current.end_time
      },
      after: {
        title: value.title, level: value.level, active: value.is_active,
        starts_at: value.start_time, ends_at: value.end_time
      },
      content_changed: current.content !== value.content
    }
  }, manager);
  const eventId = await appendEvent(manager, {
    stream: `content:announcement:${announcementId}`,
    type: 'announcement.updated',
    aggregateId: announcementId,
    actorId,
    payload: { audit_event_id: auditEventId }
  });
  const updatedRows = await manager.query('SELECT * FROM announcement WHERE id=? LIMIT 1', [announcementId]);
  return { row: updatedRows[0], auditEventId, eventId };
}

async function deleteAnnouncement(manager, input) {
  const actorId = positiveId(input.actorId, 'actor_id');
  const announcementId = positiveId(input.announcementId, 'announcement_id');
  const rows = await manager.query('SELECT * FROM announcement WHERE id=? LIMIT 1 FOR UPDATE', [announcementId]);
  if (!rows.length) throw contentError('ANNOUNCEMENT_NOT_FOUND', 'Announcement was not found.', 404);
  const current = rows[0];
  if (input.ifMatch && !input.ifMatch(current)) {
    throw contentError('ETAG_MISMATCH', 'Announcement changed. Reload it before deleting.', 412);
  }
  await manager.query('DELETE FROM announcement WHERE id=?', [announcementId]);
  const auditEventId = await input.recordAudit({
    action: 'admin:announcement.delete',
    resourceType: 'announcement',
    resourceId: announcementId,
    reason: input.reason || null,
    details: {
      title: current.title, level: current.level, active: !!current.is_active,
      starts_at: current.start_time, ends_at: current.end_time
    }
  }, manager);
  const eventId = await appendEvent(manager, {
    stream: `content:announcement:${announcementId}`,
    type: 'announcement.deleted',
    aggregateId: announcementId,
    actorId,
    payload: { audit_event_id: auditEventId }
  });
  return { id: announcementId, deleted: true, row: current, auditEventId, eventId };
}

async function createBanner(manager, input) {
  const actorId = positiveId(input.actorId, 'actor_id');
  const value = input.value;
  const now = Number(input.now);
  const inserted = await manager.query(
    `INSERT INTO homepage_banner
      (title,image_path,link_url,sort_order,is_active,start_time,end_time,created_by,created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      value.title, value.image_path, value.link_url, value.sort_order, value.is_active ? 1 : 0,
      value.start_time, value.end_time, actorId, now
    ]
  );
  const bannerId = Number(inserted.insertId);
  const auditEventId = await input.recordAudit({
    action: 'admin:banner.create',
    resourceType: 'banner',
    resourceId: bannerId,
    reason: input.reason || null,
    details: {
      title: value.title, image_url: value.image_path, link_url: value.link_url,
      active: value.is_active
    }
  }, manager);
  const eventId = await appendEvent(manager, {
    stream: `content:banner:${bannerId}`,
    type: 'banner.created',
    aggregateId: bannerId,
    actorId,
    payload: { audit_event_id: auditEventId }
  });
  const rows = await manager.query('SELECT * FROM homepage_banner WHERE id=? LIMIT 1', [bannerId]);
  return { row: rows[0], auditEventId, eventId };
}

async function updateBanner(manager, input) {
  const actorId = positiveId(input.actorId, 'actor_id');
  const bannerId = positiveId(input.bannerId, 'banner_id');
  const rows = await manager.query('SELECT * FROM homepage_banner WHERE id=? LIMIT 1 FOR UPDATE', [bannerId]);
  if (!rows.length) throw contentError('BANNER_NOT_FOUND', 'Banner was not found.', 404);
  const current = rows[0];
  if (input.ifMatch && !input.ifMatch(current)) {
    throw contentError('ETAG_MISMATCH', 'Banner changed. Reload it before saving.', 412);
  }
  const normalized = input.validate(current);
  if (Object.keys(normalized.errors || {}).length) {
    throw contentError('VALIDATION_FAILED', 'Banner fields are invalid.', 422, normalized.errors);
  }
  const value = normalized.value;
  await manager.query(
    `UPDATE homepage_banner SET
       title=?,image_path=?,link_url=?,sort_order=?,is_active=?,start_time=?,end_time=?
     WHERE id=?`,
    [
      value.title, value.image_path, value.link_url, value.sort_order, value.is_active ? 1 : 0,
      value.start_time, value.end_time, bannerId
    ]
  );
  const auditEventId = await input.recordAudit({
    action: 'admin:banner.update',
    resourceType: 'banner',
    resourceId: bannerId,
    reason: input.reason || null,
    details: {
      before: {
        title: current.title, image_url: current.image_path, link_url: current.link_url,
        sort_order: Number(current.sort_order || 0), active: !!current.is_active,
        starts_at: current.start_time, ends_at: current.end_time
      },
      after: {
        title: value.title, image_url: value.image_path, link_url: value.link_url,
        sort_order: value.sort_order, active: value.is_active,
        starts_at: value.start_time, ends_at: value.end_time
      }
    }
  }, manager);
  const eventId = await appendEvent(manager, {
    stream: `content:banner:${bannerId}`,
    type: 'banner.updated',
    aggregateId: bannerId,
    actorId,
    payload: { audit_event_id: auditEventId }
  });
  const updatedRows = await manager.query('SELECT * FROM homepage_banner WHERE id=? LIMIT 1', [bannerId]);
  return { row: updatedRows[0], auditEventId, eventId };
}

async function deleteBanner(manager, input) {
  const actorId = positiveId(input.actorId, 'actor_id');
  const bannerId = positiveId(input.bannerId, 'banner_id');
  const rows = await manager.query('SELECT * FROM homepage_banner WHERE id=? LIMIT 1 FOR UPDATE', [bannerId]);
  if (!rows.length) throw contentError('BANNER_NOT_FOUND', 'Banner was not found.', 404);
  const current = rows[0];
  if (input.ifMatch && !input.ifMatch(current)) {
    throw contentError('ETAG_MISMATCH', 'Banner changed. Reload it before deleting.', 412);
  }
  await manager.query('DELETE FROM homepage_banner WHERE id=?', [bannerId]);
  const auditEventId = await input.recordAudit({
    action: 'admin:banner.delete',
    resourceType: 'banner',
    resourceId: bannerId,
    reason: input.reason || null,
    details: {
      title: current.title, image_url: current.image_path, link_url: current.link_url,
      sort_order: Number(current.sort_order || 0), active: !!current.is_active
    }
  }, manager);
  const eventId = await appendEvent(manager, {
    stream: `content:banner:${bannerId}`,
    type: 'banner.deleted',
    aggregateId: bannerId,
    actorId,
    payload: { audit_event_id: auditEventId }
  });
  return { id: bannerId, deleted: true, row: current, auditEventId, eventId };
}

async function createClipboard(manager, input) {
  const actorId = positiveId(input.actorId, 'actor_id');
  const title = requiredText(input.title, 'title', 120);
  const content = clipboardText(input.content, 'content', 100 * 1024);
  const visibility = clipboardVisibility(input.visibility, 'private');
  const now = Number(input.now);
  const shareToken = visibility === 'link' ? clipboardToken(input) : null;
  const shareExpires = visibility === 'link' ? clipboardExpiry(input.shareExpires, now) : null;
  const result = await manager.query(
    `INSERT INTO clipboard_item
      (user_id,title,content,visibility,share_token,share_expires,public_time,update_time)
     VALUES (?,?,?,?,?,?,?,?)`,
    [actorId, title, content, visibility, shareToken, shareExpires, now, now]
  );
  const clipboardId = Number(result.insertId);
  const auditEventId = await input.recordAudit({
    action: 'clipboard:create',
    resourceType: 'clipboard',
    resourceId: clipboardId,
    details: { visibility, share_expires: shareExpires }
  }, manager);
  const eventId = await appendEvent(manager, {
    stream: `clipboard:${clipboardId}`,
    type: 'clipboard.created',
    aggregateId: clipboardId,
    actorId,
    payload: { clipboard_id: clipboardId, visibility, audit_event_id: auditEventId }
  });
  return {
    id: clipboardId, user_id: actorId, title, content, visibility,
    share_token: shareToken, share_expires: shareExpires, public_time: now, update_time: now,
    auditEventId, eventId
  };
}

async function updateClipboard(manager, input) {
  const clipboardId = positiveId(input.clipboardId, 'clipboard_id');
  const actorId = positiveId(input.actorId, 'actor_id');
  const rows = await manager.query('SELECT * FROM clipboard_item WHERE id=? LIMIT 1 FOR UPDATE', [clipboardId]);
  if (!rows.length) throw contentError('CLIPBOARD_NOT_FOUND', 'Clipboard item was not found.', 404);
  const current = rows[0];
  assertClipboardOwner(current, actorId);
  if (input.ifMatch && !input.ifMatch(current)) {
    throw contentError('ETAG_MISMATCH', 'The clipboard item changed. Refresh it and try again.', 412);
  }
  const supplied = ['title', 'content', 'visibility', 'share_expires'].some(field => Object.prototype.hasOwnProperty.call(input.patch, field));
  if (!supplied) {
    throw contentError('VALIDATION_FAILED', 'At least one editable field is required.', 422, {
      body: 'title, content, or visibility required'
    });
  }
  const title = Object.prototype.hasOwnProperty.call(input.patch, 'title')
    ? requiredText(input.patch.title, 'title', 120) : current.title;
  const content = Object.prototype.hasOwnProperty.call(input.patch, 'content')
    ? clipboardText(input.patch.content, 'content', 100 * 1024) : current.content;
  const visibility = Object.prototype.hasOwnProperty.call(input.patch, 'visibility')
    ? clipboardVisibility(input.patch.visibility) : current.visibility;
  let shareToken = current.share_token;
  let shareExpires = current.share_expires;
  if (visibility === 'link' && !shareToken) shareToken = clipboardToken(input);
  if (visibility === 'link' && Object.prototype.hasOwnProperty.call(input.patch, 'share_expires')) {
    shareExpires = clipboardExpiry(input.patch.share_expires, Number(input.now));
  }
  if (visibility !== 'link') {
    shareToken = null;
    shareExpires = null;
  }
  const now = Number(input.now);
  await manager.query(
    `UPDATE clipboard_item SET
       title=?,content=?,visibility=?,share_token=?,share_expires=?,update_time=?
     WHERE id=?`,
    [title, content, visibility, shareToken, shareExpires, now, clipboardId]
  );
  const auditEventId = await input.recordAudit({
    action: 'clipboard:update',
    resourceType: 'clipboard',
    resourceId: clipboardId,
    details: { previous_visibility: current.visibility, visibility, share_expires: shareExpires }
  }, manager);
  const eventId = await appendEvent(manager, {
    stream: `clipboard:${clipboardId}`,
    type: 'clipboard.updated',
    aggregateId: clipboardId,
    actorId,
    payload: { clipboard_id: clipboardId, visibility, audit_event_id: auditEventId }
  });
  return Object.assign({}, current, {
    id: clipboardId, title, content, visibility, share_token: shareToken,
    share_expires: shareExpires, update_time: now, auditEventId, eventId
  });
}

async function shareClipboard(manager, input) {
  const clipboardId = positiveId(input.clipboardId, 'clipboard_id');
  const actorId = positiveId(input.actorId, 'actor_id');
  const changesExpiry = input.expiresInDays != null && input.expiresInDays !== '';
  const days = changesExpiry ? clipboardDays(input.expiresInDays) : null;
  const rows = await manager.query('SELECT * FROM clipboard_item WHERE id=? LIMIT 1 FOR UPDATE', [clipboardId]);
  if (!rows.length) throw contentError('CLIPBOARD_NOT_FOUND', 'Clipboard item was not found.', 404);
  const current = rows[0];
  assertClipboardOwner(current, actorId);
  if (input.ifMatch && !input.ifMatch(current)) {
    throw contentError('ETAG_MISMATCH', 'The clipboard item changed. Refresh it and try again.', 412);
  }
  const now = Number(input.now);
  const shareToken = clipboardToken(input);
  const shareExpires = changesExpiry ? (days ? now + days * 86400 : null) : current.share_expires;
  await manager.query(
    "UPDATE clipboard_item SET visibility='link',share_token=?,share_expires=?,update_time=? WHERE id=?",
    [shareToken, shareExpires, now, clipboardId]
  );
  const auditEventId = await input.recordAudit({
    action: 'clipboard:share',
    resourceType: 'clipboard',
    resourceId: clipboardId,
    details: { expires_in_days: days, share_expires: shareExpires }
  }, manager);
  const eventId = await appendEvent(manager, {
    stream: `clipboard:${clipboardId}`,
    type: 'clipboard.shared',
    aggregateId: clipboardId,
    actorId,
    payload: { clipboard_id: clipboardId, share_expires: shareExpires, audit_event_id: auditEventId }
  });
  return Object.assign({}, current, {
    id: clipboardId, visibility: 'link', share_token: shareToken,
    share_expires: shareExpires, update_time: now, auditEventId, eventId
  });
}

async function readSharedClipboard(manager, input) {
  const token = String(input.token || '');
  if (!/^[A-Za-z0-9_-]{20,40}$/.test(token)) {
    throw contentError('CLIPBOARD_NOT_FOUND', 'Shared clipboard item was not found.', 404);
  }
  const rows = await manager.query(
    `SELECT id,user_id,title,content,visibility,share_expires,public_time,update_time
       FROM clipboard_item
      WHERE visibility='link' AND share_token=?
        AND (share_expires IS NULL OR share_expires>?)
      LIMIT 1`,
    [token, Number(input.now)]
  );
  if (!rows.length) throw contentError('CLIPBOARD_NOT_FOUND', 'Shared clipboard item was not found.', 404);
  return rows[0];
}

async function deleteClipboard(manager, input) {
  const clipboardId = positiveId(input.clipboardId, 'clipboard_id');
  const actorId = positiveId(input.actorId, 'actor_id');
  const rows = await manager.query('SELECT * FROM clipboard_item WHERE id=? LIMIT 1 FOR UPDATE', [clipboardId]);
  if (!rows.length) throw contentError('CLIPBOARD_NOT_FOUND', 'Clipboard item was not found.', 404);
  const current = rows[0];
  assertClipboardOwner(current, actorId);
  if (input.ifMatch && !input.ifMatch(current)) {
    throw contentError('ETAG_MISMATCH', 'The clipboard item changed. Refresh it and try again.', 412);
  }
  await manager.query('DELETE FROM clipboard_item WHERE id=?', [clipboardId]);
  const auditEventId = await input.recordAudit({
    action: 'clipboard:delete',
    resourceType: 'clipboard',
    resourceId: clipboardId,
    details: { visibility: current.visibility }
  }, manager);
  const eventId = await appendEvent(manager, {
    stream: `clipboard:${clipboardId}`,
    type: 'clipboard.deleted',
    aggregateId: clipboardId,
    actorId,
    payload: { clipboard_id: clipboardId, audit_event_id: auditEventId }
  });
  return { id: clipboardId, deleted: true, auditEventId, eventId };
}

async function grantUserTag(manager, input) {
  const targetUserId = positiveId(input.targetUserId, 'user_id');
  const actorId = positiveId(input.actorId, 'actor_id');
  const now = Number(input.now);
  const users = await manager.query('SELECT id,username,is_admin FROM user WHERE id=? LIMIT 1 FOR UPDATE', [targetUserId]);
  if (!users.length) throw contentError('USER_NOT_FOUND', 'User was not found.', 404);
  const rows = await manager.query('SELECT * FROM user_tag WHERE user_id=? LIMIT 1 FOR UPDATE', [targetUserId]);
  const current = rows[0] || null;
  if (current && !current.is_disabled) {
    throw contentError('USER_TAG_GRANT_EXISTS', 'The user already has user-tag access.', 409);
  }
  if (current) {
    await manager.query(`UPDATE user_tag
      SET is_disabled=0,disabled_by=NULL,disabled_at=NULL,disabled_reason=NULL,
          granted_by=?,granted_at=?,updated_at=? WHERE user_id=?`,
    [actorId, now, now, targetUserId]);
  } else {
    await manager.query(`INSERT INTO user_tag
      (user_id,tag_text,is_visible,granted_by,granted_at,is_disabled,disabled_by,disabled_at,disabled_reason,updated_at)
      VALUES (?,'',1,?,?,0,NULL,NULL,NULL,?)`, [targetUserId, actorId, now, now]);
  }
  const auditEventId = await input.recordAudit({
    action: 'admin:user-tag.grant',
    resourceType: 'user_tag',
    resourceId: targetUserId,
    details: { target_user_id: targetUserId, restored: !!current }
  }, manager);
  const eventId = await appendEvent(manager, {
    stream: `user-tag:${targetUserId}`,
    type: current ? 'user-tag.restored' : 'user-tag.granted',
    aggregateId: targetUserId,
    actorId,
    payload: { user_id: targetUserId, audit_event_id: auditEventId }
  });
  return { user: users[0], restored: !!current, auditEventId, eventId };
}

async function disableUserTag(manager, input) {
  const targetUserId = positiveId(input.targetUserId, 'user_id');
  const actorId = positiveId(input.actorId, 'actor_id');
  if (targetUserId === actorId) throw contentError('SELF_USER_TAG_DISABLE_FORBIDDEN', 'You cannot disable your own user-tag access.', 403);
  const now = Number(input.now);
  const reason = String(input.reason || '').trim().slice(0, 255) || null;
  const users = await manager.query('SELECT id,username,is_admin FROM user WHERE id=? LIMIT 1 FOR UPDATE', [targetUserId]);
  if (!users.length) throw contentError('USER_NOT_FOUND', 'User was not found.', 404);
  if (users[0].is_admin) throw contentError('ADMIN_USER_TAG_PROTECTED', 'A site administrator\'s user-tag access cannot be disabled.', 403);
  const rows = await manager.query('SELECT * FROM user_tag WHERE user_id=? LIMIT 1 FOR UPDATE', [targetUserId]);
  const current = rows[0] || null;
  const changed = !current || !current.is_disabled;
  if (!current) {
    await manager.query(`INSERT INTO user_tag
      (user_id,tag_text,is_visible,granted_by,granted_at,is_disabled,disabled_by,disabled_at,disabled_reason,updated_at)
      VALUES (?,'',0,NULL,NULL,1,?,?,?,?)`, [targetUserId, actorId, now, reason, now]);
  } else if (changed) {
    await manager.query('UPDATE user_tag SET is_disabled=1,disabled_by=?,disabled_at=?,disabled_reason=?,updated_at=? WHERE user_id=?', [actorId, now, reason, now, targetUserId]);
  }
  const auditEventId = await input.recordAudit({
    action: 'admin:user-tag.disable',
    resourceType: 'user_tag',
    resourceId: targetUserId,
    details: { target_user_id: targetUserId, changed }
  }, manager);
  const eventId = await appendEvent(manager, {
    stream: `user-tag:${targetUserId}`,
    type: 'user-tag.disabled',
    aggregateId: targetUserId,
    actorId,
    payload: { user_id: targetUserId, changed, audit_event_id: auditEventId }
  });
  return { user: users[0], changed, auditEventId, eventId };
}

async function updateUserTagGlobalSetting(manager, input) {
  const actorId = positiveId(input.actorId, 'actor_id');
  if (typeof input.enabled !== 'boolean') {
    throw contentError('VALIDATION_FAILED', 'enabled must be a boolean.', 422, { enabled: 'boolean required' });
  }
  const rows = await manager.query("SELECT enabled,updated_by,updated_at FROM user_tag_global_setting WHERE scope='global' LIMIT 1 FOR UPDATE");
  if (!rows.length) throw contentError('USER_TAG_SETTING_NOT_FOUND', 'The global user-tag setting was not found.', 404);
  const current = rows[0];
  if (input.ifMatch && !input.ifMatch(current)) {
    throw contentError('ETAG_MISMATCH', 'The global user-tag setting changed. Refresh it and try again.', 412);
  }
  const changed = !!current.enabled !== input.enabled;
  if (changed) {
    await manager.query("UPDATE user_tag_global_setting SET enabled=?,updated_by=?,updated_at=UTC_TIMESTAMP(3) WHERE scope='global'", [input.enabled ? 1 : 0, actorId]);
  }
  const auditEventId = await input.recordAudit({
    action: 'admin:user-tag.setting.update',
    resourceType: 'user_tag_setting',
    resourceId: 'global',
    details: { enabled: input.enabled, changed }
  }, manager);
  const eventId = await appendEvent(manager, {
    stream: 'user-tag:settings',
    type: 'user-tag.settings.updated',
    aggregateId: 'global',
    actorId,
    payload: { enabled: input.enabled, changed, audit_event_id: auditEventId }
  });
  return { enabled: input.enabled, changed, auditEventId, eventId };
}

module.exports = {
  apiSolutionStatus,
  appendEvent,
  assignTicket,
  createAnnouncement,
  createBanner,
  createClipboard,
  createDiscussion,
  createSolution,
  createSolutionComment,
  closeTicket,
  contentError,
  createTicket,
  deleteConversationForUser,
  deleteDiscussion,
  deleteDiscussionReply,
  deleteSolution,
  deleteSolutionComment,
  deleteMessageForUser,
  deleteNotification,
  deleteAnnouncement,
  deleteBanner,
  deleteClipboard,
  disableUserTag,
  grantUserTag,
  markAllNotificationsRead,
  markNotificationRead,
  listConversations,
  positiveId,
  readConversation,
  readSharedClipboard,
  reviewSolution,
  replyToDiscussion,
  replyToTicket,
  requiredText,
  sendMessage,
  setDiscussionLock,
  setTicketStatus,
  shareClipboard,
  submitSolutionReview,
  ticketAccess,
  updateClipboard,
  updateDiscussion,
  updateAnnouncement,
  updateBanner,
  updateSolution,
  updateUserTagGlobalSetting,
  updateMessageSettings,
  withdrawSolution
};
