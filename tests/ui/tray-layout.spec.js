import { test, expect } from '@playwright/test';

async function openTray(page, projectName, maxHeight = 900) {
  await page.addInitScript(({ maxHeight }) => {
    window.__trayActions = [];
    window.__cspErrors = [];
    document.addEventListener('securitypolicyviolation', event => window.__cspErrors.push(event.violatedDirective));
    let enabled = false;
    const publish = () => window.__setTrayState?.({
      ready: true, endpoint: '127.0.0.1:30141', version: 'v0.15.0', label: 'Isolated UI fixture',
      autostart: { enabled, error: null }, maxHeight,
    });
    // Only simulate intercepted native signals; never use real Tauri/Run values.
    window.open = url => {
      const action = new URL(url).pathname.slice(1);
      window.__trayActions.push(action);
      if (action === 'ready') queueMicrotask(publish);
      if (action === 'autostart-toggle') { enabled = !enabled; queueMicrotask(publish); }
      return null;
    };
  }, { maxHeight });
  await page.goto('/tray.html');
  await expect(page.getByRole('switch', { name: '开机自启' })).toBeEnabled();
  if (projectName.includes('large-font')) await page.evaluate(() => { document.documentElement.style.fontSize = '26px'; });
  await page.evaluate(() => document.fonts.ready);
  return fitViewport(page, maxHeight);
}

async function fitViewport(page, maxHeight) {
  let previous = '';
  for (let attempt = 0; attempt < 8; attempt++) {
    await page.waitForTimeout(50);
    const action = await page.evaluate(() => window.__trayActions.filter(value => value.startsWith('resize-')).at(-1));
    expect(action).toMatch(/^resize-\d+-\d+$/);
    if (action === previous) return action;
    previous = action;
    const [, width, height] = action.split('-').map(Number);
    await page.setViewportSize({ width, height: Math.min(height, maxHeight) });
  }
  throw new Error('Tray sizing failed to settle');
}

test('content-fit menu has no overflow, blank footer, underlined labels or CSP errors', async ({ page }, info) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const natural = await openTray(page, info.project.name);
  const geometry = await page.evaluate(() => {
    const card = document.querySelector('.tray-card'), quit = document.querySelector('#action-quit');
    const wrapper = document.querySelector('.tray-wrapper');
    return {
      cardHeight: card.clientHeight, contentHeight: card.scrollHeight,
      cardWidth: card.clientWidth, contentWidth: card.scrollWidth,
      bottomGap: card.getBoundingClientRect().bottom - quit.getBoundingClientRect().bottom,
      wrapperHeight: wrapper.getBoundingClientRect().height, viewportHeight: innerHeight,
      wrapperWidth: wrapper.getBoundingClientRect().width, viewportWidth: innerWidth,
      decorations: [...document.querySelectorAll('.action-label')].map(node => getComputedStyle(node).textDecorationLine),
      csp: window.__cspErrors, resizes: window.__trayActions.filter(value => value.startsWith('resize-')).length,
    };
  });
  expect(geometry.contentHeight).toBeLessThanOrEqual(geometry.cardHeight + 1);
  expect(geometry.contentWidth).toBeLessThanOrEqual(geometry.cardWidth + 1);
  expect(geometry.bottomGap).toBeGreaterThanOrEqual(7);
  expect(geometry.bottomGap).toBeLessThanOrEqual(12);
  expect(geometry.wrapperHeight).toBeLessThanOrEqual(geometry.viewportHeight);
  expect(geometry.viewportHeight - geometry.wrapperHeight).toBeLessThan(1.1);
  expect(geometry.wrapperWidth).toBe(geometry.viewportWidth);
  expect(geometry.decorations.every(value => value === 'none')).toBe(true);
  expect(geometry.resizes).toBeLessThan(8);
  expect(geometry.csp).toEqual([]);
  expect(errors).toEqual([]);
  await expect(page.getByRole('switch', { name: '开机自启' })).not.toBeChecked();
  await expect(page.getByText('缩放', { exact: true })).toHaveCount(0);
  await expect(page.locator('#autostart-status')).toHaveCSS('clip-path', 'inset(50%)');
  await page.screenshot({ path: info.outputPath('tray.png'), omitBackground: true });
  await info.attach('measured-size', { body: `${natural}\n${JSON.stringify(geometry)}`, contentType: 'text/plain' });
});

test('hover, focus and pointer movement never change menu geometry or request native resize', async ({ page }, info) => {
  await openTray(page, info.project.name);
  await page.mouse.move(1, 1);
  const snapshot = () => page.evaluate(() => ({
    height: document.querySelector('.tray-wrapper').getBoundingClientRect().height,
    sizes: window.__trayActions.filter(value => value.startsWith('resize-')),
  }));
  const before = await snapshot();
  for (const selector of ['#action-show', '#action-browser', '#action-copy', '#action-config-dir', '#action-log-dir', '.startup-row', '#action-quit']) {
    await page.locator(selector).hover();
    await page.evaluate(() => window.__measureTray());
    expect(await snapshot(), `hover ${selector}`).toEqual(before);
  }
  await page.locator('#action-show').focus();
  await page.keyboard.press('Tab');
  await page.evaluate(() => window.__measureTray());
  expect(await snapshot(), 'keyboard focus').toEqual(before);
  await page.mouse.move(1, 1);
  await page.evaluate(() => window.__measureTray());
  expect(await snapshot(), 'pointer outside').toEqual(before);
});

test('small work areas scroll only the card and keep Quit reachable', async ({ page }, info) => {
  await openTray(page, info.project.name, 280);
  const card = page.locator('.tray-card');
  expect(await card.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(280);
  await page.getByRole('button', { name: '退出', exact: true }).scrollIntoViewIfNeeded();
  const rect = await page.getByRole('button', { name: '退出', exact: true }).boundingBox();
  expect(rect.y + rect.height).toBeLessThanOrEqual(280);
  await page.getByRole('button', { name: '退出', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__trayActions.includes('quit'))).toBe(true);
});

test('real switch clicks and keyboard activation wait for native state without double toggles', async ({ page }, info) => {
  await openTray(page, info.project.name);
  const control = page.getByRole('switch', { name: '开机自启' });
  await control.click();
  await expect(control).toBeChecked();
  await control.click();
  await expect(control).toBeChecked();
  expect(await page.evaluate(() => window.__trayActions.filter(value => value === 'autostart-toggle').length)).toBe(1);
  await page.waitForTimeout(550);
  await control.focus();
  await page.keyboard.press('Space');
  await expect(control).not.toBeChecked();
  expect(await page.evaluate(() => window.__trayActions.filter(value => value === 'autostart-toggle').length)).toBe(2);
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => window.__trayActions.at(-1))).toBe('dismiss');
});
