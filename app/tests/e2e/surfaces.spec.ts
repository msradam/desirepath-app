/**
 * The two new surfaces, end to end in a real browser.
 *
 * The comparison view needs no model, so it runs fast and is asserted hard.
 * The profile card needs stage 1, so it pays the model load once.
 *
 * The load-bearing test here is the last one. The brief's alpha criterion is
 * that the card is editable AND that editing it changes the route, because a
 * card that displays a profile without being able to correct it is decoration.
 * That test adds a condition the user never stated, accepts, and asserts the
 * route actually came out different.
 */
import { test, expect, type Page } from '@playwright/test';

const NEIGHBOURHOODS = [
  { code: 'BK1602', name: 'Brownsville', elements: 2 },
  { code: 'BX0101', name: 'Mott Haven', elements: 9 },
  { code: 'BX0602', name: 'Tremont', elements: 8 },
  { code: 'MN1102', name: 'East Harlem', elements: 18 },
];

test.describe('reachability comparison view', () => {
  for (const n of NEIGHBOURHOODS) {
    test(`${n.name} renders the three shares and a gap`, async ({ page }) => {
      await page.goto(`/coverage?nta=${n.code}`);
      const readout = page.locator('.readout');
      await expect(readout).toBeVisible({ timeout: 30_000 });

      // The claim, attributed. If the quote or its source ever goes missing
      // the view is asserting something without saying who said it.
      await expect(readout).toContainText('1/4 mile away from an outdoor cooling element');
      await expect(readout).toContainText('NYC DEP');

      // All three readings present, and ordered worst-last.
      const shares = readout.locator('.shares li');
      await expect(shares).toHaveCount(3);
      await expect(shares.nth(0)).toContainText('as the crow flies');
      await expect(shares.nth(1)).toContainText('walking the network');
      await expect(shares.nth(2)).toContainText('walking it in the heat');

      const pct = async (i: number) =>
        parseFloat((await shares.nth(i).locator('.share-pct').innerText()).replace('%', ''));

      const crow = await pct(0);
      const walk = await pct(1);
      const heat = await pct(2);

      // The whole argument, as an ordering. A straight line can only ever
      // overstate what a network delivers, and heat can only ever take away.
      expect(crow, 'the radius cannot claim less than walking delivers').toBeGreaterThanOrEqual(walk);
      expect(walk, 'heat cannot make more of the network reachable').toBeGreaterThanOrEqual(heat);

      // And the gap must be the difference, not a separately computed number.
      const gap = parseFloat(await readout.locator('.figure-num').innerText());
      expect(gap).toBeCloseTo(crow - heat, 1);

      await expect(readout).toContainText(`${n.elements} cooling element`);

      // The honesty line is not optional and is not behind a control.
      await expect(readout).toContainText('proxy, not SOLWEIG');
      await expect(readout).toContainText('hydrant spray caps');
    });
  }

  test('North Corona reports having no cooling element at all', async ({ page }) => {
    // The most damning row in the dataset. It must read as a finding, not as
    // a failure to load.
    await page.goto('/coverage?nta=QN0303');
    const panel = page.locator('.panel');
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await expect(panel).toContainText('no spray showers and no misting stations');
    await expect(panel).toContainText('nothing here to be a quarter mile away from');
    await expect(panel).toContainText('NYC DEP');
    // Not an error state.
    await expect(panel).not.toContainText('did not load');
  });

  test('a neighbourhood with no coverage file names the recovery', async ({ page }) => {
    await page.goto('/coverage?nta=BK9999');
    const panel = page.locator('.panel');
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await expect(panel).toContainText('BK9999');
    await expect(panel).toContainText('Build coverage');
  });

  test('survives a phone viewport without horizontal scroll', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/coverage?nta=BK1602');
    await expect(page.locator('.readout')).toBeVisible({ timeout: 30_000 });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, 'no horizontal page scroll at 390 wide').toBeLessThanOrEqual(1);
  });
});

// ── the profile confirmation card ────────────────────────────────────────────

async function bootApp(page: Page) {
  await page.goto('/');
  await page.waitForFunction(
    () => {
      const input = document.querySelector<HTMLInputElement>('.search-input');
      return !!input && !input.disabled;
    },
    { timeout: 180_000 },
  );
}

async function submit(page: Page, query: string) {
  const input = page.locator('.search-input');
  await input.fill(query);
  await input.press('Enter');
}

/** The route strip only appears once stage 2 has produced a route. */
async function routeSummary(page: Page): Promise<string> {
  const strip = page.locator('.route-strip');
  await expect(strip).toBeVisible({ timeout: 120_000 });
  return strip.innerText();
}

test.describe('profile confirmation card', () => {
  test.describe.configure({ mode: 'serial' });

  test('nothing routes until the card is accepted', async ({ page }) => {
    test.setTimeout(6 * 60_000);
    await bootApp(page);
    await submit(page, 'Penn Station to Grand Central');

    const card = page.locator('.card');
    await expect(card).toBeVisible({ timeout: 120_000 });
    await expect(card).toContainText('Check this before anything routes');

    // The map must still be empty: stage 2 has not run.
    await expect(page.locator('.route-strip')).toHaveCount(0);

    // Every field the grammar can emit has a control, and so does the
    // dispatch, which the grammar no longer emits but the user can still fix.
    await expect(card.locator('input[type="radio"][name$="-tool"]')).toHaveCount(3);
    await expect(card).toContainText('Chosen from what you filled in below, not by the model');
    await expect(card.locator('#\\3'.length ? 'input[type="text"]' : 'input')).not.toHaveCount(0);
    await expect(card.locator('.consequence')).toBeVisible();

    // Provenance is stated: a model filled this in, and a file decides what it means.
    await expect(card).toContainText('condition-map.yaml');
  });

  test('accepting routes, and the condition map decides the profile', async ({ page }) => {
    test.setTimeout(6 * 60_000);
    await bootApp(page);
    await submit(page, 'Penn Station to Grand Central');

    const card = page.locator('.card');
    await expect(card).toBeVisible({ timeout: 120_000 });
    // With no condition stated, the thermal layer must be off.
    await expect(card.locator('.consequence')).toContainText('thermal layer is off');

    await card.locator('button.accept').click();
    const summary = await routeSummary(page);
    expect(summary.length).toBeGreaterThan(0);
  });

  test('editing the card changes the route', async ({ page }) => {
    // The alpha criterion. A card that cannot change the outcome is decoration.
    test.setTimeout(10 * 60_000);
    await bootApp(page);

    // A query with no health information at all.
    await submit(page, 'Rockaway Avenue to Betsy Head Park');
    const card = page.locator('.card');
    await expect(card).toBeVisible({ timeout: 120_000 });
    await expect(card.locator('.consequence')).toContainText('thermal layer is off');
    await card.locator('button.accept').click();
    const plain = await routeSummary(page);

    // Same query, but the user corrects the form to say they cannot sweat,
    // which config/condition-map.yaml maps to the strongest coefficient in
    // the file. Nothing about the sentence changed; only the card did.
    await submit(page, 'Rockaway Avenue to Betsy Head Park');
    await expect(card).toBeVisible({ timeout: 120_000 });

    const sweating = card.locator('label', { hasText: 'Reduced ability to sweat' }).locator('input');
    await sweating.check();

    // The consequence panel must react before anything routes.
    await expect(card.locator('.consequence')).not.toContainText('thermal layer is off');
    await expect(card.locator('.consequence')).toContainText('1.84');

    await card.locator('button.accept').click();
    const heatAware = await routeSummary(page);

    expect(
      heatAware,
      'a condition added on the card must change the route it produces',
    ).not.toEqual(plain);
  });

  test('an unresolved origin blocks accept and says why', async ({ page }) => {
    test.setTimeout(6 * 60_000);
    await bootApp(page);
    // No origin given, so stage 1 emits the @me sentinel.
    await submit(page, 'find me a cooling center');

    const card = page.locator('.card');
    await expect(card).toBeVisible({ timeout: 120_000 });
    await expect(card.locator('button.accept')).toBeDisabled();
    // The reason must be readable, not only encoded in a disabled attribute.
    await expect(card).toContainText(/starting point|where you are/i);
    // And @me must never be shown back to the user as though it were a place.
    await expect(card.locator('input[type="text"]').first()).not.toHaveValue('@me');
  });
});
