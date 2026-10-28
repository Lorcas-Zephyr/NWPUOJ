'use strict';

// Opt-in deployment verification. Never supplies a usable registration identity
// or credentials. Negative API probes can only exercise rejected registrations.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createLegalService, DOCUMENTS } = require('../libs/legal-documents');

test('published legal pages, footer and opt-in registration work on the deployed origin', {
  skip: process.env.NWPUOJ_LEGAL_LIVE_TEST !== '1', timeout: 90000
}, async () => {
  const { chromium } = require('playwright');
  const origin = process.env.NWPUOJ_LEGAL_LIVE_ORIGIN || 'http://127.0.0.1';
  const service = createLegalService();
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage(), errors = [];
  let publishedVersion, publishedRevision;
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  try {
    for (const item of DOCUMENTS) {
      const response = await page.goto(origin + '/legal/' + item.slug);
      assert.equal(response.status(), 200, item.slug);
      assert.equal(await page.locator('h1').innerText(), item.title);
      assert.match(await page.locator('.app-page-description').innerText(), /生效日期：\d{4}-\d{2}-\d{2}/);
      assert.equal(await page.locator('.app-legal-review').count(), 0);
      assert.equal(await page.locator('.app-footer-legal a').count(), 4);
      const version = (await page.locator('.app-legal-version').innerText()).match(/版本 (\d{4}-\d{2}-\d{2}\.\d+)/)[1];
      const revision = new URL(await page.locator('.app-legal-nav a').first().getAttribute('href'), origin).searchParams.get('version');
      assert.match(revision, /^[a-f0-9]{64}$/);
      if (!publishedVersion) { publishedVersion = version; publishedRevision = revision; }
      assert.equal(version, publishedVersion);
      assert.equal(revision, publishedRevision);
      assert.equal(await page.getByRole('link', { name: '编辑', exact: true }).count(), 0);
      assert.equal((await context.request.get(origin + '/api/v2/admin/legal/' + item.slug)).status(), 401);
      assert.equal((await context.request.get(origin + '/legal/' + item.slug + '/edit')).status(), 401);
    }
    assert.equal((await context.request.get(origin + '/legal/terms?version=' + service.bundle.revision)).status(), 200);
    assert.equal((await context.request.get(origin + '/legal/terms?version=invalid')).status(), 404);
    assert.equal((await context.request.get(origin + '/legal/registration-preview', { maxRedirects: 0 })).status(), 303);

    await page.goto(origin + '/legal/privacy');
    assert.equal(await page.locator('.app-legal-table').count(), 2);
    assert.equal(await page.locator('.app-legal-table [rowspan], .app-legal-table [colspan]').count(), 0);
    assert.match(await page.locator('.app-legal-content').innerText(), /尚未提供监护人同意/);
    if (process.env.NWPUOJ_LEGAL_LIVE_SCREENSHOTS === '1') {
      await page.screenshot({ path: '/tmp/nwpuoj-legal-live-privacy.png', animations: 'disabled' });
    }

    assert.equal((await page.goto(origin + '/sign_up')).status(), 200);
    assert.equal(await page.locator('input[type="checkbox"]').count(), 1);
    assert.equal(await page.locator('#registration-terms').isChecked(), false);
    assert.equal(await page.locator('#registration-age').count(), 0);
    assert.equal(await page.locator('[data-legal-preview]').count(), 0);
    assert.equal(await page.locator('input[name="legal_version"]').inputValue(), publishedRevision);
    const [popup] = await Promise.all([
      page.waitForEvent('popup'),
      page.locator('label[for="registration-terms"]').getByRole('link', { name: '《用户协议》' }).click()
    ]);
    await popup.waitForLoadState('domcontentloaded');
    assert.equal(await popup.locator('h1').innerText(), '用户协议');
    await popup.close();
    assert.equal(await page.locator('#registration-terms').isChecked(), false);
    await page.getByRole('button', { name: '注册', exact: true }).click();
    assert.match(await page.locator('#sign-up-v2-error').innerText(), /请先阅读并确认/);

    if (process.env.NWPUOJ_LEGAL_LIVE_REJECTION_CHECK === '1') {
      for (const probe of [
        { body: { terms_accepted: false, privacy_acknowledged: false, legal_version: publishedRevision }, field: 'terms_accepted' },
        { body: { terms_accepted: true, privacy_acknowledged: true, legal_version: 'outdated-release-probe' }, field: 'legal_version' }
      ]) {
        const result = await page.evaluate(async body => {
          const response = await fetch('/api/v2/auth/register', {
            method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
          });
          return { status: response.status, body: await response.json() };
        }, probe.body);
        assert.equal(result.status, 422, JSON.stringify(result.body));
        assert.ok(result.body.error.fields[probe.field]);
        assert.equal(Boolean(result.body.data && result.body.data.authenticated), false);
      }
    }

    if (process.env.NWPUOJ_LEGAL_LIVE_SCREENSHOTS === '1') {
      await page.reload();
      await page.screenshot({ path: '/tmp/nwpuoj-legal-live-registration.png', fullPage: true, animations: 'disabled' });
    }
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 950 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      assert.equal(await page.locator('#registration-terms').isChecked(), false);
    }
    for (const path of ['/', '/login', '/help', '/contests', '/problems', '/weekly-ranklist']) {
      assert.equal((await context.request.get(origin + path)).status(), 200, path);
    }
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ origin, version: publishedVersion, legalPages: 4, registrationCheckboxes: 1, defaultChecked: false, rejectedRegistrationChecks: process.env.NWPUOJ_LEGAL_LIVE_REJECTION_CHECK === '1', createdAccounts: 0 }));
  } finally {
    await context.close();
    await browser.close();
  }
});
