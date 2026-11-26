import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
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
  const text = await readFile(await download.path(), 'utf8');
  const file = JSON.parse(text);
  if (name === 'Export experiment') {
    const replayed = await page.evaluate(async json => {
      const {importExperiment, serializeExperiment} = await import(new URL('./api/index.js', location.href).href);
      return JSON.parse(serializeExperiment(importExperiment(json)));
    }, text);
    expect(replayed).toEqual(file);
  }
  return file;
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
  if (process.env.ORIGAMI_AUDIT_EXPORTS === '1') {
    const report = spawnSync('python3', ['-B', 'scripts/audit_experiment.py', '-'], {
      input: JSON.stringify(experiment), encoding: 'utf8',
    });
    expect(report.error).toBeUndefined();
    expect(report.status, report.stdout + report.stderr).toBe(0);
  }
  const finalFacets = await renderedFacets(page);
  await page.reload();
  await importJSON(page, experiment);
  expect(await renderedFacets(page)).toEqual(finalFacets);
  await page.getByRole('button', {name: 'Replay', exact: true}).click();
  await expect(page.locator('#history li button').last()).toHaveAttribute('aria-current', 'step', {
    timeout: Math.max(5000, experiment.attempts.length * 650),
  });
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

test('the mouse and tactile hand commit the same snapped crease and material packet', async ({page}) => {
  const from = [1, 0], to = [.017, .006];
  const headless = await page.evaluate(async ({from, to}) => {
    const {createExperiment, createTactileSession, serializeExperiment} =
      await import(new URL('./api/index.js', location.href).href);
    const {a, b} = document.querySelector('#paper-scene').getScreenCTM();
    const session = createTactileSession(createExperiment(), {pixelsPerUnit: Math.hypot(a, b)});
    session.hand.beginDrag({x: from[0], y: from[1]});
    const approach = session.hand.move({x: to[0], y: to[1]});
    const release = session.hand.release();
    return {approach, release, experiment: JSON.parse(serializeExperiment(session.experiment()))};
  }, {from, to});
  expect(headless.approach.snapped).toBe(true);
  expect(headless.release.validation.status).toBe('accepted');

  await startMouseDrag(page, from, to);
  await expect(page.locator('.snap-active')).toBeVisible();
  await expect(page.locator('#gesture-status')).toHaveText(headless.release.validation.status);
  await page.mouse.up();
  const pointer = await downloadJSON(page, 'Export experiment');
  expect(pointer.attempts).toEqual(headless.experiment.attempts);
  expect(pointer.final).toEqual(headless.experiment.final);
});

test('pulling an exposed flap back opens its hinge identically for the mouse and tactile hand', async ({page}) => {
  await dragCorner(page, [1, 0], [0, 0]);
  const folded = await downloadJSON(page, 'Export experiment');
  await page.locator('#paper').scrollIntoViewIfNeeded();
  const from = [0, 0], to = [.98, .006];
  const headless = await page.evaluate(async ({folded, from, to}) => {
    const {createTactileSession, importExperiment, serializeExperiment} =
      await import(new URL('./api/index.js', location.href).href);
    const {a, b} = document.querySelector('#paper-scene').getScreenCTM();
    const session = createTactileSession(importExperiment(JSON.stringify(folded)), {pixelsPerUnit: Math.hypot(a, b)});
    session.hand.beginDrag({x: from[0], y: from[1]});
    const approach = session.hand.move({x: to[0], y: to[1]});
    const release = session.hand.release();
    return {approach, release, experiment: JSON.parse(serializeExperiment(session.experiment()))};
  }, {folded, from, to});
  expect(headless.approach.events).toContainEqual(expect.objectContaining({kind: 'snap-acquired', constraint: 'opening'}));
  expect(headless.release.validation).toMatchObject({status: 'accepted', code: 'unfold'});

  await startMouseDrag(page, from, to);
  await expect(page.locator('#gesture-reason')).toContainText('Open flap');
  await expect(page.locator('.packet-moving')).toHaveAttribute('data-facet-id', '1');
  await expect(page.locator('.drag-destination')).toHaveAttribute('cx', '1');
  await expect(page.locator('.fold-endpoint .paper-facet')).toHaveCount(1);
  await page.mouse.up();
  const pointer = await downloadJSON(page, 'Export experiment');
  expect(pointer).toEqual(headless.experiment);
  expect(pointer.attempts[1]).toMatchObject({operation: 'unfold', move: {foldAttempt: 1}});
  expect(pointer.final.creases).toEqual(folded.final.creases);
  expect(pointer.final.facets).toEqual(folded.initial.facets);
  await verifyReplayAndUndo(page, pointer);
});

test('previews the exact crease-edge intersection on folded and turned material before marking', async ({page}) => {
  const unfold = page.getByRole('button', {name: 'Unfold', exact: true});
  await dragCorner(page, [0, 1], [0, 0]);
  await unfold.click();
  await page.locator('#paper').scrollIntoViewIfNeeded();
  await dragCorner(page, [1, 0], [0, 0]);
  await page.getByRole('button', {name: 'Flip over', exact: true}).click();
  const target = await screenPoint(page, .5, .5);
  await page.mouse.move(target.x - 6, target.y + 5);
  const ghost = page.locator('.intersection-ghost');
  await expect(ghost).toHaveAttribute('cx', '0.5');
  await expect(ghost).toHaveAttribute('cy', '0.5');
  await expect(page.locator('.intersection-reference')).toHaveCount(2);
  await page.mouse.click(target.x - 6, target.y + 5);
  await page.getByRole('button', {name: 'Mark point', exact: true}).click();
  const file = await downloadJSON(page, 'Export experiment');
  expect(file.final.marks.at(-1).point).toEqual({x: 0, y: .5});
  await expect(page.locator('#paper-marks .material-mark')).toHaveAttribute('cx', '0.5');
});

async function scoreHorizontalMarks(page, both = false) {
  await dragCorner(page, [0, 0], [0, .82]);
  await page.getByRole('button', {name: 'Unfold', exact: true}).click();
  const scored = await downloadJSON(page, 'Export experiment');
  const y = scored.final.creases[0].a.y;
  for (const x of both ? [0, 1] : [0]) {
    await page.locator('#paper').scrollIntoViewIfNeeded();
    await tapCorner(page, [x, y], x === 0 ? 5 : -5);
    await page.getByRole('button', {name: 'Mark point', exact: true}).click();
  }
  return y;
}

async function scoreIntersectingCreases(page) {
  const unfold = page.getByRole('button', {name: 'Unfold', exact: true});
  await page.getByLabel('Snap to points').uncheck();
  for (const [from, to] of [[[0, 0], [0, .82]], [[0, 0], [.4, 0]], [[1, 0], [.24, 0]]]) {
    await page.locator('#paper').scrollIntoViewIfNeeded();
    await dragCorner(page, from, to);
    await unfold.click();
  }
  const {final: {creases: [horizontal, left, right]}} = await downloadJSON(page, 'Export experiment');
  return [left, right].map(crease => [crease.a.x, horizontal.a.y]);
}

test('a straight edge drag aligns to a crease with marked intersections without confirmation', async ({page}) => {
  const points = await scoreIntersectingCreases(page);
  await page.getByLabel('Snap to points').check();
  for (const point of [[0, points[0][1]], ...points]) {
    await page.locator('#paper').scrollIntoViewIfNeeded();
    await tapCorner(page, point, 3);
    await page.getByRole('button', {name: 'Mark point', exact: true}).click();
  }
  const [x, y] = points[1];
  await page.locator('#paper').scrollIntoViewIfNeeded();
  const scale = (await screenPoint(page, 1, 0)).x - (await screenPoint(page, 0, 0)).x;
  const grab = x - 8 / scale;
  await startMouseDrag(page, [grab, 0], [grab, y]);
  await expect(page.locator('.constraint-target')).toHaveCount(1);
  await expect(page.locator('.packet-moving')).toHaveCount(1);
  await expect(page.locator('#gesture-status')).toHaveText('accepted');
  await page.mouse.up();
  await expect(page.getByRole('button', {name: 'Confirm fold', exact: true})).toBeHidden();
  const file = await downloadJSON(page, 'Export experiment');
  expect(file.final.marks).toHaveLength(3);
  const {move, validation} = file.attempts.at(-1);
  expect(validation.status).toBe('accepted');
  expect(move.intent).toMatchObject({kind: 'align-lines', target: {facetId: 0}});
  for (const [, creaseY] of move.line) expect(creaseY).toBeCloseTo(y / 2, 12);
  const {a, b, e, f} = file.final.facets.at(-1).transform;
  expect(a * grab + e).toBeCloseTo(grab, 12);
  expect(b * grab + f).toBeCloseTo(y, 12);
});

test('edge alignment holds through jitter and offers a competing marked-point fold', async ({page}) => {
  const points = await scoreIntersectingCreases(page);
  await page.getByLabel('Snap to points').check();
  for (const point of points) {
    await page.locator('#paper').scrollIntoViewIfNeeded();
    await tapCorner(page, point, 3);
    await page.getByRole('button', {name: 'Mark point', exact: true}).click();
  }
  await page.locator('#paper').scrollIntoViewIfNeeded();
  const [x, y] = points[1];
  const mark = await screenPoint(page, x, y);
  const scale = (await screenPoint(page, 1, 0)).x - (await screenPoint(page, 0, 0)).x;

  // A diagonal drag from farther along the edge clearly aims for the mark.
  await startMouseDrag(page, [x - 36 / scale, 0], [x, y]);
  await expect(page.locator('#gesture-reason')).toContainText('Grabbed point onto mark');
  await expect(page.locator('.constraint-target')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.mouse.up();

  // Acquire the crease with a straight drag, then move close enough to the mark that both fit.
  const grab = x - 14 / scale;
  await startMouseDrag(page, [grab, 0], [grab, y]);
  await expect(page.locator('.constraint-target')).toHaveCount(1);
  await page.mouse.move(mark.x - 3, mark.y);
  await expect(page.locator('.constraint-target')).toHaveCount(1);
  await page.mouse.up();
  const choice = page.getByRole('combobox', {name: 'Snap target'});
  await expect(choice.locator('option')).toHaveCount(2);
  await expect(choice.locator('option:checked')).toContainText('Align lines');
  await expect(choice.locator('option').nth(1)).toContainText('Grabbed point onto mark');
  await choice.selectOption({index: 1});
  await expect(page.locator('.drag-destination')).toHaveAttribute('cx', String(x));
  await expect(page.locator('.drag-destination')).toHaveAttribute('cy', String(y));
  await expect(page.locator('#gesture-status')).toHaveText('accepted');
  await expect(page.locator('.packet-moving')).toHaveCount(1);
  await choice.selectOption({index: 0});
  await expect(page.locator('.constraint-target')).toHaveCount(1);
  await expect(page.locator('#gesture-status')).toHaveText('accepted');
  await choice.selectOption({index: 1});
  const anchor = Number(await page.locator('.drag-anchor').getAttribute('cx'));
  await page.getByRole('button', {name: 'Confirm fold', exact: true}).click();
  const file = await downloadJSON(page, 'Export experiment');
  expect(file.attempts.at(-1)).toMatchObject({move: {label: 'Grabbed point onto mark'}, validation: {status: 'accepted'}});
  const {a, b, e, f} = file.final.facets.at(-1).transform;
  expect(a * anchor + e).toBeCloseTo(x, 12);
  expect(b * anchor + f).toBeCloseTo(y, 12);
  await verifyReplayAndUndo(page, file);
});

test('marks exact intersections with snapping off and snaps to the retained mark after turnover', async ({page}) => {
  const [, [x, y]] = await scoreIntersectingCreases(page);
  const snap = page.getByLabel('Snap to points');
  await expect(snap).not.toBeChecked();
  await page.locator('#paper').scrollIntoViewIfNeeded();
  await page.keyboard.down('Alt');
  await startMouseDrag(page, [1, 0], [x - .013, y + .012]);
  await expect(page.locator('.preview-line')).toHaveCount(1);
  await expect(page.locator('.snap-active,.crease-snap-reference')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await page.keyboard.up('Alt');

  const mark = await screenPoint(page, x, y);
  await page.mouse.move(mark.x + 5, mark.y - 4);
  await expect(page.locator('.intersection-ghost')).toHaveAttribute('cx', String(x));
  await expect(page.locator('.intersection-ghost')).toHaveAttribute('cy', String(y));
  await expect(page.locator('.intersection-reference')).toHaveCount(2);
  await page.mouse.click(mark.x + 5, mark.y - 4);
  await page.getByRole('button', {name: 'Mark point', exact: true}).click();
  const marked = await downloadJSON(page, 'Export experiment');
  expect(marked.final.marks[0].point).toEqual({x, y});

  await page.getByRole('button', {name: 'Flip over', exact: true}).click();
  await snap.check();
  await page.locator('#paper').scrollIntoViewIfNeeded();
  const displayed = page.locator('#paper-marks .material-mark');
  await expect(displayed).toHaveAttribute('cx', String(1 - x));
  await startMouseDrag(page, [1, 0], [1 - x + .013, y + .012]);
  await expect(page.locator('#gesture-reason')).toContainText('Point onto mark');
  await expect(page.locator('.drag-destination')).toHaveAttribute('cx', String(1 - x));
  await expect(page.locator('.drag-destination')).toHaveAttribute('cy', String(y));
  await page.mouse.up();
  await page.getByRole('button', {name: 'Unfold', exact: true}).click();
  await expect(displayed).toHaveAttribute('cx', String(1 - x));
  const file = await downloadJSON(page, 'Export experiment');
  expect(file.attempts.at(-2)).toMatchObject({move: {label: 'Point onto mark'}, validation: {status: 'accepted'}});
  expect(file.final.marks).toEqual(marked.final.marks);
  expect(file.final.creases.slice(0, 3)).toEqual(marked.final.creases);
  await verifyReplayAndUndo(page, file);
});

test('transfers an edge grab onto an exact marked apex and releases the target with Alt', async ({page}) => {
  const y = await scoreHorizontalMarks(page);
  await page.locator('#paper').scrollIntoViewIfNeeded();
  await startMouseDrag(page, [.61, 0], [.012, y - .008]);
  const reason = page.locator('#gesture-reason');
  await expect(reason).toContainText('Grabbed point onto mark');
  const anchor = Number(await page.locator('.drag-anchor').getAttribute('cx'));
  const jitter = await screenPoint(page, .052, y);
  await page.mouse.move(jitter.x, jitter.y);
  await expect(reason).toContainText('Grabbed point onto mark');
  const away = await screenPoint(page, .18, y + .12);
  await page.mouse.move(away.x, away.y);
  await expect(reason).not.toContainText('Grabbed point onto mark');
  const target = await screenPoint(page, .012, y);
  await page.mouse.move(target.x, target.y);
  await expect(reason).toContainText('Grabbed point onto mark');
  await page.keyboard.down('Alt');
  await page.mouse.move(target.x + 1, target.y);
  await expect(page.locator('.snap-active')).toHaveCount(0);
  await page.keyboard.up('Alt');
  await page.mouse.move(target.x, target.y);
  await expect(reason).toContainText('Grabbed point onto mark');
  await expect(page.locator('.constraint-source')).toHaveCount(1);
  await expect(page.locator('.packet-moving')).toHaveCount(1);
  await page.mouse.up();
  const file = await downloadJSON(page, 'Export experiment');
  const attempt = file.attempts.at(-1);
  expect(attempt.move.label).toBe('Grabbed point onto mark');
  expect(attempt.move.intent).toBeUndefined();
  const {a, b, e, f} = file.final.facets.at(-1).transform;
  expect(a * anchor + e).toBeCloseTo(0, 12);
  expect(b * anchor + f).toBeCloseTo(y, 12);
  await verifyReplayAndUndo(page, file);
});

test('drawn creases keep their direction through one mark or use the exact axis through two', async ({page, context}) => {
  const y = await scoreHorizontalMarks(page, true);
  await chooseAdvancedCrease(page);
  const snap = page.getByLabel('Snap to points');
  const axis = () => page.locator('.preview-line').evaluate(el => ['x1', 'y1', 'x2', 'y2'].map(name => Number(el.getAttribute(name))));
  const slope = ([x1, y1, x2, y2]) => (y2 - y1) / (x2 - x1);
  await snap.uncheck();
  await startMouseDrag(page, [.2, y + .022], [.8, y + .088]);
  const drawn = await axis();
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await snap.check();
  const session = await context.newCDPSession(page);
  const first = await screenPoint(page, .2, y + .022);
  const last = await screenPoint(page, .8, y + .088);
  const pen = (type, point) => session.send('Input.dispatchMouseEvent', {
    type, ...point, pointerType: 'pen', button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1,
  });
  await pen('mousePressed', first);
  await pen('mouseMoved', last);
  await expect(page.locator('#gesture-reason')).toContainText('Drawn crease through mark');
  const single = await axis();
  expect(slope(single)).toBeCloseTo(slope(drawn), 10);
  expect(single[1] - single[0] * slope(single)).toBeCloseTo(y, 12);
  await pen('mouseReleased', last);
  await page.keyboard.press('Escape');
  await startMouseDrag(page, [.22, y + .018], [.74, y + .025]);
  await expect(page.locator('#gesture-reason')).toContainText('Drawn crease through two marks');
  await expect(page.locator('.crease-snap-reference')).toHaveCount(2);
  await page.mouse.up();
  await tapCorner(page, [.45, .2]);
  await page.getByRole('button', {name: 'Confirm fold'}).click();
  const file = await downloadJSON(page, 'Export experiment');
  expect(file.attempts.at(-1).move).toMatchObject({label: 'Drawn crease through two marks', line: [[0, y], [1, y]]});
  await verifyReplayAndUndo(page, file);
});

test('places unfold, flip, and pin together above the sheet, separate from history', async ({page}) => {
  const actions = page.getByRole('group', {name: 'Paper actions'});
  await expect(actions.getByRole('button')).toHaveCount(3);
  expect(await actions.locator('button').evaluateAll(buttons => buttons.map(button => button.id))).toEqual([
    'unfold', 'flip-paper', 'pin-point',
  ]);
  await expect(page.locator('.history-controls #unfold')).toHaveCount(0);
  await expect(page.getByRole('button', {name: 'Unfold', exact: true})).toBeDisabled();
  await dragCorner(page, [1, 0], [0, 0]);
  await expect(page.getByRole('button', {name: 'Unfold', exact: true})).toBeEnabled();
  await actions.getByRole('button', {name: 'Unfold', exact: true}).click();
  const saved = await downloadJSON(page, 'Export experiment');
  expect(saved.attempts.at(-1)?.operation).toBe('unfold');
});

test('turns a two-tone half-fold over, folds the exposed layer, and turns it back', async ({page}) => {
  const flip = page.getByRole('button', {name: 'Flip over', exact: true});
  const unfold = page.getByRole('button', {name: 'Unfold', exact: true});
  await page.getByRole('button', {name: 'Two-tone'}).click();
  await dragCorner(page, [1, 0], [0, 0]);
  const before = await renderedFacets(page);
  expect(before.map(({id, face}) => [id, face])).toEqual([[0, 'front'], [1, 'back']]);
  const half = await downloadJSON(page, 'Export experiment');
  await flip.click({timeout: 4000});
  await expect(flip).toHaveAttribute('aria-pressed', 'true');
  expect((await renderedFacets(page)).map(({id, face}) => [id, face])).toEqual([[1, 'front'], [0, 'back']]);
  const turned = await downloadJSON(page, 'Export experiment');
  expect(turned.attempts[1]).toMatchObject({operation: 'flip', move: {axisX: .25}});
  expect(turned.final.facets).toEqual(half.final.facets);
  expect(turned.final.creases).toEqual(half.final.creases);
  await expect(unfold).toBeEnabled();

  await page.locator('#paper').scrollIntoViewIfNeeded();
  await startMouseDrag(page, [.5, 1], [.15, 1]);
  await expect(page.locator('#gesture-status')).toHaveText('accepted');
  await expect(page.locator('.packet-moving')).toHaveCount(1);
  await expect(page.locator('.packet-moving')).toHaveAttribute('data-facet-id', '0');
  await page.mouse.up();
  const folded = await downloadJSON(page, 'Export experiment');
  expect(folded.attempts[2].move.packet).toEqual({facetIds: [0]});
  const {poly, transform} = half.final.facets[1];
  expect(folded.final.facets.find(({id}) => id === 1)).toMatchObject({poly, transform});
  expect((await renderedFacets(page)).map(({id}) => id)).toEqual([1, 0, 2]);
  await unfold.click();
  expect(await renderedFacets(page)).toEqual([
    {...before[1], face: 'front', transform: 'matrix(1 0 0 1 -0.5 0)'},
    {...before[0], face: 'back', transform: 'matrix(-1 0 0 1 0.5 0)'},
  ]);
  await flip.click();
  await expect(flip).toHaveAttribute('aria-pressed', 'false');
  expect(await renderedFacets(page)).toEqual(before);
  const complete = await downloadJSON(page, 'Export experiment');
  expect(complete.final.facets).toEqual(half.final.facets);
  expect(complete.final.creases).toEqual(folded.final.creases);
  await verifyReplayAndUndo(page, complete);
  await expect(flip).toHaveAttribute('aria-pressed', 'true');
  await expect(unfold).toBeEnabled();
});

test('a stylus turns a dog-ear over as one object and exposes its opposite pigment', async ({page, context}) => {
  await page.getByRole('button', {name: 'Two-tone'}).click();
  await dragCorner(page, [1, 1], [.5, .5]);
  const before = await renderedFacets(page);
  expect(await paperPixels(page, [[.2, .2]])).toEqual([[239, 171, 130, 255]]);
  const flip = page.getByRole('button', {name: 'Flip over', exact: true});
  await flip.scrollIntoViewIfNeeded();
  const box = await flip.boundingBox();
  const session = await context.newCDPSession(page);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await session.send('Input.dispatchMouseEvent', {
      type, pointerType: 'pen', x: box.x + box.width / 2, y: box.y + box.height / 2,
      button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1,
    });
  }
  await expect(flip).toHaveAttribute('aria-pressed', 'true');
  expect((await renderedFacets(page)).map(({id, face, points}) => ({id, face, points}))).toEqual(
    [...before].reverse().map(({id, face, points}) => ({id, points, face: face === 'front' ? 'back' : 'front'})),
  );
  expect(await paperPixels(page, [[.8, .2]])).toEqual([[93, 82, 110, 255]]);
  const file = await downloadJSON(page, 'Export experiment');
  expect(file.final.facets).toEqual(file.attempts[0].state.facets);
  expect(file.final.creases).toEqual(file.attempts[0].state.creases);
  await page.getByRole('button', {name: 'Diagonal stripes'}).click();
  // The stripe at material (.2, .2) mirrors with the sheet.
  expect(await paperPixels(page, [[.8, .2], [.75, .2]])).toEqual([
    [120, 46, 55, 255], [229, 152, 119, 255],
  ]);
  await flip.click();
  expect(await renderedFacets(page)).toEqual(before);
});

test('edge alignment and a pinned perpendicular still fold the exposed side after turnover', async ({page}) => {
  const flip = page.getByRole('button', {name: 'Flip over', exact: true});
  await flip.click();
  await startMouseDrag(page, [.62, 0], [.012, .61]);
  await expect(page.locator('#gesture-status')).toHaveText('accepted');
  await expect(page.locator('.constraint-source')).toHaveCount(1);
  await page.mouse.up();
  await expect(page.locator('#history li').last()).toContainText('Align lines');
  await page.getByRole('button', {name: 'Unfold', exact: true}).click();
  await expect(flip).toHaveAttribute('aria-pressed', 'true');
  const pin = await screenPoint(page, .5, 1);
  await page.mouse.move(pin.x, pin.y);
  await page.mouse.down();
  await expect(page.locator('.pin-anchor')).toHaveAttribute('cx', '0.5');
  await page.mouse.up();
  await startMouseDrag(page, [.23, 0], [.77, .011]);
  await expect(page.locator('#gesture-status')).toHaveText('accepted');
  await page.mouse.up();
  await expect(page.locator('#history li').last()).toContainText('Perpendicular through point');
  const file = await downloadJSON(page, 'Export experiment');
  expect(file.attempts.at(-1).move.line.map(([x]) => x)).toEqual([.5, .5]);
  expect(file.final.pose).toEqual(file.attempts[0].state.pose);
  expect((await renderedFacets(page)).map(({id, face}) => [id, face])).toEqual([[0, 'back'], [2, 'front']]);
});

test('mouse drag previews a snapped fold and commits reflected, opaque stripes', async ({page}) => {
  await page.getByRole('button', {name: 'Diagonal stripes'}).click();
  const start = await screenPoint(page, 0, 0);
  await page.mouse.move(start.x, start.y);
  await expect(page.locator('.corner-hover')).toBeVisible();
  await startMouseDrag(page, [0, 0], [.98, 0]);
  await expect(page.locator('.snap-active')).toBeVisible();
  await expect(page.locator('.crease-snap-reference')).toHaveCount(0);
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

test('dragging the bottom edge onto the left edge aligns their material by reflection', async ({page}, testInfo) => {
  await page.getByRole('button', {name: 'Diagonal stripes'}).click();
  await startMouseDrag(page, [.62, 0], [.012, .61]);
  await expect(page.locator('.constraint-source')).toHaveCount(1);
  await expect(page.locator('.constraint-target')).toHaveCount(1);
  await expect(page.locator('#gesture-status')).toHaveText('accepted');
  await captureStage(page, testInfo, 'o3-edge-alignment.png');
  await page.mouse.up();
  const file = await downloadJSON(page, 'Export experiment');
  expect(file.attempts[0].move.label).toBe('Align lines');
  const [a, b] = file.attempts[0].move.line;
  expect(a[0]).toBeCloseTo(a[1], 12);
  expect(b[0]).toBeCloseTo(b[1], 12);
  const {a: xx, b: yx, e, f} = file.final.facets.at(-1).transform;
  expect(xx * .62 + e).toBeCloseTo(0, 12);
  expect(yx * .62 + f).toBeCloseTo(.62, 12);
  await expect(page.locator('#paper-art .paper-facet').last()).toHaveAttribute('data-face', 'back');
});

test('aligns the bottom edge with a retained diagonal crease and replays the exact fold', async ({page}) => {
  await dragCorner(page, [1, 0], [0, 1]);
  await page.getByRole('button', {name: 'Unfold', exact: true}).click();
  await page.locator('#paper').scrollIntoViewIfNeeded();
  await startMouseDrag(page, [.64, 0], [.45, .45]);
  await expect(page.locator('.constraint-source')).toHaveCount(1);
  await expect(page.locator('#gesture-status')).toHaveText('accepted');
  await page.mouse.up();
  const file = await downloadJSON(page, 'Export experiment');
  const {line: [a, b], intent} = file.attempts[2].move;
  expect(intent.kind).toBe('align-lines');
  expect((b[1] - a[1]) / (b[0] - a[0])).toBeCloseTo(Math.SQRT2 - 1, 12);
  expect(file.final.creases).toHaveLength(2);
  const flap = file.final.facets.at(-1);
  const x = flap.transform.a * .64 + flap.transform.e;
  const y = flap.transform.b * .64 + flap.transform.f;
  expect(x).toBeCloseTo(y, 12);
  await verifyReplayAndUndo(page, file);
  await expect(page.locator('.paper-reference')).toHaveCount(1);
});

test('holding the top midpoint and sliding the bottom edge folds through the pin', async ({page}, testInfo) => {
  const pin = await screenPoint(page, .5, 1);
  await page.mouse.move(pin.x, pin.y);
  await page.mouse.down();
  await expect(page.locator('.pin-anchor')).toHaveAttribute('cx', '0.5');
  await expect(page.locator('.pin-anchor')).toHaveAttribute('cy', '1');
  await page.mouse.up();
  await startMouseDrag(page, [.23, 0], [.77, .011]);
  await expect(page.locator('.constraint-source')).toHaveCount(1);
  await expect(page.locator('#gesture-status')).toHaveText('accepted');
  await captureStage(page, testInfo, 'o4-perpendicular-fold.png');
  await page.mouse.up();
  const file = await downloadJSON(page, 'Export experiment');
  const {intent, line} = file.attempts[0].move;
  expect(intent).toMatchObject({kind: 'perpendicular', pin: {x: .5, y: 1}});
  expect(line.map(([x]) => x)).toEqual([.5, .5]);
  expect(file.final.facets.at(-1).transform).toMatchObject({a: -1, d: 1, e: 1});
});

test('crossing creases show both admissible bisectors and suggest the one nearest the pointer', async ({page}) => {
  const unfold = page.getByRole('button', {name: 'Unfold', exact: true});
  await dragCorner(page, [1, 0], [0, 0]);
  await unfold.click();
  await page.locator('#paper').scrollIntoViewIfNeeded();
  await dragCorner(page, [0, 1], [0, 0]);
  await unfold.click();
  await page.locator('#paper').scrollIntoViewIfNeeded();
  await startMouseDrag(page, [.73, .5], [.505, .73]);
  await expect(page.locator('#gesture-status')).toHaveText('accepted');
  expect(Number(await page.locator('.drag-destination').getAttribute('cy'))).toBeGreaterThan(.7);
  await page.mouse.up();
  await expect(page.locator('#history-count')).toHaveText('4 attempts');
  const choice = page.getByRole('combobox', {name: 'Fold preview', exact: true});
  await expect(choice.locator('option')).toHaveCount(2);
  await choice.selectOption('1');
  expect(Number(await page.locator('.drag-destination').getAttribute('cy'))).toBeLessThan(.3);
  await page.getByRole('button', {name: 'Confirm fold', exact: true}).click();
  const file = await downloadJSON(page, 'Export experiment');
  expect(file.attempts.at(-1)).toMatchObject({move: {intent: {kind: 'align-lines'}}, validation: {status: 'accepted'}});
});

async function expectTwoPointPreview(page) {
  await expect(page.locator('.preview-line.crease-snapped')).toBeVisible();
  const references = await page.locator('.crease-snap-reference').evaluateAll(circles =>
    circles.map(circle => [Number(circle.getAttribute('cx')), Number(circle.getAttribute('cy'))]));
  expect(references.sort()).toEqual([[0, .5], [1, 1]]);
  const landing = page.locator('.drag-destination');
  expect(Number(await landing.getAttribute('cx'))).toBeCloseTo(.4, 12);
  expect(Number(await landing.getAttribute('cy'))).toBeCloseTo(.2, 12);
  await expect(page.locator('#gesture-status')).toHaveText('accepted');
}

test('mouse drag snaps the crease through a vertex and midpoint and records the exact reflection', async ({page}) => {
  await dragCorner(page, [1, 0], [0, 0]);
  await page.getByRole('button', {name: 'Unfold', exact: true}).click();
  await page.locator('#paper').scrollIntoViewIfNeeded();
  await startMouseDrag(page, [0, 1], [.418, .21]);
  await expectTwoPointPreview(page);
  for (const [x, y] of [[.396, .181], [.421, .219], [.401, .193]]) {
    const point = await screenPoint(page, x, y);
    await page.mouse.move(point.x, point.y);
    await expectTwoPointPreview(page);
  }
  await page.mouse.up();
  const experiment = await downloadJSON(page, 'Export experiment');
  const {move, validation} = experiment.attempts.at(-1);
  expect([...move.line].sort()).toEqual([[0, .5], [1, 1]]);
  expect(validation.status).toBe('accepted');
  const [fixed, flap] = experiment.final.facets;
  const project = ({transform: {a, b, c, d, e, f}}, [x, y]) =>
    [a * x + c * y + e, b * x + d * y + f];
  expect(flap.z).toBeGreaterThan(fixed.z);
  expect(flap.poly).toContainEqual({x: 0, y: 1});
  const [x, y] = project(flap, [0, 1]);
  expect(x).toBeCloseTo(.4, 12);
  expect(y).toBeCloseTo(.2, 12);
  for (const point of move.line) {
    const [fx, fy] = project(flap, point);
    const [sx, sy] = project(fixed, point);
    expect(Math.hypot(fx - sx, fy - sy)).toBeLessThan(1e-12);
  }
  await verifyReplayAndUndo(page, experiment);
});

test('the existing snapping toggle leaves a nearby two-point crease unsnapped', async ({page}) => {
  await page.getByLabel('Snap to points').uncheck();
  await startMouseDrag(page, [0, 1], [.418, .21]);
  await expect(page.locator('.preview-line')).toBeVisible();
  await expect(page.locator('.crease-snap-reference')).toHaveCount(0);
  expect(Number(await page.locator('.drag-destination').getAttribute('cx'))).toBeCloseTo(.418, 2);
  await page.mouse.up();
  await expect(page.locator('#history-count')).toHaveText('1 attempt');
});

test('mouse jitter toward a competing line keeps the acquired two-point crease', async ({page}) => {
  const snapping = page.getByLabel('Snap to points');
  await snapping.uncheck();
  const bottom = await screenPoint(page, 0, 0);
  const top = await screenPoint(page, 0, 1);
  const height = .5 + 9 / (bottom.y - top.y);
  await dragCorner(page, [0, 0], [0, 2 * height]);
  const setup = await downloadJSON(page, 'Export experiment');
  const reference = setup.final.creases[0].a.y;
  expect(reference).toBeGreaterThan(.5);
  await page.getByRole('button', {name: 'Unfold', exact: true}).click();
  await snapping.check();
  await page.locator('#paper').scrollIntoViewIfNeeded();

  // The visible left endpoint of the retained crease, together with the
  // upper-right vertex, defines a nearby rival for the edge-midpoint line.
  const rise = 1 - reference;
  const rivalX = 2 * rise ** 2 / (1 + rise ** 2);
  const rivalY = 1 - 2 * rise / (1 + rise ** 2);
  const rival = await screenPoint(page, rivalX, rivalY);
  await startMouseDrag(page, [0, 1], [.4, .2]);
  await expectTwoPointPreview(page);
  await page.mouse.move(rival.x, rival.y);
  await expectTwoPointPreview(page);
  await page.mouse.up();
  const choice = page.getByRole('combobox', {name: 'Snap target'});
  await expect(choice).toBeVisible();
  await choice.selectOption({index: 1});
  await expect(page.locator('.crease-snap-reference[cx="0"]')).toHaveAttribute('cy', String(reference));
  await page.keyboard.press('Escape');

  const anchor = await screenPoint(page, 0, 1);
  await page.mouse.move(anchor.x, anchor.y);
  await page.mouse.down();
  await page.mouse.move(rival.x, rival.y);
  const edgeReference = page.locator('.crease-snap-reference[cx="0"]');
  await expect(edgeReference).toHaveAttribute('cy', String(reference));
  await page.keyboard.press('Escape');
  await page.mouse.up();
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
  await startMouseDrag(page, [1, 0], [.52, 0]);
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
  await dragCorner(page, [1, 1], [1, .52]);
  await expect(page.locator('#history-count')).toHaveText('3 attempts');
  const experiment = await downloadJSON(page, 'Export experiment');
  expect(experiment.attempts[2].move.packet.facetIds).toEqual([2, 3]);
  expect(experiment.attempts[2].validation.code).toBe('packet-fold');
  await page.locator('#history button').nth(2).click();
  await expect(page.locator('#sheet-caption')).toHaveText('4 facets · 2 folds');
  await expect(page.getByRole('button', {name: 'Undo', exact: true})).toBeDisabled();
  await page.getByRole('button', {name: 'Replay', exact: true}).click();
  await expect(page.locator('#sheet-caption')).toHaveText('6 facets · 3 folds');
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
  await dragCorner(page, [0, 1], [.33, 1]);
  await expect(page.locator('#sheet-caption')).toHaveText('3 facets · 2 folds');
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
  await expect(choice.locator('option')).toHaveText(['Open flap · 2 connected facets', '3 connected facets']);
  await expect(choice).toHaveValue('0');
  await expect(page.locator('#gesture-reason')).toContainText('Open flap');
  await choice.selectOption('1');
  await expect(page.locator('#gesture-reason')).not.toContainText('Open flap');
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
  const experiment = await downloadJSON(page, 'Export experiment');
  const {move, state, validation} = experiment.attempts.at(-1);
  expect(validation.status).toBe('accepted');
  expect(move.geometry).toMatchObject({
    kind: 'point-on-line',
    branch: 'after-foot',
    target: {facetId: 0, crease: 0, line: {a: {x: .5, y: 1}, b: {x: .5, y: 0}}},
    moving: {point: {x: 1, y: .5}, material: {facetId: 0}},
    pin: {material: {facetId: 0}},
  });
  expect(move.geometry.landing.x).toBeCloseTo(.5, 12);
  expect(move.geometry.landing.y).toBeLessThan(.5);
  const {a, b, c, d, e, f} = state.facets.at(-1).transform;
  expect(a + c * .5 + e).toBeCloseTo(move.geometry.landing.x, 12);
  expect(b + d * .5 + f).toBeCloseTo(move.geometry.landing.y, 12);
  await page.getByText('Geometric provenance', {exact: true}).click();
  await expect(page.locator('#geometry-report')).toContainText('Unverified');
  await verifyReplayAndUndo(page, experiment);
  const tampered = structuredClone(experiment);
  tampered.attempts.at(-1).move.geometry.branch = 'before-foot';
  await page.locator('#import-file').setInputFiles({
    name: 'wrong-branch.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(tampered)),
  });
  await expect(page.locator('#notice')).toContainText('does not match the selected line or solution branch');
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

for (const pointer of ['mouse', 'pen', 'touch']) {
  test(`dragging a marked point past another mark with ${pointer} acquires a perpendicular crease`, async ({page, context}) => {
    const unfold = page.getByRole('button', {name: 'Unfold', exact: true});
    for (const [start, end] of [[[1, 0], [0, 0]], [[0, 1], [0, 0]]]) {
      await page.locator('#paper').scrollIntoViewIfNeeded();
      await dragCorner(page, start, end);
      await unfold.click();
    }
    for (const point of [[.5, 1], [.5, .5]]) {
      await page.locator('#paper').scrollIntoViewIfNeeded();
      await tapCorner(page, point, 4);
      await page.getByRole('button', {name: 'Mark point', exact: true}).click();
    }
    await page.locator('#paper').scrollIntoViewIfNeeded();
    if (pointer === 'mouse') {
      await startMouseDrag(page, [.5, 1], [.5, .5]);
      await expect(page.locator('#gesture-reason')).toContainText('Point onto mark');
      await page.keyboard.press('Escape');
      await page.mouse.up();
    }
    const session = await context.newCDPSession(page);
    const send = async (phase, point) => {
      if (pointer === 'touch') {
        await session.send('Input.dispatchTouchEvent', {type: `touch${phase}`, touchPoints: phase === 'End' ? [] : [point]});
      } else {
        const type = {Start: 'mousePressed', Move: 'mouseMoved', End: 'mouseReleased'}[phase];
        await session.send('Input.dispatchMouseEvent', {type, ...point, pointerType: pointer, button: 'left',
          buttons: phase === 'End' ? 0 : 1, clickCount: 1});
      }
    };
    await send('Start', await screenPoint(page, .5, 1));
    await send('Move', await screenPoint(page, .515, .012));
    await expect(page.locator('#gesture-reason')).toContainText('Perpendicular through mark');
    const jitter = await screenPoint(page, .52, .02);
    await send('Move', jitter);
    await expect(page.locator('#gesture-reason')).toContainText('Perpendicular through mark');
    await expect(page.locator('.drag-destination')).toHaveAttribute('cx', '0.5');
    await expect(page.locator('.drag-destination')).toHaveAttribute('cy', '0');
    await expect(page.locator('#gesture-status')).toHaveText('accepted');
    await send('End', jitter);
    const experiment = await downloadJSON(page, 'Export experiment');
    const {move, validation} = experiment.attempts.at(-1);
    expect(validation.status).toBe('accepted');
    expect(move.geometry).toMatchObject({
      kind: 'marked-perpendicular',
      moving: {material: {markId: 5}},
      through: {material: {markId: 6}},
      source: {crease: 0},
      landing: {x: .5, y: 0},
    });
    expect(move.line.every(([, y]) => y === .5)).toBe(true);
    await page.getByText('Geometric provenance', {exact: true}).click();
    await expect(page.locator('#geometry-report')).toContainText('Certified');
    await verifyReplayAndUndo(page, experiment);
  });
}

test('an oblique freehand crease supports a conditional marked perpendicular after turnover', async ({page}) => {
  const unfold = page.getByRole('button', {name: 'Unfold', exact: true});
  const snapping = page.getByLabel('Snap to points');
  await snapping.uncheck();
  await dragCorner(page, [0, 1], [.987, .006]);
  await unfold.click();
  await snapping.check();

  // Drawing between opposite edge midpoints constructs the horizontal by O1.
  await chooseAdvancedCrease(page);
  await dragCorner(page, [.01, .502], [.99, .498]);
  await tapCorner(page, [.28, .22]);
  await page.getByRole('button', {name: 'Confirm fold', exact: true}).click();
  await page.getByText('Geometric provenance', {exact: true}).click();
  await expect(page.locator('#geometry-report')).toHaveText('Certified. Exact line through the two selected points.');
  const scored = await downloadJSON(page, 'Export experiment');
  expect(scored.attempts.at(-1).move.geometry.points.map(({material}) => material.edgeMidpoint).sort()).toEqual([1, 3]);
  await unfold.click();
  const {a, b} = scored.final.creases[0];
  const p = a.x < b.x ? a : b;
  const q = {x: a.x + (.5 - a.y) * (b.x - a.x) / (b.y - a.y), y: .5};
  for (const {x, y} of [p, q]) {
    await page.locator('#paper').scrollIntoViewIfNeeded();
    await tapCorner(page, [x, y], 3);
    await page.getByRole('button', {name: 'Mark point', exact: true}).click();
  }
  const marked = await downloadJSON(page, 'Export experiment');
  const ids = marked.final.marks.map(({id}) => id);
  await page.getByRole('button', {name: 'Flip over', exact: true}).click();
  await page.locator('#paper').scrollIntoViewIfNeeded();
  const grab = [1 - p.x, p.y];
  const landing = [1 - (2 * q.x - p.x), 2 * q.y - p.y];
  await startMouseDrag(page, grab, [landing[0] + .015, landing[1] - .007]);
  await expect(page.locator('#gesture-reason')).toContainText('Perpendicular through mark');
  await expect(page.locator('.perpendicular-marker')).toBeVisible();
  await page.mouse.up();
  const folded = await downloadJSON(page, 'Export experiment');
  const {move, validation} = folded.attempts.at(-1);
  expect(validation.status).toBe('accepted');
  expect(move.geometry).toMatchObject({
    kind: 'marked-perpendicular',
    moving: {material: {markId: ids[0]}},
    through: {material: {markId: ids[1]}},
    source: {crease: 0},
  });
  expect(move.geometry.landing.x).toBeCloseTo(landing[0], 12);
  expect(move.geometry.landing.y).toBeCloseTo(landing[1], 12);
  const [[ax, ay], [bx, by]] = move.line;
  expect(Math.abs((bx - ax) * (a.x - b.x) + (by - ay) * (b.y - a.y))).toBeLessThan(1e-12);
  expect(Math.abs((bx - ax) * (q.y - ay) - (by - ay) * (1 - q.x - ax))).toBeLessThan(1e-12);
  await expect(page.locator('#geometry-report')).toContainText('Conditional');
  await expect(page.locator('#geometry-dependencies')).toContainText('step:1:crease:0:freehand');
  await unfold.click();
  const unfolded = await downloadJSON(page, 'Export experiment');
  expect(unfolded.final.marks).toEqual(marked.final.marks);
  expect(unfolded.final.pose.reversed).toBe(true);
  await verifyReplayAndUndo(page, unfolded);
  await unfold.click();

  // A nearby freehand drag stays a numerical near match even with the same marks visible.
  await snapping.uncheck();
  await page.locator('#paper').scrollIntoViewIfNeeded();
  await dragCorner(page, grab, [landing[0] + .008, landing[1] + .004]);
  await page.getByText('Geometric provenance', {exact: true}).click();
  await expect(page.locator('#geometry-report')).toContainText('Near match');
  const approximate = await downloadJSON(page, 'Export experiment');
  expect(approximate.attempts.at(-1).move.geometry).toEqual({version: 1, kind: 'freehand'});

  const tampered = structuredClone(folded);
  tampered.attempts.at(-1).move.geometry.source.crease = 1;
  await page.locator('#import-file').setInputFiles({
    name: 'wrong-supporting-crease.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(tampered)),
  });
  await expect(page.locator('#notice')).toContainText('Geometric evidence at attempt');
  expect(await downloadJSON(page, 'Export experiment')).toEqual(approximate);
});

test('competing marked perpendiculars expose distinct fold previews', async ({page}) => {
  const unfold = page.getByRole('button', {name: 'Unfold', exact: true});
  const snapping = page.getByLabel('Snap to points');
  await dragCorner(page, [1, 0], [0, 0]);
  await unfold.click();
  await snapping.uncheck();
  for (const landing of [.12, .16]) {
    await page.locator('#paper').scrollIntoViewIfNeeded();
    await dragCorner(page, [0, 1], [0, landing]);
    await unfold.click();
  }
  const {final: {creases}} = await downloadJSON(page, 'Export experiment');
  const heights = creases.slice(1).map(({a}) => a.y);
  for (const y of [1, ...heights]) {
    await page.locator('#paper').scrollIntoViewIfNeeded();
    await tapCorner(page, [.5, y]);
    await page.getByRole('button', {name: 'Mark point', exact: true}).click();
  }
  await snapping.check();
  await page.locator('#paper').scrollIntoViewIfNeeded();
  const end = heights[0] + heights[1] - 1;
  const grab = await screenPoint(page, .5, 1);
  const destination = await screenPoint(page, .5, end);
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(destination.x, destination.y);
  await expect(page.locator('#gesture-reason')).toContainText('Perpendicular through mark');
  await page.mouse.up();
  const choices = page.getByRole('combobox', {name: 'Snap target'});
  const perpendiculars = choices.locator('option').filter({hasText: 'Perpendicular through mark'});
  await expect(perpendiculars).toHaveCount(2);
  await choices.selectOption({value: await perpendiculars.last().getAttribute('value')});
  const selected = Number(await page.locator('.drag-destination').getAttribute('cy'));
  await page.getByRole('button', {name: 'Confirm fold', exact: true}).click();
  const {attempts} = await downloadJSON(page, 'Export experiment');
  const {move, validation} = attempts.at(-1);
  expect(validation.status).toBe('accepted');
  expect(move.geometry.kind).toBe('marked-perpendicular');
  expect(move.geometry.landing.y).toBe(selected);
  expect(heights.some(y => Math.abs(y - move.geometry.through.point.y) < 1e-12)).toBe(true);
});

test('synthetic equilateral gestures distinguish a certified horizontal from a close freehand axis', async ({page}) => {
  const unfold = page.getByRole('button', {name: 'Unfold', exact: true});
  const pinAt = async (x, y) => {
    const pin = await screenPoint(page, x, y);
    await page.mouse.move(pin.x, pin.y);
    await page.mouse.down();
    await expect(page.locator('.pin-anchor')).toBeVisible({timeout: 2000});
    await page.mouse.up();
  };

  await dragCorner(page, [1, 0], [0, 0]);
  await unfold.click();
  await page.locator('#paper').scrollIntoViewIfNeeded();
  await pinAt(0, 0);
  await dragCorner(page, [1, 0], [.52, .79]);
  await expect(page.locator('#history li').last()).toContainText('Point onto line');

  const height = Math.sqrt(3) / 2;
  await page.locator('#paper').scrollIntoViewIfNeeded();
  await pinAt(.5, height);
  await startMouseDrag(page, [.5, 1], [.5, 2 * height - 1]);
  await expect(page.locator('.constraint-source')).toHaveAttribute('x1', '0.5');
  await expect(page.locator('#gesture-status')).toHaveText('accepted');
  await page.mouse.up();
  await expect(page.locator('#history li').last()).toContainText('Perpendicular through point');

  await page.getByText('Geometric provenance', {exact: true}).click();
  const report = page.locator('#geometry-report');
  await expect(report).toHaveText('Certified. Horizontal through the certified apex at y = √3/2.');
  await expect(page.locator('#geometry-dependencies')).toHaveText('References · step:3:landing, step:1:axis');
  const certified = await downloadJSON(page, 'Export experiment');
  expect(certified.attempts.map(({move}) => move.geometry?.kind))
    .toEqual(['vertex-bisector', undefined, 'point-on-line', 'perpendicular-through']);
  expect(certified.attempts[2].move.geometry).toMatchObject({
    branch: 'before-foot', target: {facetId: 0, crease: 0},
    pin: {material: {corner: 'A'}}, moving: {material: {corner: 'B'}},
  });
  const horizontal = certified.attempts.at(-1);
  expect(horizontal.move.geometry).toMatchObject({pin: {corner: 'B'}, source: {facetId: 0, crease: 0}});
  expect(horizontal.validation.status).toBe('accepted');
  for (const [, y] of horizontal.move.line) expect(y).toBeCloseTo(height, 12);
  expect(certified.final.creases.length).toBeGreaterThan(certified.attempts[2].state.creases.length);
  await verifyReplayAndUndo(page, certified);

  // A synthetic close call modeled on the reported tilted Point drag.
  await page.getByLabel('Snap to points').uncheck();
  await page.locator('#paper').scrollIntoViewIfNeeded();
  await dragCorner(page, [0, 1], [.00131, .73066]);
  await expect(page.locator('#history li').last()).toContainText('Point drag');
  await page.getByText('Geometric provenance', {exact: true}).click();
  await expect(report).toHaveText('Near match. Freehand axis is near the horizontal through the certified apex.');
  const near = await downloadJSON(page, 'Export experiment');
  const {move, validation} = near.attempts.at(-1);
  expect(validation.status).toBe('accepted');
  expect(move.geometry).toEqual({version: 1, kind: 'freehand'});
  const [[ax, ay], [bx, by]] = move.line;
  expect((by - ay) / (bx - ax)).toBeCloseTo(.005, 3);

  await page.reload();
  await importJSON(page, near);
  await page.getByText('Geometric provenance', {exact: true}).click();
  await expect(report).toContainText('Near match');
  expect(await downloadJSON(page, 'Export experiment')).toEqual(near);
});

test('unfolds a snapped fold over an O5 flap and then unfolds the O5 fold', async ({page}) => {
  const unfold = page.getByRole('button', {name: 'Unfold', exact: true});
  await dragCorner(page, [1, 0], [0, 0]);
  await unfold.click();
  await page.locator('#paper').scrollIntoViewIfNeeded();
  const pin = await screenPoint(page, 0, 0);
  await page.mouse.move(pin.x, pin.y);
  await page.mouse.down();
  await expect(page.locator('.pin-anchor')).toBeVisible({timeout: 2000});
  await page.mouse.up();
  await dragCorner(page, [1, 0], [.52, .79]);
  await expect(page.locator('#history li').last()).toContainText('Point onto line');
  await page.locator('#paper').scrollIntoViewIfNeeded();

  // Project the upper-left corner across the exposed edge of the O5 flap.
  await startMouseDrag(page, [0, 1], [.87, .493]);
  await expect(page.locator('.preview-line.crease-snapped')).toBeVisible();
  await expect(page.locator('#gesture-status')).toHaveText('accepted');
  await page.mouse.up();
  await expect(page.locator('#history li').last()).toContainText('Crease through two points');
  const folded = await downloadJSON(page, 'Export experiment');
  expect(folded.final.creases).toHaveLength(3);

  await unfold.click();
  const reopened = await downloadJSON(page, 'Export experiment');
  expect(reopened.attempts.at(-1).move.foldAttempt).toBe(4);
  expect(reopened.final.facets).toEqual(folded.attempts[2].state.facets);
  expect(reopened.final.creases).toEqual(folded.final.creases);
  await expect(unfold).toBeEnabled();
  await unfold.click();
  const flat = await downloadJSON(page, 'Export experiment');
  expect(flat.attempts.at(-1).move.foldAttempt).toBe(3);
  expect(flat.final.facets).toEqual(flat.initial.facets);
  expect(flat.final.creases).toEqual(folded.final.creases);
  const actualEndpoints = flat.final.creases.map(({a, b}) => [a, b].sort((p, q) => p.x - q.x || p.y - q.y));
  const expectedEndpoints = [
    [[.5, 0], [.5, 1]], [[0, 0], [1, 1 / Math.sqrt(3)]], [[0, 0], [1 / Math.sqrt(3), 1]],
  ];
  actualEndpoints.forEach((endpoints, i) => endpoints.forEach(({x, y}, j) => {
    expect(x).toBeCloseTo(expectedEndpoints[i][j][0], 12);
    expect(y).toBeCloseTo(expectedEndpoints[i][j][1], 12);
  }));
  await expect(unfold).toBeDisabled();

  await page.getByRole('button', {name: 'Crease pattern', exact: true}).click();
  const pattern = await downloadJSON(page, 'Export FOLD');
  expect(pattern.edges_assignment.every(assignment => assignment === 'F' || assignment === 'B')).toBe(true);
  const flatEdges = pattern.edges_vertices.flatMap((edge, i) => pattern.edges_assignment[i] === 'F'
    ? [edge.map(vertex => pattern.vertices_coords[vertex])] : []);
  const totalLength = patternEdges => patternEdges.reduce((sum, [a, b]) =>
    sum + Math.hypot(a[0] - b[0], a[1] - b[1]), 0);
  expect(totalLength(flatEdges)).toBeCloseTo(totalLength(expectedEndpoints), 12);
  for (const edge of flatEdges) {
    expect(expectedEndpoints.some(([[ax, ay], [bx, by]]) => edge.every(([x, y]) =>
      Math.abs((bx - ax) * (y - ay) - (by - ay) * (x - ax)) < 1e-12))).toBe(true);
  }
  await page.getByRole('button', {name: 'Folded', exact: true}).click();
  await verifyReplayAndUndo(page, flat);
  const undone = await downloadJSON(page, 'Export experiment');
  expect(undone.final).toEqual(reopened.final);
  await expect(unfold).toBeEnabled();
});

test('an offset tap marks an exact crease crossing and the dot can be pinned, snapped to, and removed', async ({page}) => {
  const unfold = page.getByRole('button', {name: 'Unfold', exact: true});
  const mark = page.getByRole('button', {name: 'Mark point', exact: true});
  const dot = page.locator('#paper-marks .material-mark');
  await dragCorner(page, [1, 0], [0, 0]);
  await unfold.click();
  await page.locator('#paper').scrollIntoViewIfNeeded();
  await dragCorner(page, [0, 1], [0, .2]);
  await unfold.click();
  await page.locator('#paper').scrollIntoViewIfNeeded();
  const setup = await downloadJSON(page, 'Export experiment');
  const y = setup.final.creases[1].a.y;
  expect(y).toBeCloseTo(.6, 2);
  await expect(dot).toHaveCount(0);
  await tapCorner(page, [.5, y], 7);
  await expect(mark).toBeVisible();
  await mark.click();
  await expect(dot).toHaveAttribute('cx', '0.5');
  await expect(dot).toHaveAttribute('cy', String(y));
  const marked = await downloadJSON(page, 'Export experiment');
  expect(marked.final.marks).toEqual([{id: 5, point: {x: .5, y}}]);

  await page.locator('#paper').scrollIntoViewIfNeeded();
  const near = await screenPoint(page, .5, y);
  await page.mouse.move(near.x + 14, near.y + 13);
  await page.mouse.down();
  await expect(page.locator('.pin-anchor')).toHaveAttribute('cx', '0.5');
  await expect(page.locator('.pin-anchor')).toHaveAttribute('cy', String(y));
  await page.mouse.up();
  await startMouseDrag(page, [1, 0], [.04, .012]);
  await expect(page.locator('.constraint-target')).toHaveAttribute('y1', '0');
  await expect(page.locator('#gesture-status')).toHaveText('accepted');
  expect(Number(await page.locator('.drag-destination').getAttribute('cx'))).toBeCloseTo(0, 12);
  await page.mouse.up();
  await expect(page.locator('#history li').last()).toContainText('Perpendicular through point');
  await unfold.click();
  await page.locator('#paper').scrollIntoViewIfNeeded();
  const slope = 2 * y;
  const reflectX = 2 * slope / (1 + slope ** 2);
  const reflectY = (slope ** 2 - 1) / (1 + slope ** 2);
  await startMouseDrag(page, [0, 1], [reflectX - .01, reflectY + .01]);
  await expect(page.locator('.crease-snap-reference[cx="0.5"]')).toHaveAttribute('cy', String(y));
  expect(Number(await page.locator('.drag-destination').getAttribute('cx'))).toBeCloseTo(reflectX, 12);
  expect(Number(await page.locator('.drag-destination').getAttribute('cy'))).toBeCloseTo(reflectY, 12);
  await page.mouse.up();
  await expect(page.locator('#history li').last()).toContainText('Crease through two points');
  await unfold.click();
  await page.locator('#paper').scrollIntoViewIfNeeded();
  await startMouseDrag(page, [1, 1], [.518, y + .01]);
  await expect(page.locator('.drag-destination')).toHaveAttribute('cx', '0.5');
  await expect(page.locator('.drag-destination')).toHaveAttribute('cy', String(y));
  await expect(page.locator('#gesture-status')).toHaveText('accepted');
  await page.mouse.up();
  await unfold.click();
  await expect(dot).toHaveAttribute('data-mark-id', '5');
  await expect(dot).toHaveAttribute('cy', String(y));

  await page.locator('#paper').scrollIntoViewIfNeeded();
  await tapCorner(page, [.5, y], 6);
  await page.getByRole('button', {name: 'Remove mark', exact: true}).click();
  await expect(dot).toHaveCount(0);
  const removed = await downloadJSON(page, 'Export experiment');
  expect(removed.attempts.at(-1)).toMatchObject({operation: 'remove-mark', move: {markAttempt: 5}});
  await verifyReplayAndUndo(page, removed);
  await expect(dot).toHaveAttribute('data-mark-id', '5');
});

test('drags a marked point along its crease through an on-line pin to a landing beyond the segment', async ({page}) => {
  const unfold = page.getByRole('button', {name: 'Unfold', exact: true});
  await dragCorner(page, [1, 0], [0, 0]);
  await unfold.click();
  await page.locator('#paper').scrollIntoViewIfNeeded();
  await dragCorner(page, [0, 0], [0, .8]);
  await unfold.click();
  await page.locator('#paper').scrollIntoViewIfNeeded();
  const scored = await downloadJSON(page, 'Export experiment');
  await tapCorner(page, [.5, scored.final.creases[1].a.y], 6);
  await page.getByRole('button', {name: 'Mark point', exact: true}).click();
  const file = await downloadJSON(page, 'Export experiment');
  const {point} = file.final.marks[0];

  await page.locator('#paper').scrollIntoViewIfNeeded();
  const pin = await screenPoint(page, .5, .83);
  await page.mouse.move(pin.x, pin.y);
  await page.mouse.down();
  await expect(page.locator('.pin-anchor')).toHaveAttribute('cx', '0.5');
  const pinY = Number(await page.locator('.pin-anchor').getAttribute('cy'));
  await page.mouse.up();
  await startMouseDrag(page, [point.x, point.y], [.508, .72]);
  await expect(page.locator('#gesture-status')).toHaveText('accepted');
  await expect(page.locator('.perpendicular-marker')).toBeVisible();
  const landing = page.locator('.drag-destination');
  expect(Number(await landing.getAttribute('cx'))).toBeCloseTo(.5, 12);
  expect(Number(await landing.getAttribute('cy'))).toBeCloseTo(2 * pinY - point.y, 12);
  expect(Number(await landing.getAttribute('cy'))).toBeGreaterThan(1);
  await page.mouse.up();

  const folded = await downloadJSON(page, 'Export experiment');
  const attempt = folded.attempts.at(-1);
  expect(attempt.validation.status).toBe('accepted');
  expect(attempt.move.intent).toMatchObject({kind: 'perpendicular-point', moving: point,
    pin: {x: .5, y: pinY}, source: {facetId: 0}});
  expect(attempt.move.line.map(([, y]) => y)).toEqual([pinY, pinY]);
  expect(attempt.move.packet.facetIds).toEqual([0]);
  const {b, d, f} = folded.final.facets.at(-1).transform;
  expect(b * point.x + d * point.y + f).toBeCloseTo(2 * pinY - point.y, 12);
  await verifyReplayAndUndo(page, folded);
});

test('grabs an edge midpoint as a point after pinning elsewhere', async ({page}) => {
  const pinScreen = await screenPoint(page, .73, .46);
  await page.mouse.move(pinScreen.x, pinScreen.y);
  await page.mouse.down();
  await expect(page.locator('.pin-anchor')).toBeVisible();
  const x = Number(await page.locator('.pin-anchor').getAttribute('cx'));
  await page.mouse.up();
  await startMouseDrag(page, [.5, 1], [.8, .994]);
  await expect(page.locator('#gesture-status')).toHaveText('accepted');
  await expect(page.locator('.perpendicular-marker')).toBeVisible();
  expect(Number(await page.locator('.drag-destination').getAttribute('cx'))).toBeCloseTo(2 * x - .5, 12);
  await page.mouse.up();
  const file = await downloadJSON(page, 'Export experiment');
  expect(file.attempts[0].move.intent).toMatchObject({
    kind: 'perpendicular-point', moving: {x: .5, y: 1}, source: {facetId: 0},
  });
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

  test('an ordinary touch drag opens the half-fold from its free edge', async ({page, context}) => {
    const session = await context.newCDPSession(page);
    const touch = (type, point) => session.send('Input.dispatchTouchEvent', {type, touchPoints: point ? [point] : []});
    await touch('touchStart', await screenPoint(page, 1, 0));
    await touch('touchMove', await screenPoint(page, 0, 0));
    await touch('touchEnd');
    await expect(page.locator('#history-count')).toHaveText('1 attempt');

    await touch('touchStart', await screenPoint(page, 0, .41));
    await touch('touchMove', await screenPoint(page, .98, .41));
    await expect(page.locator('#gesture-reason')).toContainText('Open flap');
    await expect(page.locator('.drag-destination')).toHaveAttribute('cx', '1');
    await touch('touchEnd');
    const opened = await downloadJSON(page, 'Export experiment');
    expect(opened.attempts[1]).toMatchObject({operation: 'unfold', move: {foldAttempt: 1}});
    expect(opened.final.creases).toEqual(opened.attempts[0].state.creases);
    expect(opened.final.facets).toEqual(opened.initial.facets);
  });

  test('touch previews an intersection and transfers a grabbed edge point to its mark', async ({page, context}) => {
    const session = await context.newCDPSession(page);
    const event = (type, point) => session.send('Input.dispatchTouchEvent', {type, touchPoints: point ? [point] : []});
    const start = await screenPoint(page, 0, 0);
    await event('touchStart', start);
    await event('touchMove', await screenPoint(page, 0, .82));
    await event('touchEnd');
    await page.getByRole('button', {name: 'Unfold', exact: true}).tap();
    await page.locator('#paper').scrollIntoViewIfNeeded();
    const file = await downloadJSON(page, 'Export experiment');
    const y = file.final.creases[0].a.y;
    const mark = await screenPoint(page, 0, y);
    await event('touchStart', {x: mark.x + 5, y: mark.y + 4});
    await expect(page.locator('.intersection-ghost')).toHaveAttribute('cy', String(y));
    await event('touchEnd');
    await page.getByRole('button', {name: 'Mark point', exact: true}).tap();
    await page.locator('#paper').scrollIntoViewIfNeeded();
    await event('touchStart', await screenPoint(page, .61, 0));
    await event('touchMove', await screenPoint(page, .016, y + .014));
    await expect(page.locator('#gesture-reason')).toContainText('Grabbed point onto mark');
    await expect(page.locator('.drag-destination')).toHaveAttribute('cy', String(y));
    await event('touchEnd');
    await expect(page.locator('#history li').last()).toContainText('Grabbed point onto mark');
  });

  test('drags the marked crease point on the exposed ply of an overlapping stack', async ({page, context}) => {
    const session = await context.newCDPSession(page);
    const event = (type, point) => session.send('Input.dispatchTouchEvent', {type, touchPoints: point ? [point] : []});
    const begin = async (from, to) => {
      await page.locator('#paper').scrollIntoViewIfNeeded();
      await event('touchStart', await screenPoint(page, ...from));
      await event('touchMove', await screenPoint(page, ...to));
      await expect(page.locator('#gesture-status')).toHaveText('accepted');
    };
    await begin([0, 1], [0, 0]);
    await event('touchEnd');
    await page.getByRole('button', {name: 'Unfold', exact: true}).tap();
    await page.locator('#paper').scrollIntoViewIfNeeded();
    const edge = await screenPoint(page, 1, .5);
    await page.touchscreen.tap(edge.x - 5, edge.y + 4);
    await page.getByRole('button', {name: 'Mark point', exact: true}).tap();
    await begin([1, 0], [0, 0]);
    await event('touchEnd');
    const dot = page.locator('#paper-marks .material-mark');
    await expect(dot).toHaveAttribute('cx', '0');
    const folded = await downloadJSON(page, 'Export experiment');
    const [lower, upper] = folded.final.facets;

    await page.locator('#paper').scrollIntoViewIfNeeded();
    await event('touchStart', await screenPoint(page, .32, .24));
    await expect(page.locator('.pin-anchor')).toBeVisible();
    const pinX = Number(await page.locator('.pin-anchor').getAttribute('cx'));
    await event('touchEnd');
    await begin([0, .5], [.28, .503]);
    await expect(page.locator('.perpendicular-marker')).toBeVisible();
    expect(Number(await page.locator('.drag-destination').getAttribute('cx'))).toBeCloseTo(2 * pinX, 12);
    await event('touchEnd');
    const moved = await downloadJSON(page, 'Export experiment');
    const {intent, packet} = moved.attempts.at(-1).move;
    expect(intent).toMatchObject({kind: 'perpendicular-point', source: {facetId: upper.id}, moving: {x: 0, y: .5}});
    expect(packet.facetIds).toEqual([upper.id]);
    expect(moved.final.facets.find(({id}) => id === lower.id).transform).toEqual(lower.transform);
    expect(moved.final.facets.at(-1).z).toBeGreaterThan(lower.z);
  });

  test('touch flips a marked sheet and uses the mirrored point for snapping and pinning', async ({page, context}) => {
    const session = await context.newCDPSession(page);
    const event = (type, point) => session.send('Input.dispatchTouchEvent', {type, touchPoints: point ? [point] : []});
    const unfold = page.getByRole('button', {name: 'Unfold', exact: true});
    const flip = page.getByRole('button', {name: 'Flip over', exact: true});
    const dot = page.locator('#paper-marks .material-mark');
    const fold = async (from, to, snapped) => {
      await page.locator('#paper').scrollIntoViewIfNeeded();
      await event('touchStart', await screenPoint(page, ...from));
      await event('touchMove', await screenPoint(page, ...to));
      await expect(page.locator('#gesture-status')).toHaveText('accepted');
      if (snapped) {
        await expect(page.locator('.drag-destination')).toHaveAttribute('cx', String(snapped[0]));
        await expect(page.locator('.drag-destination')).toHaveAttribute('cy', String(snapped[1]));
      }
      await event('touchEnd');
    };
    await fold([0, 0], [.64, 0]);
    await unfold.tap();
    await fold([0, 1], [0, 0]);
    await unfold.tap();
    const scored = await downloadJSON(page, 'Export experiment');
    const x = scored.final.creases[0].a.x;
    await page.locator('#paper').scrollIntoViewIfNeeded();
    const crossing = await screenPoint(page, x, .5);
    await page.touchscreen.tap(crossing.x + 5, crossing.y + 4);
    await page.getByRole('button', {name: 'Mark point', exact: true}).tap();
    const marked = await downloadJSON(page, 'Export experiment');
    const {point} = marked.final.marks[0];
    await flip.tap();
    await expect(flip).toHaveAttribute('aria-pressed', 'true');
    const exposedX = 1 - point.x;
    await expect(dot).toHaveAttribute('cx', String(exposedX));
    await fold([1, 1], [exposedX + .016, point.y + .024], [exposedX, point.y]);
    expect((await downloadJSON(page, 'Export experiment')).final.marks).toEqual(marked.final.marks);
    await unfold.tap();

    await page.locator('#paper').scrollIntoViewIfNeeded();
    const pin = await screenPoint(page, exposedX, point.y);
    await event('touchStart', {x: pin.x + 10, y: pin.y + 9});
    await expect(page.locator('.pin-anchor')).toHaveAttribute('cx', String(exposedX));
    await event('touchEnd');
    const landingX = exposedX - Math.hypot(1 - exposedX, point.y);
    await event('touchStart', await screenPoint(page, 1, 0));
    await event('touchMove', await screenPoint(page, landingX + .012, point.y));
    await expect(page.locator('#gesture-status')).toHaveText('accepted');
    expect(Number(await page.locator('.drag-destination').getAttribute('cx'))).toBeCloseTo(landingX, 12);
    await event('touchEnd');
    const result = await downloadJSON(page, 'Export experiment');
    expect(result.attempts.at(-1).move.label).toBe('Point onto line');
    expect(result.final.marks).toEqual(marked.final.marks);
    await unfold.tap();
    await flip.tap();
    await expect(dot).toHaveAttribute('cx', String(point.x));
  });

  test('touch aligns opposite parallel edges at the exact halfway line', async ({page, context}) => {
    const session = await context.newCDPSession(page);
    const event = (type, point) => session.send('Input.dispatchTouchEvent', {type, touchPoints: point ? [point] : []});
    await event('touchStart', await screenPoint(page, 0, .37));
    await event('touchMove', await screenPoint(page, .988, .38));
    await expect(page.locator('.constraint-source')).toHaveCount(1);
    await expect(page.locator('#gesture-status')).toHaveText('accepted');
    await event('touchEnd');
    const file = await downloadJSON(page, 'Export experiment');
    expect(file.attempts[0].move.intent.kind).toBe('align-lines');
    expect(file.attempts[0].move.line.map(([x]) => x)).toEqual([.5, .5]);
    expect(file.final.facets.at(-1).transform).toMatchObject({a: -1, d: 1, e: 1});
  });

  test('touch pins a marked intersection and folds a retained diagonal back through it', async ({page, context}, testInfo) => {
    const session = await context.newCDPSession(page);
    const event = (type, point) => session.send('Input.dispatchTouchEvent', {type, touchPoints: point ? [point] : []});
    const unfold = page.getByRole('button', {name: 'Unfold', exact: true});
    const fold = async (from, to) => {
      await page.locator('#paper').scrollIntoViewIfNeeded();
      await event('touchStart', await screenPoint(page, ...from));
      await event('touchMove', await screenPoint(page, ...to));
      await expect(page.locator('#gesture-status')).toHaveText('accepted');
      await event('touchEnd');
    };
    await fold([0, 0], [.64, 0]);
    await unfold.tap();
    await fold([1, 0], [0, 1]);
    await unfold.tap();
    const before = await downloadJSON(page, 'Export experiment');
    const x = before.final.creases[0].a.x;
    expect(x).toBeCloseTo(.32, 2);
    await page.locator('#paper').scrollIntoViewIfNeeded();
    const near = await screenPoint(page, x, x);
    await page.touchscreen.tap(near.x + 5, near.y - 5);
    await page.getByRole('button', {name: 'Mark point', exact: true}).tap();
    const marked = await downloadJSON(page, 'Export experiment');
    const {point} = marked.final.marks[0];
    expect(point.x).toBeCloseTo(x, 12);
    expect(point.y).toBeCloseTo(x, 12);
    await page.locator('#paper').scrollIntoViewIfNeeded();
    const pin = await screenPoint(page, point.x, point.y);
    await event('touchStart', {x: pin.x + 14, y: pin.y + 13});
    await expect(page.locator('.pin-anchor')).toHaveAttribute('cx', String(point.x));
    await expect(page.locator('.pin-anchor')).toHaveAttribute('cy', String(point.y));
    await event('touchEnd');
    await event('touchStart', await screenPoint(page, .15, .15));
    await event('touchMove', await screenPoint(page, 2 * x - .15, 2 * x - .15));
    await expect(page.locator('#gesture-status')).toHaveText('accepted');
    await captureStage(page, testInfo, 'o4-marked-pin.png');
    await event('touchEnd');
    const file = await downloadJSON(page, 'Export experiment');
    const {intent, line: [a, b]} = file.attempts.at(-1).move;
    expect(intent.kind).toBe('perpendicular');
    expect(intent.pin).toEqual(point);
    expect(a).toEqual([point.x, point.y]);
    expect(b[0] - a[0] + b[1] - a[1]).toBeCloseTo(0, 12);
    await unfold.tap();
    const flat = await downloadJSON(page, 'Export experiment');
    expect(flat.final.facets).toEqual(flat.initial.facets);
    expect(flat.final.marks).toEqual(marked.final.marks);
    expect(flat.final.creases).toEqual(file.final.creases);
  });

  test('touch marks a genuine crease-edge intersection on the chosen overlapping layer', async ({page, context}) => {
    const session = await context.newCDPSession(page);
    const touch = (type, point) => session.send('Input.dispatchTouchEvent', {
      type, touchPoints: point ? [point] : [],
    });
    const fold = async (from, to) => {
      await touch('touchStart', await screenPoint(page, ...from));
      await touch('touchMove', await screenPoint(page, ...to));
      await expect(page.locator('#gesture-status')).toHaveText('accepted');
      await touch('touchEnd');
    };
    const unfold = page.getByRole('button', {name: 'Unfold', exact: true});
    const mark = page.getByRole('button', {name: 'Mark point', exact: true});
    const dots = page.locator('#paper-marks .material-mark');
    await fold([0, 1], [0, 0]);
    await unfold.tap();
    await page.locator('#paper').scrollIntoViewIfNeeded();
    await fold([1, 0], [0, 0]);
    const tapEdge = async () => {
      await page.locator('#paper').scrollIntoViewIfNeeded();
      const p = await screenPoint(page, 0, .5);
      await page.touchscreen.tap(p.x + 7, p.y + 3);
    };
    await tapEdge();
    const layer = page.getByRole('combobox', {name: 'Intersection layer'});
    await expect(layer.locator('option')).toHaveText([
      'Layer 2 · sheet (1.000, 0.500)', 'Layer 1 · sheet (0.000, 0.500)',
    ]);
    await layer.selectOption('1');
    await mark.tap();
    await expect(dots).toHaveCount(0);
    await tapEdge();
    await expect(layer).toHaveValue('0');
    await mark.tap();
    await expect(dots).toHaveCount(1);
    await expect(dots).toHaveAttribute('cx', '0');
    await unfold.tap();
    await expect(dots).toHaveCount(2);
    const file = await downloadJSON(page, 'Export experiment');
    expect(file.final.marks).toEqual([{id: 4, point: {x: 0, y: .5}}, {id: 5, point: {x: 1, y: .5}}]);
    const positions = await dots.evaluateAll(nodes => nodes.map(node => [node.getAttribute('cx'), node.getAttribute('cy')]));
    expect(positions).toEqual([['0', '0.5'], ['1', '0.5']]);
  });

  test('touch drag snaps the crease and commits the exact reflected landing', async ({page, context}) => {
    const session = await context.newCDPSession(page);
    const touch = (type, point) => session.send('Input.dispatchTouchEvent', {
      type, touchPoints: point ? [point] : [],
    });
    await touch('touchStart', await screenPoint(page, 0, 1));
    await touch('touchMove', await screenPoint(page, .425, .215));
    await expectTwoPointPreview(page);
    await touch('touchEnd');
    const experiment = await downloadJSON(page, 'Export experiment');
    const {move, validation} = experiment.attempts[0];
    expect([...move.line].sort()).toEqual([[0, .5], [1, 1]]);
    expect(validation.status).toBe('accepted');
    const {c, d, e, f} = experiment.final.facets.at(-1).transform;
    expect(c + e).toBeCloseTo(.4, 12);
    expect(d + f).toBeCloseTo(.2, 12);
  });

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
