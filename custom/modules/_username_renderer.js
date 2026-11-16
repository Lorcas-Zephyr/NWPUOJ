// Global roles have fixed name styles; ordinary accounts follow Codeforces Rating tiers.
function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, function(c) {
    return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c];
  });
}

function ratingTier(rating) {
  if (rating >= 3000) return 'legendary';
  if (rating >= 2400) return 'red';
  if (rating >= 2100) return 'orange';
  if (rating >= 1900) return 'violet';
  if (rating >= 1600) return 'blue';
  if (rating >= 1400) return 'cyan';
  if (rating >= 1200) return 'green';
  return 'gray';
}

function userRating(user) {
  const id = Number(user && user.id);
  return syzoj.userRatings && syzoj.userRatings.has(id) ? syzoj.userRatings.get(id) : Number(user && user.rating || 0);
}

function calcTier(user) {
  if (!user) return 'default';
  if (Number(syzoj.siteOwnerUserId) === Number(user.id)) return 'owner';
  if (syzoj.adminUserIds && syzoj.adminUserIds.has(Number(user.id))) return 'admin';
  if (syzoj.cheaterUserIds && syzoj.cheaterUserIds.has(Number(user.id))) return 'cheater';
  return ratingTier(userRating(user));
}

syzoj.utils.ratingTier = ratingTier;
syzoj.utils.userRating = userRating;
syzoj.utils.ratingTitle = function (user) {
  const value = userRating(user);
  if (value >= 3000) return 'Legendary Grandmaster';
  if (value >= 2600) return 'International Grandmaster';
  if (value >= 2400) return 'Grandmaster';
  if (value >= 2300) return 'International Master';
  if (value >= 2100) return 'Master';
  if (value >= 1900) return 'Candidate Master';
  if (value >= 1600) return 'Expert';
  if (value >= 1400) return 'Specialist';
  if (value >= 1200) return 'Pupil';
  return 'Newbie';
};

// 渲染 tag HTML
// 优先级:
//   1. 非 admin 且为 cheater → 不显示用户名牌子
//   2. 在 syzoj.userTags 缓存中且 text 非空 → 用户自定义 tag
//   3. 否则不显示 tag
function renderTagHtml(user, tier) {
  if (!user) return '';

  // Only hide the name badge; retain the underlying mark, name color and
  // existing suppression of the user's custom nameplate.
  if (tier === 'cheater') return '';

  if (syzoj.userTagsEnabled === false) return '';
  if (!syzoj.userTags || !syzoj.userTags.has(user.id)) return '';
  let t = syzoj.userTags.get(user.id);
  if (!t || !t.text) return '';
  return ' <span class="user-name-tag tag-tier-' + (t.tier || 'default') +
    '">' + escapeHtml(t.text) + '</span>';
}

function renderClassTagsHtml(user) {
  if (!user || !syzoj.userClassTags || !syzoj.userClassTags.has(Number(user.id))) return '';
  const groups = syzoj.userClassTags.get(Number(user.id)) || [];
  const visible = groups.slice(0, 2).map(group =>
    ' <span class="user-name-tag tag-tier-blue" title="班级：' + escapeHtml(group.name) + '">' + escapeHtml(group.tag) + '</span>'
  ).join('');
  if (groups.length <= 2) return visible;
  return visible + ' <span class="user-name-tag tag-tier-default" title="' + escapeHtml(groups.slice(2).map(group => group.name).join('、')) + '">+' + (groups.length - 2) + '</span>';
}

syzoj.utils.renderUsername = function(user, options) {
  options = options || {};

  if (!user) {
    return '<span class="username-tier-unknown">(未知用户)</span>';
  }

  let tier = calcTier(user);
  let url = '/user/' + user.id;
  let username = escapeHtml(user.username || '');
  let nameplate = syzoj.userTagsEnabled === false ? '' : (user.nameplate || '');
  let tagHtml = options.noTag ? '' : renderTagHtml(user, tier) + renderClassTagsHtml(user);

  if (options.noLink) {
    return '<span class="username-tier-' + tier + '">' + username + '</span>' + tagHtml + nameplate;
  }

  return '<a href="' + url + '" class="username-tier-' + tier + '">' +
         username + '</a>' + tagHtml + nameplate;
};

// 暴露 calcTier(给其他模块用,比如 user_edit 模板要判断 tier)
syzoj.utils.calcUserTier = calcTier;

syzoj.utils.plainUsername = function(user) {
  if (!user) return '(未知用户)';
  return user.username || '';
};
