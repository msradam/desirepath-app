/**
 * Stage 1 extraction against the real model.
 *
 * The claim under test is that schema validity is 100 percent by construction.
 * The unit tests prove the grammar admits exactly the condition map's
 * vocabulary and that every fixture is schema-valid; only this file can prove
 * the third part, that a real quantised 1B model decoding under that grammar
 * produces output inside it.
 *
 * It also measures the multilingual gap, and the measurement is the point. The
 * highest Heat Vulnerability Index neighbourhoods in New York are where
 * Bengali, Haitian Creole and Spanish are household languages, and a 1B
 * quantised model is weak outside English. The table this prints goes into
 * HANDOFF.md whatever it says. Fixtures are not tuned to improve it.
 *
 * Note what "validity" and "accuracy" mean here, because they are different
 * numbers and conflating them would be the easiest way to overclaim:
 *
 *   validity  the output parsed and satisfied the schema. The grammar should
 *             make this 100 percent regardless of language, because it is a
 *             property of the decoder, not of the model's understanding.
 *   accuracy  the output matched the expected profile. This is where a weak
 *             language shows up, and where it should.
 */
import { test, expect, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

type Case = {
  name: string;
  query: string;
  lang: string;
  /** The router tool this query should dispatch to. Derived, never decoded. */
  tool: string;
  adversarial?: boolean;
  note?: string;
  loose?: string[];
  expect: Record<string, unknown>;
};

/**
 * Repetitions per fixture. One by default.
 *
 * Decoding is at temperature 0, so repetitions only ever measured the decoder's
 * transient refusal rate, which the counted retry in extraction.ts now covers.
 * Dispatch correctness, which used to need the model, is deterministic given
 * the slots and is asserted without inference in tests/unit/extraction.test.ts.
 * Raise this with EXTRACTION_REPS if the refusal rate is what you are after.
 */
const REPS = Number(process.env.EXTRACTION_REPS ?? 1);

const golden = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'app/tests/extraction-golden.json'), 'utf8'),
) as { cases: Case[] };

async function bootApp(page: Page) {
  page.on('console', (m) => {
    if (m.type() === 'error') console.log(`    [page error] ${m.text()}`);
  });
  await page.goto('/');

  // Poll rather than waitForFunction. The app writes the map position into
  // the URL hash as it boots, and a navigation destroys the evaluation
  // context mid-wait, which surfaces as a failure at about thirty seconds
  // rather than as the timeout it looks like.
  const deadline = Date.now() + 15 * 60_000;
  let lastMessage = '(nothing yet)';
  while (Date.now() < deadline) {
    try {
      const state = await page.evaluate(() => ({
        ready: Boolean((window as unknown as { __ariadneExtract?: unknown }).__ariadneExtract),
        message:
          document.querySelector('.loading-overlay')?.textContent?.replace(/\s+/g, ' ').trim() ??
          document.body.innerText.match(/Model unavailable[\s\S]{0,140}/)?.[0] ??
          '(booting)',
      }));
      if (state.ready) return;
      lastMessage = state.message;
    } catch {
      // Context destroyed by the hash navigation. Try again.
    }
    await page.waitForTimeout(2000);
  }
  throw new Error(`model never became ready. Last boot message: ${lastMessage}`);
}

/**
 * Run one extraction inside the page, through the same service the app uses.
 *
 * Deliberately not driven through the search bar: this measures stage 1 only,
 * and routing a query would add geocoder failures to the score for reasons
 * that have nothing to do with extraction.
 */
async function extractInPage(page: Page, query: string) {
  return page.evaluate(async (q) => {
    const w = window as unknown as { __ariadneExtract?: (s: string) => Promise<unknown> };
    if (!w.__ariadneExtract) throw new Error('extraction harness not exposed on window');
    return w.__ariadneExtract(q);
  }, query);
}

type Outcome = {
  case: Case;
  valid: boolean;
  accurate: boolean;
  constrained: boolean;
  /** Whether the derived dispatch matched the fixture's expected tool. */
  dispatchRight: boolean;
  wrongFields: string[];
  error?: string;
  ms: number;
};

/**
 * The dispatch rule under test, copied rather than imported.
 *
 * The spec runs in node against a page bundle; importing $lib here would pull
 * SvelteKit aliases into the Playwright process. The unit tests assert this
 * matches lib/domain/dispatch.ts against every fixture, so a divergence is
 * caught there rather than silently scoring the wrong function here.
 */
function dispatchFor(p: Record<string, unknown>): string {
  if (typeof p.destination === 'string' && p.destination.trim() !== '') return 'plan_route';
  return p.max_minutes === null || p.max_minutes === undefined
    ? 'find_comfort_and_route'
    : 'find_reachable_resources';
}

function compare(c: Case, got: Record<string, unknown>): string[] {
  const loose = new Set(c.loose ?? []);
  const wrong: string[] = [];
  for (const [field, want] of Object.entries(c.expect)) {
    if (loose.has(field)) continue;
    const mine = got[field];
    const same = Array.isArray(want)
      ? Array.isArray(mine) &&
        want.length === mine.length &&
        [...want].sort().every((v, i) => v === [...(mine as unknown[])].sort()[i])
      : mine === want;
    if (!same) wrong.push(`${field}: got ${JSON.stringify(mine)}, want ${JSON.stringify(want)}`);
  }
  return wrong;
}

test.describe('stage 1 extraction, real model', () => {
  test('golden battery, with the multilingual gap measured', async ({ page }) => {
    test.setTimeout(20 * 60_000);
    await bootApp(page);

    const results: Outcome[] = [];

    for (let rep = 0; rep < REPS; rep++) {
      for (const c of golden.cases) {
        const t0 = Date.now();
        try {
          const raw = (await extractInPage(page, c.query)) as {
            profile: Record<string, unknown>;
            constrained: boolean;
          };
          const wrong = compare(c, raw.profile);
          results.push({
            case: c,
            valid: true,
            accurate: wrong.length === 0,
            constrained: raw.constrained,
            dispatchRight: dispatchFor(raw.profile) === c.tool,
            wrongFields: wrong,
            ms: Date.now() - t0,
          });
        } catch (e) {
          results.push({
            case: c,
            valid: false,
            accurate: false,
            constrained: false,
            dispatchRight: false,
            wrongFields: [],
            error: (e as Error).message,
            ms: Date.now() - t0,
          });
        }
      }
    }

    // ── the table ───────────────────────────────────────────────────────────
    const pad = (s: string, n: number) => s.slice(0, n).padEnd(n);
    console.log(`\n  EXTRACTION, ${golden.cases.length} fixtures x ${REPS} reps = ${results.length} runs`);
    console.log(`  ${pad('case', 52)} ${pad('lang', 5)} valid  exact  disp    ms`);
    for (const r of results) {
      console.log(
        `  ${pad(r.case.name, 52)} ${pad(r.case.lang, 5)} ` +
          `${r.valid ? '  ok ' : ' FAIL'}  ${r.accurate ? ' ok ' : 'miss'}  ` +
          `${r.dispatchRight ? ' ok ' : 'MISS'}  ${String(r.ms).padStart(5)}`,
      );
      for (const w of r.wrongFields) console.log(`      ${w}`);
      if (r.error) console.log(`      error: ${r.error}`);
    }

    // ── field-level misses ──────────────────────────────────────────────────
    // The number HANDOFF.md carries. Counted over runs, not over fixtures, so
    // a fixture that is wrong every time counts every time.
    const fields = ['origin', 'destination', 'resource_types', 'conditions',
                    'max_minutes', 'for_someone_else'];
    console.log('\n  FIELD-LEVEL MISSES, over all runs');
    for (const f of fields) {
      const scored = results.filter((r) => r.valid && f in r.case.expect && !(r.case.loose ?? []).includes(f));
      const miss = scored.filter((r) => r.wrongFields.some((w) => w.startsWith(`${f}:`))).length;
      if (!scored.length) continue;
      console.log(
        `  ${pad(f, 20)} ${String(miss).padStart(3)} of ${String(scored.length).padStart(3)}` +
          ` (${((100 * miss) / scored.length).toFixed(0).padStart(3)}%)`,
      );
    }

    // ── the dispatch ────────────────────────────────────────────────────────
    // This replaces the intent accuracy the model used to be scored on. The
    // field is gone from the schema; the tool is derived from destination and
    // max_minutes, so this measures whether those two slots were right.
    const scoredDispatch = results.filter((r) => r.valid);
    const rightDispatch = scoredDispatch.filter((r) => r.dispatchRight).length;
    const byTool = new Map<string, number>();
    for (const c of golden.cases) byTool.set(c.tool, (byTool.get(c.tool) ?? 0) + 1);
    const majority = Math.max(...byTool.values()) / golden.cases.length;
    console.log('\n  DISPATCH');
    console.log(
      `  correct in ${rightDispatch} of ${scoredDispatch.length} runs ` +
        `(${((100 * rightDispatch) / scoredDispatch.length).toFixed(1)}%)`,
    );
    console.log(`  majority-class baseline would score ${(100 * majority).toFixed(1)}%`);
    for (const [tool, n] of [...byTool].sort()) console.log(`    ${pad(tool, 26)} ${n} fixtures`);

    const exactFixtures = golden.cases.filter((c) =>
      results.filter((r) => r.case === c).every((r) => r.accurate),
    );
    console.log(`\n  exactly right on every rep: ${exactFixtures.length} of ${golden.cases.length} fixtures`);

    const byLang = new Map<string, Outcome[]>();
    for (const r of results) {
      byLang.set(r.case.lang, [...(byLang.get(r.case.lang) ?? []), r]);
    }
    console.log('\n  MULTILINGUAL GAP');
    console.log('  lang   cases   schema-valid   exactly right');
    for (const [lang, rs] of [...byLang].sort()) {
      const v = rs.filter((r) => r.valid).length;
      const a = rs.filter((r) => r.accurate).length;
      console.log(
        `  ${pad(lang, 6)} ${String(rs.length).padStart(5)}   ` +
          `${String(v).padStart(5)} (${((100 * v) / rs.length).toFixed(0).padStart(3)}%)   ` +
          `${String(a).padStart(5)} (${((100 * a) / rs.length).toFixed(0).padStart(3)}%)`,
      );
    }

    const adversarial = results.filter((r) => r.case.adversarial);
    console.log(
      `\n  adversarial: ${adversarial.filter((r) => r.accurate).length}/${adversarial.length} exactly right`,
    );
    console.log('  Validity is a property of the grammar. Accuracy is a property of the model.\n');

    // ── the assertions ──────────────────────────────────────────────────────
    // Only validity is asserted. Accuracy is measured and reported, because
    // asserting it would create pressure to tune the fixtures, and the whole
    // reason the weak-language cases exist is to be reported honestly.
    const invalid = results.filter((r) => !r.valid);
    expect(
      invalid.map((r) => `${r.case.name}: ${r.error}`),
      'grammar-constrained decoding must be 100 percent schema-valid',
    ).toEqual([]);

    expect(
      results.every((r) => r.constrained),
      'every extraction must report a constrained decode',
    ).toBe(true);
  });
});
