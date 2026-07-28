const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const TypeORM = require('typeorm');

const User = syzoj.model('user');
const USER_PAGE_SIZE = 30;
const AVATAR_DIR = '/app/static/self/avatar';
const DELETED_ACCOUNT_USERNAME = '账户已删除';
const DELETED_ACCOUNT_EMAIL = 'deleted-account@nwpuoj.invalid';
let deletedAccountPromise = null;

async function canManageUsers(user) {
  return !!(user && (user.is_admin || await user.hasPrivilege('manage_user')));
}

function userManagementError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode || 400;
  return error;
}

function ensureUserManagementCsrfToken(req) {
  if (!req.session.userManagementCsrfToken) {
    req.session.userManagementCsrfToken = crypto.randomBytes(32).toString('hex');
  }
  return req.session.userManagementCsrfToken;
}

function validUserManagementCsrfToken(req) {
  const expected = req.session && req.session.userManagementCsrfToken;
  const actual = req.body && req.body.user_management_csrf_token;
  return typeof expected === 'string' && typeof actual === 'string' && expected.length === actual.length &&
    crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}

function parseRanklist(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value || '{}'); } catch (error) { return { player_num: 0 }; }
}

function removePlayersFromRanklist(value, removedPlayerIds) {
  const current = parseRanklist(value);
  const remaining = [];
  for (let index = 1; index <= Number(current.player_num || 0); index++) {
    const playerId = Number(current[index]);
    if (playerId && !removedPlayerIds.has(playerId)) remaining.push(playerId);
  }
  const next = { player_num: remaining.length };
  remaining.forEach((playerId, index) => { next[index + 1] = playerId; });
  return JSON.stringify(next);
}

function deleteAvatarFile(imagePath) {
  if (!String(imagePath || '').startsWith('/self/avatar/')) return;
  const filename = path.basename(String(imagePath));
  if (!filename || filename === '.' || filename === '..') return;
  try { fs.unlinkSync(path.join(AVATAR_DIR, filename)); } catch (error) {}
}

async function ensureDeletedAccount() {
  if (!deletedAccountPromise) {
    deletedAccountPromise = (async () => {
      const connection = TypeORM.getConnection();
      await connection.query(`
        CREATE TABLE IF NOT EXISTS account_deletion_state (
          id TINYINT NOT NULL,
          deleted_user_id INT NOT NULL,
          created_at INT NOT NULL,
          PRIMARY KEY (id),
          UNIQUE KEY uq_account_deletion_user (deleted_user_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
      return connection.transaction(async manager => {
        const state = await manager.query('SELECT deleted_user_id FROM account_deletion_state WHERE id=1 FOR UPDATE');
        if (state.length) {
          const users = await manager.query('SELECT id FROM user WHERE id=? LIMIT 1', [state[0].deleted_user_id]);
          if (users.length) return Number(users[0].id);
          await manager.query('DELETE FROM account_deletion_state WHERE id=1');
        }
        const conflicts = await manager.query(
          'SELECT id,username,email FROM user WHERE BINARY username=? OR email=? FOR UPDATE',
          [DELETED_ACCOUNT_USERNAME,DELETED_ACCOUNT_EMAIL]
        );
        let deletedUserId;
        const reserved = conflicts.find(user => user.username === DELETED_ACCOUNT_USERNAME && user.email === DELETED_ACCOUNT_EMAIL);
        if (reserved) {
          deletedUserId = Number(reserved.id);
        } else {
          if (conflicts.length) throw new Error(`系统保留账号“${DELETED_ACCOUNT_USERNAME}”发生冲突。`);
          const now = Math.floor(Date.now() / 1000);
          const result = await manager.query(
            `INSERT INTO user
              (username,email,password,nickname,nameplate,information,ac_num,submit_num,is_admin,is_show,
               public_email,prefer_formatted_code,sex,rating,register_time)
             VALUES (?,?,?,?,'',?,0,0,0,0,0,1,0,1500,?)`,
            [
              DELETED_ACCOUNT_USERNAME,
              DELETED_ACCOUNT_EMAIL,
              crypto.randomBytes(16).toString('hex'),
              DELETED_ACCOUNT_USERNAME,
              '该系统账号用于保留已删除用户的公开内容。',
              now
            ]
          );
          deletedUserId = Number(result.insertId);
        }
        await manager.query(
          'INSERT INTO account_deletion_state (id,deleted_user_id,created_at) VALUES (1,?,?)',
          [deletedUserId,Math.floor(Date.now() / 1000)]
        );
        return deletedUserId;
      });
    })().then(userId => {
      syzoj.deletedAccountUserId = userId;
      return userId;
    }).catch(error => {
      deletedAccountPromise = null;
      throw error;
    });
  }
  return deletedAccountPromise;
}

async function deleteUserAccount(req, actor, targetId) {
  const actorIsOwner = await syzoj.utils.isSiteOwnerAccount(actor);
  const deletedAccountId = await ensureDeletedAccount();
  let avatarPath = null;
  let deletedUsername = null;
  await TypeORM.getConnection().transaction(async manager => {
    const users = await manager.query('SELECT id,username,is_admin FROM user WHERE id=? FOR UPDATE', [targetId]);
    if (!users.length) throw userManagementError('用户不存在。', 404);
    const target = users[0];
    if (Number(target.id) === Number(actor.id)) throw userManagementError('不能删除当前登录账号。', 409);
    if (Number(target.id) === Number(syzoj.siteOwnerUserId || 0)) throw userManagementError('站长账号不能删除。', 409);
    if (Number(target.id) === deletedAccountId) throw userManagementError('系统保留账号不能删除。', 409);
    if (target.is_admin && !actorIsOwner) throw userManagementError('只有站长可以删除其他全站管理员。', 403);

    const avatarRows = await manager.query('SELECT image_path FROM user_avatar WHERE user_id=? FOR UPDATE', [targetId]);
    avatarPath = avatarRows.length ? avatarRows[0].image_path : null;
    const players = await manager.query(
      `SELECT player.id AS player_id,contest.ranklist_id,ranklist.ranklist
       FROM contest_player player
       INNER JOIN contest ON contest.id=player.contest_id
       INNER JOIN contest_ranklist ranklist ON ranklist.id=contest.ranklist_id
       WHERE player.user_id=? FOR UPDATE`,
      [targetId]
    );
    await manager.query('SELECT id FROM judge_state WHERE user_id=? FOR UPDATE', [targetId]);
    await manager.query('UPDATE judge_state SET user_id=? WHERE user_id=?', [deletedAccountId,targetId]);
    await manager.query('UPDATE judge_state_admin_action SET affected_user_id=? WHERE affected_user_id=?', [deletedAccountId,targetId]);
    await manager.query('UPDATE judge_state_admin_action SET operator_id=? WHERE operator_id=?', [deletedAccountId,targetId]);
    await manager.query('DELETE FROM contest_player WHERE user_id=?', [targetId]);
    for (const player of players) {
      await manager.query(
        'UPDATE contest_ranklist SET ranklist=? WHERE id=?',
        [removePlayersFromRanklist(player.ranklist, new Set([Number(player.player_id)])), Number(player.ranklist_id)]
      );
    }
    const contests = await manager.query("SELECT id,admins FROM contest WHERE admins IS NOT NULL AND admins<>'' FOR UPDATE");
    for (const contest of contests) {
      const admins = String(contest.admins).split('|').map(Number).filter(id => id > 0 && id !== targetId);
      if (admins.join('|') !== String(contest.admins)) {
        await manager.query('UPDATE contest SET admins=? WHERE id=?', [admins.join('|'),contest.id]);
      }
    }

    await manager.query('DELETE FROM submission_statistics WHERE user_id=?', [targetId]);
    await manager.query('DELETE FROM rating_history WHERE user_id=?', [targetId]);
    await manager.query('DELETE FROM contest_registration_removal WHERE user_id=?', [targetId]);
    await manager.query('UPDATE contest_registration_removal SET removed_by=? WHERE removed_by=?', [deletedAccountId,targetId]);
    await manager.query('UPDATE contest_rating_config SET updated_by=? WHERE updated_by=?', [deletedAccountId,targetId]);
    await manager.query('UPDATE contest SET holder_id=? WHERE holder_id=?', [deletedAccountId,targetId]);
    await manager.query('UPDATE problem SET user_id=? WHERE user_id=?', [deletedAccountId,targetId]);
    await manager.query('UPDATE problem SET publicizer_id=? WHERE publicizer_id=?', [deletedAccountId,targetId]);
    await manager.query('UPDATE article SET user_id=? WHERE user_id=?', [deletedAccountId,targetId]);
    await manager.query('UPDATE article_comment SET user_id=? WHERE user_id=?', [deletedAccountId,targetId]);
    await manager.query('UPDATE problem_solution SET user_id=? WHERE user_id=?', [deletedAccountId,targetId]);
    await manager.query('UPDATE problem_solution SET reviewer_id=? WHERE reviewer_id=?', [deletedAccountId,targetId]);
    await manager.query('UPDATE problem_solution_comment SET user_id=? WHERE user_id=?', [deletedAccountId,targetId]);
    await manager.query('UPDATE problem_solution_setting SET updated_by=? WHERE updated_by=?', [deletedAccountId,targetId]);
    await manager.query('UPDATE benben_post SET user_id=? WHERE user_id=?', [deletedAccountId,targetId]);
    await manager.query('UPDATE benben_image SET uploader_id=? WHERE uploader_id=?', [deletedAccountId,targetId]);
    await manager.query('UPDATE ticket SET creator_id=? WHERE creator_id=?', [deletedAccountId,targetId]);
    await manager.query('UPDATE ticket_reply SET user_id=? WHERE user_id=?', [deletedAccountId,targetId]);
    await manager.query('UPDATE ticket_attachment SET uploader_id=? WHERE uploader_id=?', [deletedAccountId,targetId]);
    await manager.query('UPDATE homepage_banner SET created_by=? WHERE created_by=?', [deletedAccountId,targetId]);
    await manager.query('UPDATE ticket SET assignee_id=NULL WHERE assignee_id=?', [targetId]);
    await manager.query('UPDATE notification SET actor_id=? WHERE actor_id=?', [deletedAccountId,targetId]);
    await manager.query('DELETE FROM notification WHERE recipient_id=?', [targetId]);
    await manager.query('DELETE FROM private_message WHERE sender_id=? OR receiver_id=?', [targetId,targetId]);
    await manager.query('DELETE FROM user_follow WHERE follower_id=? OR followee_id=?', [targetId,targetId]);
    await manager.query('DELETE FROM account_password_reset WHERE user_id=?', [targetId]);
    await manager.query('DELETE FROM email_verification_token WHERE user_id=?', [targetId]);
    await manager.query('DELETE FROM content_form_token WHERE user_id=?', [targetId]);
    await manager.query('DELETE FROM clipboard_item WHERE user_id=?', [targetId]);
    await manager.query('DELETE FROM user_hit_score_history WHERE user_id=?', [targetId]);
    await manager.query('DELETE FROM user_hit_score WHERE user_id=?', [targetId]);
    await manager.query('DELETE FROM user_hit_setting WHERE user_id=?', [targetId]);
    await manager.query('DELETE FROM user_message_setting WHERE user_id=?', [targetId]);
    await manager.query('DELETE FROM user_email_status WHERE user_id=?', [targetId]);
    await manager.query('DELETE FROM user_registration_profile WHERE user_id=?', [targetId]);
    await manager.query('DELETE FROM temporary_contest_account WHERE user_id=?', [targetId]);
    await manager.query('DELETE FROM user_privilege WHERE user_id=?', [targetId]);
    await manager.query('UPDATE user_tag SET granted_by=? WHERE granted_by=?', [deletedAccountId,targetId]);
    await manager.query('UPDATE user_tag SET disabled_by=? WHERE disabled_by=?', [deletedAccountId,targetId]);
    await manager.query('DELETE FROM user_tag WHERE user_id=?', [targetId]);
    await manager.query('DELETE FROM user_avatar WHERE user_id=?', [targetId]);
    await manager.query('DELETE FROM user WHERE id=?', [targetId]);
    deletedUsername = String(target.username);
  });

  deleteAvatarFile(avatarPath);
  User.deleteFromCache(targetId);
  if (syzoj.userHitScores) syzoj.userHitScores.delete(targetId);
  if (syzoj.userHitHidden) syzoj.userHitHidden.delete(targetId);
  if (syzoj.cheaterUserIds) syzoj.cheaterUserIds.delete(targetId);
  if (syzoj.utils.revokeUserSessions) await syzoj.utils.revokeUserSessions(req, targetId);
  if (syzoj.refreshAdminUserIds) await syzoj.refreshAdminUserIds();
  if (syzoj.utils.refreshVerifiedCache) await syzoj.utils.refreshVerifiedCache();
  if (syzoj.utils.refreshAvatarCache) await syzoj.utils.refreshAvatarCache();
  if (syzoj.utils.refreshUserTagsCache) await syzoj.utils.refreshUserTagsCache();
  if (syzoj.utils.refreshContestCheaterCache) await syzoj.utils.refreshContestCheaterCache();
  return deletedUsername;
}

function userSearchCondition(keyword) {
  if (!keyword) return { sql: '', params: [] };
  return {
    sql: 'WHERE (u.username LIKE ? OR u.email LIKE ? OR CAST(u.id AS CHAR)=?)',
    params: [`%${keyword}%`, `%${keyword}%`, keyword]
  };
}

app.get('/admin/users', async (req, res) => {
  try {
    if (!await canManageUsers(res.locals.user)) {
      return res.status(403).render('error', { err: new ErrorMessage('您没有权限管理用户。') });
    }

    const keyword = String(req.query.q || '').trim().slice(0, 80);
    const requestedPage = Number.parseInt(req.query.page, 10);
    const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
    const condition = userSearchCondition(keyword);
    const connection = TypeORM.getConnection();
    const countRows = await connection.query(
      `SELECT COUNT(*) AS count FROM user u ${condition.sql}`,
      condition.params
    );
    const total = Number(countRows[0] && countRows[0].count || 0);
    const totalPages = Math.max(1, Math.ceil(total / USER_PAGE_SIZE));
    const currentPage = Math.min(page, totalPages);
    const users = await connection.query(
      `SELECT u.id,u.username,u.email,u.is_admin,u.is_show,u.rating,u.register_time,
              COALESCE(email_status.is_email_verified,0) AS is_email_verified,
              GROUP_CONCAT(DISTINCT privilege.privilege ORDER BY privilege.privilege SEPARATOR ',') AS privileges,
              EXISTS(
                SELECT 1 FROM judge_state cheated_submission
                INNER JOIN judge_state_admin_action cheated_action
                  ON cheated_action.judge_id=cheated_submission.id
                 AND cheated_action.action_type='cheated'
                WHERE cheated_submission.user_id=u.id
              ) AS is_cheater
       FROM user u
       LEFT JOIN user_email_status email_status ON email_status.user_id=u.id
       LEFT JOIN user_privilege privilege ON privilege.user_id=u.id
       ${condition.sql}
       GROUP BY u.id,u.username,u.email,u.is_admin,u.is_show,u.rating,u.register_time,email_status.is_email_verified
       ORDER BY u.id DESC
       LIMIT ? OFFSET ?`,
      condition.params.concat([USER_PAGE_SIZE, (currentPage - 1) * USER_PAGE_SIZE])
    );
    users.forEach(user => {
      user.privilegeList = user.privileges ? String(user.privileges).split(',').filter(Boolean) : [];
    });
    if (users.length) {
      if (syzoj.utils.ensureTemporaryContestAccountSchema) await syzoj.utils.ensureTemporaryContestAccountSchema();
      const temporaryRows = await connection.query(
        `SELECT account.user_id,account.contest_id,
                COALESCE(contest.end_time,account.expires_at) AS expires_at,
                contest.title AS contest_title
         FROM temporary_contest_account account
         LEFT JOIN contest ON contest.id=account.contest_id
         WHERE account.user_id IN (?)`,
        [users.map(user => Number(user.id))]
      );
      const temporaryByUserId = new Map(temporaryRows.map(row => [Number(row.user_id), row]));
      users.forEach(user => { user.temporaryAccount = temporaryByUserId.get(Number(user.id)) || null; });
    }

    const usersPageUrl = targetPage => syzoj.utils.makeUrl(['admin', 'users'], {
      q: keyword || undefined,
      page: targetPage > 1 ? targetPage : undefined
    });
    res.render('admin_users', {
      users,
      keyword,
      total,
      totalPages,
      currentPage,
      usersPageUrl,
      userManagementCsrfToken: ensureUserManagementCsrfToken(req),
      deletedAccountUserId: await ensureDeletedAccount()
    });
  } catch (error) {
    syzoj.log('[admin-users] ' + (error.message || error));
    res.status(error.statusCode || 500).render('error', { err: error });
  }
});

ensureDeletedAccount().catch(error => {
  syzoj.log('[admin-users] deleted account initialization failed: ' + (error.message || error));
  process.exit(1);
});

app.post('/admin/users/:id/delete', async (req, res) => {
  try {
    const actor = res.locals.user;
    const targetId = Number(req.params.id);
    if (!await canManageUsers(actor)) throw userManagementError('您没有权限删除用户。', 403);
    if (!Number.isSafeInteger(targetId) || targetId <= 0) throw userManagementError('用户 ID 不正确。');
    if (!validUserManagementCsrfToken(req)) throw userManagementError('页面已失效，请刷新用户管理页后重试。', 403);
    const username = await deleteUserAccount(req, actor, targetId);
    res.redirect(303, syzoj.utils.makeUrl(['admin', 'users'], { deleted: username }));
  } catch (error) {
    syzoj.log('[admin-users] delete failed: ' + (error.message || error));
    res.status(error.statusCode || 400).render('error', { err: error });
  }
});
