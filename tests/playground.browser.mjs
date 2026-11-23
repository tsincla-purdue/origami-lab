import { readFile } from 'node:fs/promises';
import { devices, expect, test } from '@playwright/test';

async function screenPoint(page, x, y) {
  return page.locator('#paper-scene').evaluate((scene, [x, y]) => {
    const point = new DOMPoint(x, y).matrixTransform(scene.getScreenCTM());
    return { x: point.x, y: point.y };
  }, [x, y]);
}

async function startMouseDrag(page, from, to) {
  const start = await screenPoint(page, ...from);
  const end = await screenPoint(page, ...to);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 8 });
}

async function downloadJSON(page, name) {
  const [download] = await Promise.all([
    page.waitForEvent('download'), page.getByRole('button', {name, exact: true}).click(),
  ]);
  return JSON.parse(await readFile(await download.path(), 'utf8'));
}

async function paperPixels(page, points) {
  return page.locator('#paper').evaluate(async (svg, points) => {
    const imageSvg = svg.cloneNode(true);
    imageSvg.querySelector('#paper-handles').remove();
    imageSvg.querySelector('#paper-preview').remove();
    imageSvg.setAttribute('viewBox', '0 0 1 1');
    imageSvg.setAttribute('width', '400');
    imageSvg.setAttribute('height', '400');
    const image = new Image();
    image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(imageSvg));
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 400;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    return points.map(([x, y]) => [...context.getImageData(x * 400, (1 - y) * 400, 1, 1).data]);
  }, points);
}

test.beforeEach(async ({page}) => {
  await page.goto('./');
  await expect(page.locator('#paper-handles .corner-touch')).toHaveCount(4);
  await page.locator('#paper').scrollIntoViewIfNeeded();
});

test('mouse drag previews a snapped fold and commits reflected, opaque stripes', async ({page}) => {
  await page.getByRole('button', {name: 'Diagonal stripes'}).click();
  const start = await screenPoint(page, 0, 0);
  await page.mouse.move(start.x, start.y);
  await expect(page.locator('.corner-hover')).toBeVisible();
  await startMouseDrag(page, [0, 0], [.98, 0]);
  await expect(page.locator('.snap-active')).toBeVisible();
  await expect(page.locator('.preview-side')).toBeVisible();
  await expect(page.locator('#paper-preview .paper-facet[data-face="back"]')).toHaveCount(1);
  await expect(page.locator('#gesture-status')).toHaveText('accepted');
  await expect(page.locator('#history-count')).toHaveText('0 attempts');
  await page.mouse.up();
  await expect(page.locator('#history-count')).toHaveText('1 attempt');
  await expect(page.locator('#paper-art .paper-facet').last()).toHaveAttribute('data-face', 'back');
  // These points distinguish the back ink and paper from a screen-aligned stripe and the lower front.
  expect(await paperPixels(page, [[.795, .205], [.8, .175]])).toEqual([
    [120, 46, 55, 255], [229, 152, 119, 255],
  ]);
});

test('pointer capture tracks an outside drag and rejects it without changing history', async ({page}) => {
  const start = await screenPoint(page, 0, 1);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(3, start.y, {steps: 8});
  await expect(page.locator('#gesture-status')).toHaveText('rejected');
  await page.mouse.up();
  await expect(page.locator('#gesture-reason')).toContainText('without a fixed hinge');
  await expect(page.locator('#history-count')).toHaveText('0 attempts');
  await expect(page.locator('#sheet-caption')).toHaveText('1 facet · 0 folds');
});

test('a tap leaves the paper alone and a pen can place an unsnapped fold', async ({page, context}) => {
  const start = await screenPoint(page, 0, 0);
  await page.mouse.click(start.x, start.y);
  await expect(page.locator('#history-count')).toHaveText('0 attempts');
  await page.getByLabel('Snap to points').uncheck();
  const end = await screenPoint(page, .84, .12);
  const session = await context.newCDPSession(page);
  const pen = (type, point) => session.send('Input.dispatchMouseEvent', {
    type, ...point, pointerType: 'pen', button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1,
  });
  await pen('mousePressed', start);
  await pen('mouseMoved', end);
  await expect(page.locator('#gesture-status')).toHaveText('accepted');
  await expect(page.locator('.snap-active')).toHaveCount(0);
  await pen('mouseReleased', end);
  await expect(page.locator('#history-count')).toHaveText('1 attempt');
});

test('draw a crease, choose the moving side, confirm, undo and replay', async ({page}) => {
  await page.getByRole('button', {name: 'Draw crease'}).click();
  await startMouseDrag(page, [.5, .04], [.5, .96]);
  await page.mouse.up();
  await expect(page.locator('#gesture-reason')).toContainText('Tap the side');
  const left = await screenPoint(page, .2, .5);
  await page.mouse.click(left.x, left.y);
  await expect(page.locator('#paper-preview .fold-endpoint')).toBeVisible();
  await expect(page.locator('#history-count')).toHaveText('0 attempts');
  await page.getByRole('button', {name: 'Confirm fold'}).click();
  await expect(page.locator('#history-count')).toHaveText('1 attempt');
  await page.getByRole('button', {name: 'Undo', exact: true}).click();
  await expect(page.locator('#sheet-caption')).toHaveText('1 facet · 0 folds');
  await page.getByRole('button', {name: 'Replay', exact: true}).click();
  await expect(page.locator('#sheet-caption')).toHaveText('2 facets · 1 fold');
});

test('paper preference survives reload and presets, and round-trips through exports', async ({page}) => {
  await page.getByRole('button', {name: 'Waves', exact: true}).click();
  await page.reload();
  await expect(page.getByRole('button', {name: 'Waves', exact: true})).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#preset').selectOption({index: 1});
  await expect(page.locator('#style-name')).toHaveText('Waves');
  const exported = await downloadJSON(page, 'Export experiment');
  expect(exported.attempts.length).toBeGreaterThan(0);
  expect(exported.appearance).toEqual({paperStyle: 'waves'});
  expect(await downloadJSON(page, 'Export FOLD')).toMatchObject({frame_classes: ['foldedForm']});

  page.on('dialog', dialog => dialog.accept());
  await page.getByRole('button', {name: 'Classic white'}).click();
  await page.locator('#import-file').setInputFiles({
    name: 'experiment.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(exported)),
  });
  await expect(page.locator('#style-name')).toHaveText('Waves');
  await expect(page.locator('#notice')).toHaveText('Experiment imported and verified by replay.');
  expect(await downloadJSON(page, 'Export experiment')).toEqual(exported);
});

test.describe('touch', () => {
  const { defaultBrowserType, ...touchDevice } = devices['iPhone 13'];
  test.use(touchDevice);

  test('a touch drag has a large hit target and cancellation discards the preview', async ({page, context}) => {
    const session = await context.newCDPSession(page);
    const anchor = await screenPoint(page, 0, 0);
    const destination = await screenPoint(page, 1, 0);
    const touch = (type, point) => session.send('Input.dispatchTouchEvent', {
      type, touchPoints: point ? [{x: point.x + 14, y: point.y}] : [],
    });
    await touch('touchStart', anchor);
    await touch('touchMove', destination);
    await expect(page.locator('#gesture-status')).toHaveText('accepted');
    await touch('touchCancel');
    await expect(page.locator('#paper-preview .fold-endpoint')).toHaveCount(0);
    await expect(page.locator('#history-count')).toHaveText('0 attempts');
    await touch('touchStart', anchor);
    await touch('touchMove', destination);
    await expect(page.locator('#gesture-status')).toHaveText('accepted');
    await touch('touchEnd');
    await expect(page.locator('#history-count')).toHaveText('1 attempt');

    const center = await screenPoint(page, .75, .5);
    const scroll = await page.evaluate(() => window.scrollY);
    await touch('touchStart', center);
    await touch('touchMove', {x: center.x, y: center.y - 110});
    await touch('touchEnd');
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(scroll);
  });
});
