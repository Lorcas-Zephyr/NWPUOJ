'use strict';

const TypeORM = require('typeorm');

let schemaPromise = null;

async function ensureSchema() {
  if (schemaPromise) return schemaPromise;
  schemaPromise = (async () => {
    const connection = TypeORM.getConnection();
    await connection.query(`CREATE TABLE IF NOT EXISTS class_group (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(80) NOT NULL,
      tag_text VARCHAR(12) NOT NULL,
      owner_id INT NOT NULL,
      allow_activity_import TINYINT(1) NOT NULL DEFAULT 1,
      status VARCHAR(16) NOT NULL DEFAULT 'active',
      revision INT UNSIGNED NOT NULL DEFAULT 1,
      created_at DATETIME(3) NOT NULL,
      updated_at DATETIME(3) NOT NULL,
      KEY idx_class_group_owner (owner_id,status,id),
      KEY idx_class_group_status (status,id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await connection.query(`CREATE TABLE IF NOT EXISTS class_group_member (
      class_id INT NOT NULL,
      user_id INT NOT NULL,
      added_by INT NOT NULL,
      created_at DATETIME(3) NOT NULL,
      PRIMARY KEY (class_id,user_id),
      KEY idx_class_group_member_user (user_id,class_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  })().catch(error => {
    schemaPromise = null;
    throw error;
  });
  return schemaPromise;
}

function isUnrestricted(user) {
  return !!(user && (user.is_admin || Number(user.id) === Number(syzoj.siteOwnerUserId || 0)));
}

async function canManageUsers(user) {
  if (!user) return false;
  if (isUnrestricted(user)) return true;
  return syzoj.utils.authorizationV2.authorize(user, 'admin:user.manage', null, { scope: 'global' });
}

async function canManageClass(user, group) {
  if (!user || !group) return false;
  if (isUnrestricted(user)) return true;
  return Number(group.owner_id) === Number(user.id) && await canManageUsers(user);
}

async function findById(id) {
  await ensureSchema();
  const rows = await TypeORM.getConnection().query('SELECT * FROM class_group WHERE id=? LIMIT 1', [Number(id)]);
  return rows[0] || null;
}

async function refreshCache() {
  await ensureSchema();
  const rows = await TypeORM.getConnection().query(
    `SELECT member.user_id,group_table.id,group_table.name,group_table.tag_text
       FROM class_group_member member
       INNER JOIN class_group group_table ON group_table.id=member.class_id
      WHERE group_table.status='active'
      ORDER BY group_table.name,group_table.id`
  );
  const tags = new Map();
  rows.forEach(row => {
    const userId = Number(row.user_id);
    if (!tags.has(userId)) tags.set(userId, []);
    tags.get(userId).push({ id: Number(row.id), name: row.name, tag: row.tag_text });
  });
  syzoj.userClassTags = tags;
  return tags;
}

async function membershipForUsers(userIds) {
  await ensureSchema();
  const ids = Array.from(new Set((userIds || []).map(Number).filter(id => Number.isSafeInteger(id) && id > 0)));
  if (!ids.length) return { byUser: new Map(), classes: [] };
  const rows = await TypeORM.getConnection().query(
    `SELECT member.user_id,group_table.id,group_table.name,group_table.tag_text
       FROM class_group_member member
       INNER JOIN class_group group_table ON group_table.id=member.class_id
      WHERE group_table.status='active' AND member.user_id IN (?)
      ORDER BY group_table.name,group_table.id`,
    [ids]
  );
  const byUser = new Map();
  const classMap = new Map();
  rows.forEach(row => {
    const item = { id: Number(row.id), name: row.name, tag: row.tag_text };
    const userId = Number(row.user_id);
    if (!byUser.has(userId)) byUser.set(userId, []);
    byUser.get(userId).push(item);
    classMap.set(item.id, item);
  });
  return { byUser, classes: Array.from(classMap.values()).sort((left, right) => left.name.localeCompare(right.name, 'zh-CN')) };
}

function normalizeClassIds(value) {
  const source = Array.isArray(value) ? value : String(value == null ? '' : value).split(',');
  return Array.from(new Set(source.map(Number).filter(id => Number.isSafeInteger(id) && id > 0))).slice(0, 100);
}

function filterUsersByClasses(items, classIds, byUser, getUserId) {
  const selected = new Set(normalizeClassIds(classIds));
  if (!selected.size) return items.slice();
  return items.filter(item => (byUser.get(Number(getUserId(item))) || []).some(group => selected.has(Number(group.id))));
}

module.exports = {
  canManageClass,
  canManageUsers,
  ensureSchema,
  filterUsersByClasses,
  findById,
  isUnrestricted,
  membershipForUsers,
  normalizeClassIds,
  refreshCache
};
