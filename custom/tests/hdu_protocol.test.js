const assert = require('assert');
const http = require('http');
const querystring = require('querystring');

async function main() {
  let submitted = false;
  let submittedForm = null;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const authenticated = /hdu_session=ok/.test(req.headers.cookie || '');

    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        const form = querystring.parse(body);
        if (url.pathname === '/userloginex.php' && form.username === 'tester' && form.userpass === 'secret') {
          res.writeHead(302, { Location: '/', 'Set-Cookie': 'hdu_session=ok; Path=/' });
          return res.end();
        }
        if (url.pathname === '/submit.php' && authenticated) {
          if (form.check !== '4321' || !form._usercode || form.usercode != null) {
            res.writeHead(400);
            return res.end();
          }
          submitted = true;
          submittedForm = form;
          res.writeHead(302, { Location: '/status.php' });
          return res.end();
        }
        res.writeHead(403);
        res.end();
      });
      return;
    }

    if (url.pathname === '/') {
      res.end(authenticated
        ? '<a href="/userstatus.php?user=tester">tester</a><a href="/userloginex.php?action=logout">Sign Out</a>'
        : '<form action="/userloginex.php?action=login"><input name="username"></form>');
      return;
    }
    if (url.pathname === '/showproblem.php' && authenticated) {
      res.end('<h1 style="color:#1A5CC8">Mock Problem</h1>' +
        '<span>Time Limit: 1000 MS Memory Limit: 32768 K</span>' +
        '<div class="panel_title">Problem Description</div><div class="panel_content">Mock</div>');
      return;
    }
    if (url.pathname === '/submit.php' && authenticated) {
      res.end('<form action="/submit.php?action=submit"><select name="check"><option value="0"></option>' +
        '<option value="4321">4321</option><option value="9876">9876</option></select>' +
        '<select name="language"><option value="0">G++</option></select></form>');
      return;
    }
    if (url.pathname === '/ck.php' && authenticated) {
      res.end('captcha');
      return;
    }
    if (url.pathname === '/status.php' && authenticated) {
      res.end('<table class="table_text">' + (submitted
        ? '<tr><td>12345</td><td>2026-07-16</td><td>Accepted</td><td>1000</td><td>0MS</td><td>1024K</td><td>13B</td><td>G++</td><td>tester</td></tr>'
        : '') + '</table>');
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    process.env.SYZOJ_WEB_HDU_ENDPOINT = 'http://127.0.0.1:' + address.port;
    process.env.SYZOJ_WEB_HDU_USERNAME = 'tester';
    process.env.SYZOJ_WEB_HDU_PASSWORD = 'secret';
    const hdu = require(process.env.HDU_VJUDGE_MODULE || '../libs-built/vjudge/hdu');
    hdu._test.setCaptchaRecognizer(async (image, candidates) => {
      assert.strictEqual(image.toString(), 'captcha');
      assert.ok(candidates.includes('4321'));
      return '4321';
    });

    await hdu.verifyAccount();
    const problem = await hdu.fetchProblem(1000);
    assert.strictEqual(problem.title, 'Mock Problem');
    let submittingMarker;
    const submissionId = await hdu._test.submitOnce(1000, 'hdu.G++', 'int main() {}', marker => {
      submittingMarker = marker;
    });
    assert.strictEqual(submissionId, 12345);
    assert.deepStrictEqual(submittingMarker, { beforeId: 0, expectedLanguage: 'G++', codeLength: 13 });
    assert.strictEqual(submittedForm.problemid, '1000');
    assert.strictEqual(submittedForm.language, '0');
    assert.strictEqual(submittedForm.check, '4321');
    assert.strictEqual(
      decodeURIComponent(Buffer.from(submittedForm._usercode, 'base64').toString('latin1')),
      'int main() {}'
    );
    assert.strictEqual(submittedForm.usercode, undefined);
    console.log('HDU protocol tests passed');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
