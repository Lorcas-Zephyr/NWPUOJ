'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const baseUrl = String(process.env.VISUAL_BASE_URL || 'http://127.0.0.1').replace(/\/$/, '');
const outputDir = process.env.VISUAL_OUTPUT_DIR || '/visual-output';
const contestId = String(process.env.VISUAL_CONTEST_ID || '900058');
const scenarioFilter = String(process.env.VISUAL_SCENARIO || '').trim();
const pageFilter = String(process.env.VISUAL_PAGE || '').trim();

const pages = [
  ['home', '/'],
  ['problems', '/problems'],
  ['problem', '/problem/1'],
  ['submissions', '/submissions'],
  ['contests', '/contests'],
  ['contest', `/contest/${contestId}`],
  ['help', '/help'],
  ['login', '/login']
];

const scenarios = [
  { name: 'mobile-360x800', viewport: { width: 360, height: 800 }, pages },
  { name: 'tablet-768x1024', viewport: { width: 768, height: 1024 }, pages },
  { name: 'tablet-landscape-1024x768', viewport: { width: 1024, height: 768 }, pages },
  { name: 'desktop-1440x900', viewport: { width: 1440, height: 900 }, pages },
  {
    name: 'zoom-200',
    viewport: { width: 720, height: 450 },
    deviceScaleFactor: 2,
    pages
  },
  {
    name: 'dark-mobile',
    viewport: { width: 360, height: 800 },
    colorScheme: 'dark',
    pages: pages.filter(([name]) => ['home', 'problems', 'problem', 'contest', 'submissions'].includes(name))
  },
  {
    name: 'dark-desktop',
    viewport: { width: 1440, height: 900 },
    colorScheme: 'dark',
    pages: pages.filter(([name]) => ['home', 'problems', 'problem', 'contest', 'submissions'].includes(name))
  },
  {
    name: 'reduced-motion-mobile',
    viewport: { width: 360, height: 800 },
    reducedMotion: 'reduce',
    pages: pages.filter(([name]) => ['home', 'problem', 'contest'].includes(name))
  },
  {
    name: 'reduced-motion-desktop',
    viewport: { width: 1440, height: 900 },
    reducedMotion: 'reduce',
    pages: pages.filter(([name]) => ['home', 'problem', 'contest'].includes(name))
  }
];

async function inspectPage(page, scenario) {
  return page.evaluate(({ expectedTheme, expectedReducedMotion }) => {
    function isVisible(rect, style) {
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    }
    const root = document.documentElement;
    const body = document.body;
    const main = document.querySelector('main, .app-main, .app-page, #content');
    const bodyText = main ? main.innerText.trim() : '';
    const controls = Array.from(document.querySelectorAll(
      'button, .app-button, .app-icon-button, input[type="button"], input[type="submit"]'
    ));
    const overflowingControls = controls.filter(element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (!isVisible(rect, style)) return false;
      return element.scrollWidth > element.clientWidth + 2 || element.scrollHeight > element.clientHeight + 2;
    }).map(element => ({
      text: (element.textContent || element.getAttribute('aria-label') || '').trim().slice(0, 80),
      className: String(element.className || ''),
      client: [element.clientWidth, element.clientHeight],
      scroll: [element.scrollWidth, element.scrollHeight]
    }));
    const unnamedIconButtons = Array.from(document.querySelectorAll('.app-icon-button')).filter(element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (!isVisible(rect, style)) return false;
      return !(element.getAttribute('aria-label') || element.getAttribute('title') || element.textContent.trim());
    }).length;
    const brokenImages = Array.from(document.images).filter(image => {
      const rect = image.getBoundingClientRect();
      const style = getComputedStyle(image);
      return isVisible(rect, style) && image.complete && image.naturalWidth === 0;
    }).map(image => image.currentSrc || image.src);
    const fixedChrome = Array.from(document.querySelectorAll('.app-topbar, .app-sidebar')).filter(element => {
      const rect = element.getBoundingClientRect();
      return isVisible(rect, getComputedStyle(element));
    }).map(element => ({
      className: element.className,
      left: element.getBoundingClientRect().left,
      right: element.getBoundingClientRect().right,
      top: element.getBoundingClientRect().top,
      bottom: element.getBoundingClientRect().bottom
    }));
    const edgeOverflowElements = Array.from(document.body.querySelectorAll('*')).filter(element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (!isVisible(rect, style) || rect.bottom < 0 || rect.top > innerHeight) return false;
      return rect.right > innerWidth + 2;
    }).slice(0, 20).map(element => {
      const rect = element.getBoundingClientRect();
      return {
        tag: element.tagName.toLowerCase(),
        className: String(element.className || '').slice(0, 120),
        text: (element.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80),
        rect: [Math.round(rect.left), Math.round(rect.right), Math.round(rect.width)]
      };
    });
    return {
      title: document.title,
      bodyTextLength: bodyText.length,
      viewport: [innerWidth, innerHeight],
      documentWidth: Math.max(root.scrollWidth, body.scrollWidth),
      horizontalOverflow: Math.max(root.scrollWidth, body.scrollWidth) > innerWidth + 2,
      overflowingControls,
      unnamedIconButtons,
      brokenImages,
      duplicateIds: Array.from(document.querySelectorAll('[id]')).map(element => element.id)
        .filter(id => id && !id.startsWith('MJX-'))
        .filter((id, index, ids) => ids.indexOf(id) !== index),
      theme: root.getAttribute('data-theme'),
      expectedTheme,
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      expectedReducedMotion,
      fixedChrome,
      edgeOverflowElements
    };
  }, {
    expectedTheme: scenario.colorScheme === 'dark' ? 'dark' : 'light',
    expectedReducedMotion: scenario.reducedMotion === 'reduce'
  });
}

async function main() {
  fs.mkdirSync(outputDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const report = [];
  const failures = [];
  try {
    for (const scenario of scenarios.filter(item => !scenarioFilter || item.name === scenarioFilter)) {
      const context = await browser.newContext({
        viewport: scenario.viewport,
        deviceScaleFactor: scenario.deviceScaleFactor || 1,
        colorScheme: scenario.colorScheme || 'light',
        reducedMotion: scenario.reducedMotion || 'no-preference'
      });
      for (const [pageName, pagePath] of scenario.pages.filter(([name]) => !pageFilter || name === pageFilter)) {
        const page = await context.newPage();
        const consoleErrors = [];
        const pageErrors = [];
        page.on('console', message => {
          if (message.type() === 'error') consoleErrors.push(message.text());
        });
        page.on('pageerror', error => pageErrors.push(error.message));
        const response = await page.goto(baseUrl + pagePath, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(700);
        const inspection = await inspectPage(page, scenario);
        const screenshot = path.join(outputDir, `${scenario.name}-${pageName}.png`);
        await page.screenshot({ path: screenshot, fullPage: false, animations: 'disabled' });
        const item = {
          scenario: scenario.name,
          page: pageName,
          path: pagePath,
          status: response ? response.status() : 0,
          screenshot: path.basename(screenshot),
          consoleErrors,
          pageErrors,
          ...inspection
        };
        report.push(item);
        const itemFailures = [];
        if (item.status !== 200) itemFailures.push(`HTTP ${item.status}`);
        if (item.bodyTextLength < 20) itemFailures.push('main content is blank');
        if (item.horizontalOverflow) itemFailures.push(`document width ${item.documentWidth} exceeds ${item.viewport[0]}`);
        if (item.overflowingControls.length) itemFailures.push(`${item.overflowingControls.length} controls overflow`);
        if (item.unnamedIconButtons) itemFailures.push(`${item.unnamedIconButtons} icon buttons lack an accessible name`);
        if (item.brokenImages.length) itemFailures.push(`${item.brokenImages.length} visible images are broken`);
        if (item.duplicateIds.length) itemFailures.push(`duplicate IDs: ${Array.from(new Set(item.duplicateIds)).join(', ')}`);
        if (item.theme !== item.expectedTheme) itemFailures.push(`theme is ${item.theme}, expected ${item.expectedTheme}`);
        if (item.reducedMotion !== item.expectedReducedMotion) itemFailures.push('reduced-motion media query mismatch');
        if (item.pageErrors.length) itemFailures.push(`${item.pageErrors.length} uncaught page errors`);
        if (itemFailures.length) failures.push({ scenario: item.scenario, page: item.page, failures: itemFailures });
        await page.close();
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }
  fs.writeFileSync(path.join(outputDir, 'report.json'), JSON.stringify({ baseUrl, report, failures }, null, 2));
  console.log(`Visual acceptance: ${report.length} renders, ${failures.length} failures.`);
  if (failures.length) {
    failures.forEach(item => console.error(`${item.scenario}/${item.page}: ${item.failures.join('; ')}`));
    process.exitCode = 1;
  }
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
