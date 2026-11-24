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

async function dragCorner(page, from, to) {
  await startMouseDrag(page, from, to);
  await page.mouse.up();
}

async function tapCorner(page, point, offset = 0) {
  const corner = await screenPoint(page, ...point);
  await page.mouse.click(corner.x + offset, corner.y);
}

async function downloadJSON(page, name) {
  const [download] = await Promise.all([
    page.waitForEvent('download'), page.getByRole('button', {name, exact: true}).click(),
  ]);
  return JSON.parse(await readFile(await download.path(), 'utf8'));
}

async function importJSON(page, experiment) {
  await page.locator('#import-file').setInputFiles({
    name: 'experiment.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(experiment)),
  });
  await expect(page.locator('#notice')).toHaveText('Experiment imported and verified by replay.');
}

async function renderedFacets(page) {
  return page.locator('#paper-art .paper-facet').evaluateAll(facets => facets.map(facet => ({
    id: Number(facet.dataset.id),
    face: facet.dataset.face,
    points: facet.getAttribute('points'),
    transform: facet.getAttribute('transform'),
  })));
}

async function chooseAdvancedCrease(page) {
  await expect(page.getByRole('button', {name: 'Draw crease'})).toBeHidden();
  await page.locator('#advanced summary').click();
  await page.getByRole('button', {name: 'Draw crease'}).click();
  await page.locator('#paper').scrollIntoViewIfNeeded();
}

async function verifyReplayAndUndo(page, experiment) {
  const finalFacets = await renderedFacets(page);
  await page.reload();
  await importJSON(page, experiment);
  expect(await renderedFacets(page)).toEqual(finalFacets);
  await page.getByRole('button', {name: 'Replay', exact: true}).click();
  await expect(page.locator('#history li button').last()).toHaveAttribute('aria-current', 'step');
  expect(await renderedFacets(page)).toEqual(finalFacets);
  expect(await downloadJSON(page, 'Export experiment')).toEqual(experiment);
  await page.getByRole('button', {name: 'Undo', exact: true}).click();
  const retained = await downloadJSON(page, 'Export experiment');
  expect(retained.attempts).toEqual(experiment.attempts.slice(0, -1));
  expect(retained.final).toEqual(retained.attempts.at(-1).state);
}

function captureStage(page, testInfo, name) {
  return page.screenshot({path: testInfo.outputPath(name), fullPage: true});
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
  await expect(page.locator('.packet-moving')).toBeVisible();
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

test('reset clears the experiment and a corner immediately makes an asymmetric dog-ear', async ({page}) => {
  await page.getByRole('button', {name: 'Diagonal stripes'}).click();
  await dragCorner(page, [1, 1], [.5, .5]);
  await expect(page.locator('#sheet-caption')).toHaveText('2 facets · 1 fold');
  const centered = await downloadJSON(page, 'Export experiment');
  expect(centered.final.facets.at(-1).poly).toHaveLength(3);
  await tapCorner(page, [0, 0]);
  await page.getByRole('button', {name: 'Reset paper'}).click();
  await expect(page.locator('#history-count')).toHaveText('0 attempts');
  await expect(page.locator('#sheet-caption')).toHaveText('1 facet · 0 folds');
  await expect(page.locator('#packet-status')).toBeEmpty();
  await expect(page.locator('#gesture-status')).toBeHidden();
  await expect(page.getByRole('button', {name: 'Replay', exact: true})).toBeDisabled();
  await expect(page.locator('#style-name')).toHaveText('Diagonal stripes');
  await page.locator('#paper').scrollIntoViewIfNeeded();
  await dragCorner(page, [1, 1], [.31, .58]);
  await expect(page.locator('#history-count')).toHaveText('1 attempt');
  const asymmetric = await downloadJSON(page, 'Export experiment');
  expect(asymmetric.final.facets.at(-1).poly).toHaveLength(3);
  expect(asymmetric.attempts[0].move.line).not.toEqual(centered.attempts[0].move.line);
});

test('an explicitly selected flap stays fixed on rejection and pen taps cycle layers', async ({page, context}) => {
  await dragCorner(page, [0, 1], [1, 1]);
  await expect(page.locator('#packet-status')).toBeEmpty();
  await tapCorner(page, [1, 1]);
  await startMouseDrag(page, [1, 1], [1, 0]);
  await expect(page.locator('#packet-status')).toHaveText('1/2 layers');
  await expect(page.locator('.packet-moving')).toHaveCount(1);
  await expect(page.locator('#gesture-status')).toHaveText('rejected');
  await page.mouse.up();
  await expect(page.locator('#gesture-reason')).toContainText('shared material edges');
  await expect(page.locator('#history-count')).toHaveText('1 attempt');

  const start = await screenPoint(page, 1, 1);
  const session = await context.newCDPSession(page);
  const penTap = async () => {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await session.send('Input.dispatchMouseEvent', {
        type, ...start, pointerType: 'pen', button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1,
      });
    }
  };
  await penTap();
  await expect(page.locator('#packet-status')).toHaveText('2/2 layers');
  await penTap();
  await expect(page.locator('#packet-status')).toHaveText('1/2 layers');
  await tapCorner(page, [1, 0]);
  await expect(page.locator('#packet-status')).toHaveText('1/2 layers');
  await startMouseDrag(page, [1, 0], [.02, 0]);
  await expect(page.locator('.snap-active')).toBeVisible();
  await expect(page.locator('#gesture-status')).toHaveText('accepted');
  await page.mouse.up();
  await expect(page.locator('#packet-status')).toBeEmpty();
  const experiment = await downloadJSON(page, 'Export experiment');
  expect(experiment.attempts[1].validation.code).toBe('packet-fold');
  expect(experiment.attempts[1].move.packet.facetIds).toEqual([1]);
  expect(experiment.final.facets[0].transform).toEqual(experiment.attempts[0].state.facets[0].transform);
});

test('deliberate repeated taps wrap through a four-layer stack and hold the packet for a drag', async ({page}) => {
  await dragCorner(page, [0, 1], [1, 1]);
  await tapCorner(page, [1, 0]);
  await tapCorner(page, [1, 0], 5);
  await expect(page.locator('#packet-status')).toHaveText('2/2 layers');
  await dragCorner(page, [1, 0], [1, 1]);
  await expect(page.locator('#sheet-caption')).toHaveText('4 facets · 2 folds');

  for (const count of [1, 2, 3, 4, 1, 2]) {
    await tapCorner(page, [1, 1], count % 2 ? 0 : -6);
    await expect(page.locator('#packet-status')).toHaveText(`${count}/4 layers`);
    if (count === 1) await page.waitForTimeout(550);
  }
  await expect(page.locator('.packet-highlight')).toHaveCount(2);
  await page.waitForTimeout(3600);
  await dragCorner(page, [1, 1], [1, .02]);
  await expect(page.locator('#history-count')).toHaveText('3 attempts');
  const experiment = await downloadJSON(page, 'Export experiment');
  expect(experiment.attempts[2].move.packet.facetIds).toEqual([2, 3]);
  expect(experiment.attempts[2].validation.code).toBe('packet-fold');
  await page.locator('#history button').nth(2).click();
  await expect(page.locator('#sheet-caption')).toHaveText('4 facets · 2 folds');
  await expect(page.getByRole('button', {name: 'Undo', exact: true})).toBeDisabled();
  await page.getByRole('button', {name: 'Replay', exact: true}).click();
  await expect(page.locator('#sheet-caption')).toHaveText('4 facets · 3 folds');
  expect(await downloadJSON(page, 'Export experiment')).toEqual(experiment);
});

test('keyboard packet controls also select the material for a drawn crease', async ({page}) => {
  await dragCorner(page, [0, 1], [1, 1]);
  await page.getByRole('combobox', {name: 'Corner', exact: true}).press('ArrowDown');
  const layers = page.getByRole('combobox', {name: 'Layers', exact: true});
  await layers.press('ArrowDown');
  await expect(page.locator('#packet-status')).toHaveText('2/2 layers');
  await layers.press('ArrowUp');
  await chooseAdvancedCrease(page);
  await expect(page.locator('#packet-status')).toHaveText('1/2 layers');
  await page.locator('#paper').scrollIntoViewIfNeeded();
  await dragCorner(page, [.5, 0], [.5, 1]);
  const movingSide = await screenPoint(page, .75, .5);
  await page.mouse.click(movingSide.x, movingSide.y);
  await expect(page.locator('#gesture-status')).toHaveText('accepted');
  await page.getByRole('button', {name: 'Confirm fold'}).click();
  const experiment = await downloadJSON(page, 'Export experiment');
  expect(experiment.attempts[1].move.packet.facetIds).toEqual([1]);
  expect(experiment.attempts[1].validation.code).toBe('packet-fold');
});

test('Undo removes the last fold from history and export, then accepts a different second fold', async ({page}) => {
  const undo = page.getByRole('button', {name: 'Undo', exact: true});
  await dragCorner(page, [1, 1], [0, 1]);
  const first = await downloadJSON(page, 'Export experiment');
  await page.locator('#paper').scrollIntoViewIfNeeded();
  await dragCorner(page, [0, 1], [1, 1]);
  await expect(page.locator('#sheet-caption')).toHaveText('2 facets · 2 folds');
  const originalSecond = (await downloadJSON(page, 'Export experiment')).attempts[1].move;

  await undo.click();
  await expect(page.locator('#sheet-caption')).toHaveText('2 facets · 1 fold');
  await expect(page.locator('#history li')).toHaveCount(2);
  await expect(page.locator('#history li button').last()).toHaveAttribute('aria-current', 'step');
  await expect(page.locator('#paper-handles .corner-touch')).toHaveCount(4);
  expect(await downloadJSON(page, 'Export experiment')).toEqual(first);

  await page.locator('#paper').scrollIntoViewIfNeeded();
  await dragCorner(page, [0, 0], [.4, 0]);
  await expect(page.locator('#sheet-caption')).toHaveText('3 facets · 2 folds');
  const updated = await downloadJSON(page, 'Export experiment');
  expect(updated.attempts).toHaveLength(2);
  expect(updated.attempts[0]).toEqual(first.attempts[0]);
  expect(updated.attempts[1].move).not.toEqual(originalSecond);

  await undo.click();
  await undo.click();
  await expect(page.locator('#history-count')).toHaveText('0 attempts');
  await expect(page.locator('#sheet-caption')).toHaveText('1 facet · 0 folds');
  await expect(page.locator('#paper-handles .corner-touch')).toHaveCount(4);
  const empty = await downloadJSON(page, 'Export experiment');
  expect(empty.attempts).toEqual([]);
  expect(empty.final).toEqual(empty.initial);
});

test('right-to-left half-fold followed by a new crease in the upper flap', async ({page}, testInfo) => {
  const capture = name => page.screenshot({path: testInfo.outputPath(name), fullPage: true});
  const undo = page.getByRole('button', {name: 'Undo', exact: true});
  await page.getByRole('button', {name: 'Diagonal stripes'}).click();
  await capture('01-square.png');

  await dragCorner(page, [1, 1], [0, 1]);
  await expect(page.locator('#sheet-caption')).toHaveText('2 facets · 1 fold');
  const folded = await renderedFacets(page);
  expect(folded.map(({id, face}) => [id, face])).toEqual([[0, 'front'], [1, 'back']]);
  await capture('02-half-fold.png');

  await tapCorner(page, [0, 1]);
  await expect(page.locator('#packet-status')).toHaveText('1/2 layers');
  await expect(page.locator('.packet-highlight')).toHaveCount(1);
  await expect(page.locator('.packet-highlight')).toHaveAttribute('data-facet-id', '1');
  await capture('03-upper-flap.png');
  await tapCorner(page, [0, 1]);
  await expect(page.locator('#packet-status')).toHaveText('2/2 layers');
  await expect(page.locator('.packet-highlight')).toHaveCount(2);
  await tapCorner(page, [0, 1]);
  await expect(page.locator('#packet-status')).toHaveText('1/2 layers');

  await startMouseDrag(page, [0, 1], [.4, 1]);
  await expect(page.locator('.packet-moving')).toHaveAttribute('data-facet-id', '1');
  await expect(page.locator('.snap-active')).toHaveCount(0);
  const creaseX = await page.locator('.preview-line').getAttribute('x1');
  expect(Number(creaseX)).toBeCloseTo(.2, 4);
  await expect(page.locator('#gesture-status')).toHaveText('accepted');
  await expect(page.locator('#paper-preview .paper-facet')).toHaveCount(3);
  await page.mouse.up();
  await expect(page.locator('#sheet-caption')).toHaveText('3 facets · 2 folds');
  const flap = await renderedFacets(page);
  expect(flap[0]).toEqual(folded[0]);
  expect(flap[1].face).toBe('back');
  expect(flap[1].transform).toBe(folded[1].transform);
  expect(flap[1].points).not.toBe(folded[1].points);
  expect(flap[2].face).toBe('front');
  await capture('04-flap-back.png');

  const experiment = await downloadJSON(page, 'Export experiment');
  expect(experiment.attempts[1].move.packet.facetIds).toEqual([1]);
  expect(experiment.attempts[1].validation.code).toBe('packet-fold');
  expect(experiment.final.creases).toHaveLength(2);
  for (const end of ['a', 'b']) expect(experiment.final.creases[1][end].x).toBeCloseTo(.8, 4);
  expect(experiment.final.facets[0]).toEqual(experiment.attempts[0].state.facets[0]);

  await undo.click();
  expect(await renderedFacets(page)).toEqual(folded);
  await expect(page.locator('#history-count')).toHaveText('1 attempt');
  page.on('dialog', dialog => dialog.accept());
  await importJSON(page, experiment);
  expect(await renderedFacets(page)).toEqual(flap);
  await page.getByRole('button', {name: 'Replay', exact: true}).click();
  await expect(page.locator('#sheet-caption')).toHaveText('3 facets · 2 folds');
  expect(await renderedFacets(page)).toEqual(flap);
  expect(await downloadJSON(page, 'Export experiment')).toEqual(experiment);

  await undo.click();
  await page.locator('#paper').scrollIntoViewIfNeeded();
  await tapCorner(page, [0, 1]);
  await tapCorner(page, [0, 1]);
  await dragCorner(page, [0, 1], [.4, 1]);
  await expect(page.locator('#sheet-caption')).toHaveText('4 facets · 2 folds');
  expect((await renderedFacets(page))[0].points).not.toBe(folded[0].points);
});

test('draw a crease, choose the moving side, confirm, browse and replay', async ({page}) => {
  await chooseAdvancedCrease(page);
  await startMouseDrag(page, [.5, .04], [.5, .96]);
  await page.mouse.up();
  await expect(page.locator('#gesture-reason')).toContainText('Tap the side');
  const left = await screenPoint(page, .2, .5);
  await page.mouse.click(left.x, left.y);
  await expect(page.locator('#paper-preview .fold-endpoint')).toBeVisible();
  await expect(page.locator('#history-count')).toHaveText('0 attempts');
  await page.getByRole('button', {name: 'Confirm fold'}).click();
  await expect(page.locator('#history-count')).toHaveText('1 attempt');
  await page.locator('#history button').first().click();
  await expect(page.locator('#sheet-caption')).toHaveText('1 facet · 0 folds');
  await page.getByRole('button', {name: 'Replay', exact: true}).click();
  await expect(page.locator('#sheet-caption')).toHaveText('2 facets · 1 fold');
});

test('construction A uses Whole stack before grabbing a dog-eared sheet', async ({page}, testInfo) => {
  await page.getByRole('button', {name: 'Diagonal stripes'}).click();
  await dragCorner(page, [1, 1], [.5, .5]);
  await expect(page.locator('#sheet-caption')).toHaveText('2 facets · 1 fold');
  const flap = page.locator('#paper-art .paper-facet[data-id="1"]');
  const material = await flap.getAttribute('points');
  await expect(flap).toHaveAttribute('data-face', 'back');
  await captureStage(page, testInfo, '01-dog-ear.png');
  await page.getByRole('combobox', {name: 'Layers', exact: true}).selectOption('all');
  await expect(page.locator('#packet-status')).toHaveText('Whole stack');
  await page.locator('#paper').scrollIntoViewIfNeeded();
  await dragCorner(page, [1, 0], [0, 0]);
  await expect(page.locator('#sheet-caption')).toHaveText('3 facets · 2 folds');
  await expect(flap).toHaveAttribute('points', material);
  await expect(flap).toHaveAttribute('data-face', 'front');
  const ids = (await renderedFacets(page)).map(({id}) => id);
  expect(ids).toEqual([0, 1, 2]);
  await captureStage(page, testInfo, '02-compound-half-fold.png');
  const experiment = await downloadJSON(page, 'Export experiment');
  expect(experiment.attempts[1].move.packet).toBeUndefined();
  expect(experiment.final.creases[0]).toEqual(experiment.attempts[0].state.creases[0]);
  await verifyReplayAndUndo(page, experiment);
});

test('pointer-only dog-ear carries the attached flap into a half-fold', async ({page}) => {
  await page.getByRole('button', {name: 'Diagonal stripes'}).click();
  await dragCorner(page, [1, 1], [.5, .5]);
  const dog = await downloadJSON(page, 'Export experiment');
  const flap = page.locator('#paper-art .paper-facet[data-id="1"]');
  const points = await flap.getAttribute('points');
  await page.locator('#paper').scrollIntoViewIfNeeded();

  await startMouseDrag(page, [1, 0], [0, 0]);
  await expect(page.locator('#gesture-status')).toHaveText('accepted');
  await expect(page.locator('.packet-moving')).toHaveCount(2);
  await expect(page.locator('.packet-moving[data-facet-id="1"]')).toBeVisible();
  await page.mouse.up();
  await expect(page.locator('#sheet-caption')).toHaveText('3 facets · 2 folds');
  await expect(flap).toHaveAttribute('points', points);
  await expect(flap).toHaveAttribute('data-face', 'front');
  expect((await renderedFacets(page)).map(({id}) => id)).toEqual([0, 1, 2]);
  const experiment = await downloadJSON(page, 'Export experiment');
  expect(experiment.attempts[1].move.packet.facetIds).toEqual([0, 1]);
  expect(experiment.attempts[0]).toEqual(dog.attempts[0]);
  expect(experiment.final.creases[0]).toEqual(dog.final.creases[0]);
  expect(experiment.final.creases[1].a.x).toBe(.5);
  expect(experiment.final.creases[1].b.x).toBe(.5);
  const [triangle, neighbour] = [1, 2].map(id => experiment.final.facets.find(facet => facet.id === id));
  const project = ({a, b, c, d, e, f}, {x, y}) => [a * x + c * y + e, b * x + d * y + f];
  const {a: start, b: end} = experiment.final.creases[0];
  for (const point of [start, end]) {
    const [x, y] = project(triangle.transform, point);
    const [u, v] = project(neighbour.transform, point);
    expect(Math.hypot(x - u, y - v)).toBeLessThan(1e-12);
  }
  await verifyReplayAndUndo(page, experiment);
  await expect(page.locator('#style-name')).toHaveText('Diagonal stripes');
});

test('a deliberate layer tap keeps the local packet even if its fold is blocked', async ({page}) => {
  await dragCorner(page, [1, 1], [.5, .5]);
  await tapCorner(page, [1, 0]);
  await startMouseDrag(page, [1, 0], [0, 0]);
  await expect(page.locator('#gesture-status')).toHaveText('rejected');
  await expect(page.locator('.packet-moving')).toHaveCount(1);
  await page.mouse.up();
  await expect(page.locator('#gesture-reason')).toContainText('shared material edges');
  await expect(page.locator('#history-count')).toHaveText('1 attempt');
});

test('an ordinary upper flap drag leaves the lower layer stationary', async ({page}) => {
  await dragCorner(page, [1, 1], [0, 1]);
  const folded = await renderedFacets(page);
  await startMouseDrag(page, [0, 1], [.4, 1]);
  await expect(page.locator('.packet-moving')).toHaveCount(1);
  await expect(page.locator('.packet-moving')).toHaveAttribute('data-facet-id', '1');
  await expect(page.locator('#gesture-status')).toHaveText('accepted');
  await page.mouse.up();
  await expect(page.locator('#sheet-caption')).toHaveText('3 facets · 2 folds');
  expect((await renderedFacets(page))[0]).toEqual(folded[0]);
  expect((await downloadJSON(page, 'Export experiment')).attempts[1].move.packet.facetIds).toEqual([1]);
});

test('two admissible packets offer previews and prefer the smaller one', async ({page}) => {
  await dragCorner(page, [0, 1], [1, 1]);
  await dragCorner(page, [.5, 1], [1, 1]);
  await expect(page.locator('#sheet-caption')).toHaveText('4 facets · 2 folds');
  await startMouseDrag(page, [1, 1], [.51, 1]);
  await expect(page.locator('.snap-active')).toHaveAttribute('cx', '0.5');
  await expect(page.locator('.packet-moving')).toHaveCount(2);
  const axis = await page.locator('.preview-line').getAttribute('x1');
  await page.mouse.up();
  await expect(page.locator('#history-count')).toHaveText('2 attempts');
  const choice = page.getByRole('combobox', {name: 'Moving packet', exact: true});
  await expect(choice.locator('option')).toHaveText(['2 connected facets', '3 connected facets']);
  await expect(choice).toHaveValue('0');
  await choice.selectOption('1');
  await expect(page.locator('.packet-moving')).toHaveCount(3);
  await expect(page.locator('.preview-line')).toHaveAttribute('x1', axis);
  await page.getByRole('button', {name: 'Confirm fold'}).click();
  const experiment = await downloadJSON(page, 'Export experiment');
  expect(experiment.attempts[2].move.packet.facetIds).toEqual([1, 2, 3]);
  expect(experiment.final.facets.find(({id}) => id === 0).transform)
    .toEqual(experiment.attempts[1].state.facets.find(({id}) => id === 0).transform);
});

test('construction B unfolds the square and retains the crease until Undo removes the original fold', async ({page}, testInfo) => {
  await page.getByRole('button', {name: 'Square grid'}).click();
  await dragCorner(page, [1, 0], [0, 0]);
  await expect(page.locator('#sheet-caption')).toHaveText('2 facets · 1 fold');
  await captureStage(page, testInfo, '03-vertical-half.png');
  await page.getByRole('button', {name: 'Unfold', exact: true}).click();
  await expect(page.locator('#sheet-caption')).toHaveText('1 facet · 0 folds');
  await expect(page.locator('#history li').last()).toContainText('Unfold');
  await expect(page.locator('.paper-reference')).toHaveAttribute('x1', '0.5');
  await expect(page.locator('#paper-handles .corner-touch')).toHaveCount(4);
  await captureStage(page, testInfo, '04-unfolded-center-crease.png');
  const experiment = await downloadJSON(page, 'Export experiment');
  expect(experiment.attempts[1].operation).toBe('unfold');
  expect(experiment.final.facets).toEqual(experiment.initial.facets);
  const exported = await downloadJSON(page, 'Export FOLD');
  expect(exported.edges_assignment).toContain('F');
  await verifyReplayAndUndo(page, experiment);
  await expect(page.locator('#sheet-caption')).toHaveText('2 facets · 1 fold');
  await page.getByRole('button', {name: 'Undo', exact: true}).click();
  await expect(page.locator('.paper-reference')).toHaveCount(0);
  expect((await downloadJSON(page, 'Export experiment')).final.creases).toEqual([]);
});

test('construction C pins A and snaps ordinary drag of B to a verified equilateral landing', async ({page}, testInfo) => {
  await page.getByRole('button', {name: 'Diagonal stripes'}).click();
  await dragCorner(page, [1, 0], [0, 0]);
  await page.getByRole('button', {name: 'Unfold', exact: true}).click();
  await page.locator('#paper').scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', {name: 'Draw crease'})).toBeHidden();
  await tapCorner(page, [0, 0]);
  await page.getByRole('button', {name: 'Pin point', exact: true}).click();
  await expect(page.locator('.pin-anchor')).toHaveAttribute('cx', '0');
  await expect(page.locator('.pin-anchor')).toHaveAttribute('cy', '0');
  await captureStage(page, testInfo, '05-pinned-corner.png');
  await startMouseDrag(page, [1, 0], [.52, .79]);
  await expect(page.locator('.constraint-target')).toHaveAttribute('x1', '0.5');
  await expect(page.locator('#gesture-status')).toHaveText('accepted');
  await page.mouse.up();
  expect(Number(await page.locator('.drag-destination').getAttribute('cy'))).toBeCloseTo(Math.sqrt(3) / 2, 12);
  await captureStage(page, testInfo, '06-exact-landing-preview.png');
  await page.getByRole('button', {name: 'Confirm fold'}).click();
  await expect(page.locator('#history li').last()).toContainText('Point onto line');
  await expect(page.locator('.pin-anchor')).toHaveCount(0);
  await expect(page.locator('#paper-art .paper-facet').last()).toHaveAttribute('data-face', 'back');
  await captureStage(page, testInfo, '07-equilateral-fold.png');

  const experiment = await downloadJSON(page, 'Export experiment');
  const {a, b, c, d, e, f} = experiment.final.facets.at(-1).transform;
  const landing = [a + e, b + f];
  expect(await page.locator('#paper-art .paper-facet').last().getAttribute('transform')).toBe(`matrix(${a} ${b} ${c} ${d} ${e} ${f})`);
  expect(Math.hypot(e, f)).toBeLessThan(1e-12);
  expect(landing[0]).toBeCloseTo(.5, 12);
  expect(landing[1]).toBeCloseTo(Math.sqrt(3) / 2, 12);
  expect(Math.hypot(...landing)).toBeCloseTo(1, 12);
  expect(Math.hypot(landing[0] - 1, landing[1])).toBeCloseTo(1, 12);
  await verifyReplayAndUndo(page, experiment);
  await expect(page.locator('.paper-reference')).toHaveAttribute('x1', '0.5');
});

test('ordinary point selection and dragging an edge midpoint offer both finite landings', async ({page}) => {
  await dragCorner(page, [1, 0], [0, 0]);
  await page.getByRole('button', {name: 'Unfold', exact: true}).click();
  await page.locator('#paper').scrollIntoViewIfNeeded();
  const pin = await screenPoint(page, .6, .5);
  await page.mouse.move(pin.x, pin.y);
  await page.mouse.down();
  await expect(page.locator('.pin-anchor')).toBeVisible({timeout: 2000});
  await page.mouse.up();
  await tapCorner(page, [1, .5]);
  await dragCorner(page, [1, .5], [.5, .8]);
  const choices = page.getByRole('combobox', {name: 'Landing point', exact: true});
  await expect(choices.locator('option')).toHaveCount(2);
  expect(Number(await page.locator('.drag-destination').getAttribute('cy'))).toBeGreaterThan(.5);
  await choices.selectOption(await choices.inputValue() === '0' ? '1' : '0');
  expect(Number(await page.locator('.drag-destination').getAttribute('cy'))).toBeLessThan(.5);
  await expect(page.locator('.alternative-landing')).toBeVisible();
  await page.getByRole('button', {name: 'Confirm fold'}).click();
  await expect(page.locator('#history li').last()).toContainText('Point onto line');
});

test('pointer-only hold and drag commits the unique equilateral landing on release', async ({page}) => {
  await page.getByRole('button', {name: 'Diagonal stripes'}).click();
  await dragCorner(page, [1, 0], [0, 0]);
  await page.getByRole('button', {name: 'Unfold', exact: true}).click();
  await page.locator('#paper').scrollIntoViewIfNeeded();
  const pin = await screenPoint(page, 0, 0);
  await page.mouse.move(pin.x, pin.y);
  await page.mouse.down();
  await expect(page.locator('.pin-anchor')).toBeVisible({timeout: 2000});
  await page.mouse.up();
  await expect(page.locator('.pin-anchor')).toHaveAttribute('cx', '0');
  await expect(page.locator('.pin-anchor')).toHaveAttribute('cy', '0');

  await startMouseDrag(page, [1, 0], [.52, .79]);
  await expect(page.locator('.constraint-target')).toHaveAttribute('x1', '0.5');
  await expect(page.locator('#gesture-status')).toHaveText('accepted');
  expect(Number(await page.locator('.drag-destination').getAttribute('cy'))).toBeCloseTo(Math.sqrt(3) / 2, 12);
  await page.mouse.up();
  await expect(page.locator('.pin-anchor')).toHaveCount(0);
  await expect(page.locator('#history li').last()).toContainText('Point onto line');
  const experiment = await downloadJSON(page, 'Export experiment');
  const {a, b, e, f} = experiment.final.facets.at(-1).transform;
  const [[x1, y1], [x2, y2]] = experiment.attempts[2].move.line;
  expect(Math.abs(x1 * y2 - y1 * x2)).toBeLessThan(1e-12);
  const landing = [a + e, b + f];
  expect(Math.hypot(e, f)).toBeLessThan(1e-12);
  expect(landing[0]).toBeCloseTo(.5, 12);
  expect(landing[1]).toBeCloseTo(Math.sqrt(3) / 2, 12);
  expect(Math.hypot(...landing)).toBeCloseTo(1, 12);
  expect(Math.hypot(landing[0] - 1, landing[1])).toBeCloseTo(1, 12);
  await expect(page.locator('#paper-art .paper-facet').last()).toHaveAttribute('data-face', 'back');
  await verifyReplayAndUndo(page, experiment);
  await expect(page.locator('.paper-reference')).toHaveAttribute('x1', '0.5');
});

test('holding with a pen pins an interior point and holding it again unpins', async ({page, context}) => {
  const session = await context.newCDPSession(page);
  const point = await screenPoint(page, .31, .37);
  const pen = type => session.send('Input.dispatchMouseEvent', {
    type, ...point, pointerType: 'pen', button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1,
  });
  await pen('mousePressed');
  await expect(page.locator('.pin-anchor')).toBeVisible({timeout: 2000});
  await pen('mouseReleased');
  expect(Number(await page.locator('.pin-anchor').getAttribute('cx'))).toBeCloseTo(.31, 4);
  await pen('mousePressed');
  await expect(page.locator('.pin-anchor')).toHaveCount(0, {timeout: 2000});
  await pen('mouseReleased');
  await expect(page.locator('#history-count')).toHaveText('0 attempts');
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

  test('touch hold and drag fold onto a crease without confirmation controls', async ({page, context}) => {
    const session = await context.newCDPSession(page);
    const touch = (type, point) => session.send('Input.dispatchTouchEvent', {
      type, touchPoints: point ? [point] : [],
    });
    await touch('touchStart', await screenPoint(page, 1, 0));
    await touch('touchMove', await screenPoint(page, 0, 0));
    await touch('touchEnd');
    await page.getByRole('button', {name: 'Unfold', exact: true}).tap();
    await page.locator('#paper').scrollIntoViewIfNeeded();
    await touch('touchStart', await screenPoint(page, 0, 0));
    await expect(page.locator('.pin-anchor')).toBeVisible({timeout: 2000});
    await touch('touchEnd');
    await touch('touchStart', await screenPoint(page, 1, 0));
    await touch('touchMove', await screenPoint(page, .5, .8));
    await expect(page.locator('#gesture-status')).toHaveText('accepted');
    expect(Number(await page.locator('.drag-destination').getAttribute('cy'))).toBeCloseTo(Math.sqrt(3) / 2, 12);
    await touch('touchEnd');
    await expect(page.locator('#history li').last()).toContainText('Point onto line');
    await expect(page.locator('#confirm-fold')).toBeHidden();
  });

  test('a touch drag snaps to the retained crease with a pin', async ({page, context}) => {
    const session = await context.newCDPSession(page);
    const dragTouch = async (from, to) => {
      const start = await screenPoint(page, ...from);
      const end = await screenPoint(page, ...to);
      await session.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [start]});
      await session.send('Input.dispatchTouchEvent', {type: 'touchMove', touchPoints: [end]});
      await expect(page.locator('#gesture-status')).toHaveText('accepted');
      await session.send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []});
    };
    await dragTouch([1, 0], [0, 0]);
    await page.getByRole('button', {name: 'Unfold', exact: true}).tap();
    await page.locator('#paper').scrollIntoViewIfNeeded();
    const pin = await screenPoint(page, 0, 0);
    await page.touchscreen.tap(pin.x, pin.y);
    await page.getByRole('button', {name: 'Pin point', exact: true}).tap();
    await page.locator('#paper').scrollIntoViewIfNeeded();
    await dragTouch([1, 0], [.5, .78]);
    expect(Number(await page.locator('.drag-destination').getAttribute('cy'))).toBeCloseTo(Math.sqrt(3) / 2, 12);
    await page.getByRole('button', {name: 'Confirm fold'}).tap();
    await expect(page.locator('#history li').last()).toContainText('Point onto line');
  });

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

    const top = await screenPoint(page, 1, 1);
    for (const count of [1, 2]) {
      await touch('touchStart', top);
      await touch('touchEnd');
      await expect(page.locator('#packet-status')).toHaveText(`${count}/2 layers`);
    }

    const center = await screenPoint(page, .75, .5);
    const scroll = await page.evaluate(() => window.scrollY);
    await touch('touchStart', center);
    await touch('touchMove', {x: center.x, y: center.y - 110});
    await touch('touchEnd');
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(scroll);
  });
});
