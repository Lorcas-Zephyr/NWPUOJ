const jwt = require('jsonwebtoken');
const url = require('url');

function verifyJWT(token) {
  try {
    jwt.verify(token, syzoj.config.session_secret);
    return true;
  } catch (error) {
    return false;
  }
}

app.apiRouter.get('/api/v2/download/:token', async (req, res) => {
  try {
    const token = req.params.token;
    const data = jwt.decode(token);
    if (!data) throw new ErrorMessage('无效的令牌。');
    if (url.parse(syzoj.utils.getCurrentLocation(req, true)).href !== url.parse(syzoj.config.site_for_download).href) {
      throw new ErrorMessage('无效的下载地址。');
    }
    if (verifyJWT(token)) res.download(data.filename, data.sendName);
    else res.redirect(data.originUrl);
  } catch (error) {
    syzoj.log(error);
    res.render('error', { err: error });
  }
});
