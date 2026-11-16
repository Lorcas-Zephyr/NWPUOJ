// The former Hit engine is retired. Keep this mounted module as the account
// rating cache so existing deployments no longer schedule Hit calculations.
const TypeORM = require('typeorm');
syzoj.userRatings = new Map();
let refreshing = false;
async function refreshUserRatings(userIds) {
  if (userIds && !userIds.length) return;
  if (!userIds && refreshing) return;
  if (!userIds) refreshing = true;
  try {
    const rows = await TypeORM.getConnection().query('SELECT id,rating FROM user' + (userIds ? ' WHERE id IN (?)' : ''), userIds ? [userIds] : []);
    if (userIds) rows.forEach(row => syzoj.userRatings.set(Number(row.id), Number(row.rating)));
    else syzoj.userRatings = new Map(rows.map(row => [Number(row.id), Number(row.rating)]));
  } finally { if (!userIds) refreshing = false; }
}
syzoj.utils.refreshUserRatings = refreshUserRatings;
async function initializeRatingCache() {
  try { await refreshUserRatings(); }
  catch (error) { setTimeout(initializeRatingCache, 1000); }
}
setTimeout(initializeRatingCache, 0);
setInterval(() => refreshUserRatings().catch(error => syzoj.log('[rating-cache] ' + error.message)), 60000);
function hitRetired(req, res) {
  return syzoj.utils.apiV2.fail(res, 410, 'HIT_RETIRED', 'Hit has been retired. Use Rating instead.');
}
app.post('/api/v2/admin/hit/recalculate', hitRetired);
app.get('/api/v2/me/hit-settings', hitRetired);
app.patch('/api/v2/me/hit-settings', hitRetired);
app.get('/help/hit-value', (req, res) => res.redirect(301, '/help/rating'));
app.get('/help/rating', (req, res) => res.render('help_hit_value'));
