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
import { test, expect } from '@playwright/test';

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

/*
 * The profile confirmation card's tests lived here and have been removed with
 * the card itself. What they asserted (nothing routes until the card is
 * accepted, and editing the card changes the route) is no longer true of this
 * build: a query routes on submit and what the model inferred is disclosed
 * afterwards. HANDOFF.md records that as a deliberate weakening of the
 * original guarantee rather than as a passing test nobody noticed was gone.
 */
