const assert = require('assert');
const http = require('http');
const querystring = require('querystring');

async function main() {
  let submitted = false;
  let submittedForm = null;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const authenticated = /poj_session=ok/.test(req.headers.cookie || '');
    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        const form = querystring.parse(body);
        if (url.pathname === '/login' && form.user_id1 === 'tester' && form.password1 === 'secret') {
          res.writeHead(302, { Location: '/', 'Set-Cookie': 'poj_session=ok; Path=/' });
          return res.end();
        }
        if (url.pathname === '/submit' && authenticated) {
          submitted = true;
          submittedForm = form;
          res.writeHead(302, { Location: '/status' });
          return res.end();
        }
        res.writeHead(403);
        res.end();
      });
      return;
    }
    if (url.pathname === '/') {
      res.end(authenticated
        ? '<a href="userstatus?user_id=tester">tester</a><a href="login?action=logout">Log Out</a>'
        : '<form action="/login"><input name="user_id1"></form>');
      return;
    }
    if (url.pathname === '/problem' && authenticated) {
      res.end('<div class="ptt">Mock Problem</div>' +
        '<div class="plm"><b>Time Limit:</b> 1000MS <b>Memory Limit:</b> 32768K</div>' +
        '<p class="pst">Description</p><div class="ptx">Mock</div>');
      return;
    }
    if (url.pathname === '/submit' && authenticated) {
      res.end('<form action="submit"><select name="language"><option value="0">G++</option></select>' +
        '<textarea name="source"></textarea><input name="encoded" value="1"></form>');
      return;
    }
    if (url.pathname === '/status' && authenticated) {
      res.end('<table class="a">' + (submitted
        ? '<tr><td>12345</td><td>tester</td><td>1000</td><td>Accepted</td><td>1024K</td>' +
          '<td>15MS</td><td>G++</td><td>13B</td><td>2026-07-17 17:00:55</td></tr>'
        : '') + '</table>');
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    process.env.SYZOJ_WEB_POJ_ENDPOINT = 'http://127.0.0.1:' + address.port;
    process.env.SYZOJ_WEB_POJ_USERNAME = 'tester';
    process.env.SYZOJ_WEB_POJ_PASSWORD = 'secret';
    const poj = require(process.env.POJ_VJUDGE_MODULE || '../libs-built/vjudge/poj');
    await poj.verifyAccount();
    const problem = await poj.fetchProblem(1000);
    assert.strictEqual(problem.title, 'Mock Problem');
    let submittingMarker;
    const submissionId = await poj._test.submitOnce(1000, 'poj.G++', 'int main() {}', marker => {
      submittingMarker = marker;
    });
    assert.strictEqual(submissionId, 12345);
    assert.deepStrictEqual(submittingMarker, { beforeId: 0, expectedLanguage: 'G++', codeLength: 13 });
    assert.strictEqual(submittedForm.problem_id, '1000');
    assert.strictEqual(submittedForm.language, '0');
    assert.strictEqual(submittedForm.encoded, '1');
    assert.strictEqual(Buffer.from(submittedForm.source, 'base64').toString('utf8'), 'int main() {}');
    console.log('POJ protocol tests passed');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
