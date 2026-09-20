/**
 * extract-cli. Stage 1 against Ollama, with no browser in the way.
 *
 * This used to be a Playwright spec, because the model lived in the page and
 * there was nowhere else to run it. Each run paid a 20 to 29 second cold model
 * load, plus Chromium, plus a GPU that only one process can hold. Extraction
 * is now an HTTP call to localhost, so the whole battery runs from node.
 *
 * What it measures, and the distinction matters:
 *
 *   validity   the output parsed and satisfied the schema. A property of the
 *              decoder, not of the model. Ollama compiles the schema to GBNF
 *              and masks the sampler with it, so this should be 100 percent.
 *   slots      whether each field matched the fixture. A property of the
 *              model, and where a weak language shows up.
 *   dispatch   whether the derived router tool was right. No model involved
 *              once the slots exist; tests/unit/extraction.test.ts asserts the
 *              mapping reproduces all 17 fixtures with no inference at all.
 *
 * Usage:
 *   npm run extract                 the 17 fixtures, once each
 *   npm run extract -- --reps 3     repeat, for the refusal rate
 *   npm run extract -- "some query" one sentence, printed as JSON
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { OllamaAdapter, OLLAMA_MODEL } from '../src/lib/adapters/llm-ollama.ts';
import { ExtractionService, decoderStats } from '../src/lib/services/extraction.ts';
import { dispatchFor } from '../src/lib/domain/dispatch.ts';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

type Case = {
  name: string;
  query: string;
  lang: string;
  tool: string;
  adversarial?: boolean;
  note?: string;
  loose?: string[];
  expect: Record<string, unknown>;
};

const golden = JSON.parse(
  fs.readFileSync(path.join(REPO, 'app/tests/extraction-golden.json'), 'utf8'),
) as { cases: Case[] };

const FIELDS = ['origin', 'destination', 'resource_types', 'conditions',
                'max_minutes', 'for_someone_else'];

function wrongFields(c: Case, got: Record<string, unknown>): string[] {
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

const pad = (s: string, n: number) => s.slice(0, n).padEnd(n);

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const consumed = new Set<number>();
  for (const [i, a] of argv.entries()) {
    if (a.startsWith('--')) { consumed.add(i); consumed.add(i + 1); }
  }
  const reps = Number(flag('reps') ?? 1);
  const model = flag('model') ?? OLLAMA_MODEL;
  const oneOff = argv.find((_, i) => !consumed.has(i));

  const llm = new OllamaAdapter(undefined, model);
  const probe = await llm.probeWebGPU();
  if (!probe.ok) {
    console.error(`  ${probe.info}`);
    console.error('  Start it with `ollama serve`. Nothing here downloads weights.');
    process.exit(1);
  }
  const t_load = Date.now();
  await llm.load(() => {});
  const loadMs = Date.now() - t_load;
  const svc = new ExtractionService(llm);

  if (oneOff) {
    const r = await svc.extract(oneOff);
    console.log(JSON.stringify({ ...r, tool: dispatchFor(r.profile) }, null, 2));
    return;
  }

  console.log(`\n  ${model} via Ollama, resident in ${loadMs} ms`);
  console.log(`  ${golden.cases.length} fixtures x ${reps} rep${reps === 1 ? '' : 's'}\n`);
  console.log(`  ${pad('case', 52)} ${pad('lang', 5)} valid  slots  disp     ms`);

  type Row = { c: Case; valid: boolean; wrong: string[]; dispatch: boolean; ms: number; err?: string };
  const rows: Row[] = [];

  for (let rep = 0; rep < reps; rep++) {
    for (const c of golden.cases) {
      const t0 = Date.now();
      let row: Row;
      try {
        const r = await svc.extract(c.query);
        const wrong = wrongFields(c, r.profile as unknown as Record<string, unknown>);
        row = {
          c, valid: true, wrong,
          dispatch: dispatchFor(r.profile) === c.tool,
          ms: Date.now() - t0,
        };
      } catch (e) {
        row = { c, valid: false, wrong: [], dispatch: false, ms: Date.now() - t0, err: (e as Error).message };
      }
      rows.push(row);
      console.log(
        `  ${pad(row.c.name, 52)} ${pad(row.c.lang, 5)} ` +
          `${row.valid ? '  ok ' : ' FAIL'}  ${row.wrong.length === 0 ? ' ok ' : 'miss'}  ` +
          `${row.dispatch ? ' ok ' : 'MISS'}  ${String(row.ms).padStart(5)}`,
      );
      for (const w of row.wrong) console.log(`      ${w}`);
      if (row.err) console.log(`      error: ${row.err}`);
    }
  }

  const valid = rows.filter((r) => r.valid);
  console.log('\n  FIELD-LEVEL MISSES, over all runs');
  for (const f of FIELDS) {
    const scored = valid.filter((r) => f in r.c.expect && !(r.c.loose ?? []).includes(f));
    if (!scored.length) continue;
    const miss = scored.filter((r) => r.wrong.some((w) => w.startsWith(`${f}:`))).length;
    console.log(
      `  ${pad(f, 20)} ${String(miss).padStart(3)} of ${String(scored.length).padStart(3)}` +
        ` (${((100 * miss) / scored.length).toFixed(0).padStart(3)}%)`,
    );
  }

  const byTool = new Map<string, number>();
  for (const c of golden.cases) byTool.set(c.tool, (byTool.get(c.tool) ?? 0) + 1);
  const majority = Math.max(...byTool.values()) / golden.cases.length;
  const right = valid.filter((r) => r.dispatch).length;
  console.log('\n  DISPATCH, derived from the slots rather than decoded');
  console.log(`  correct in ${right} of ${valid.length} runs (${((100 * right) / valid.length).toFixed(1)}%)`);
  console.log(`  majority-class baseline would score ${(100 * majority).toFixed(1)}%`);

  const exact = golden.cases.filter((c) =>
    rows.filter((r) => r.c === c).every((r) => r.valid && r.wrong.length === 0),
  );
  console.log(`\n  exactly right on every rep: ${exact.length} of ${golden.cases.length} fixtures`);

  const byLang = new Map<string, Row[]>();
  for (const r of rows) byLang.set(r.c.lang, [...(byLang.get(r.c.lang) ?? []), r]);
  console.log('\n  MULTILINGUAL GAP');
  console.log('  lang   runs   schema-valid   slots exactly right');
  for (const [lang, rs] of [...byLang].sort()) {
    const v = rs.filter((r) => r.valid).length;
    const a = rs.filter((r) => r.valid && r.wrong.length === 0).length;
    console.log(
      `  ${pad(lang, 6)} ${String(rs.length).padStart(4)}   ` +
        `${String(v).padStart(5)} (${((100 * v) / rs.length).toFixed(0).padStart(3)}%)   ` +
        `${String(a).padStart(5)} (${((100 * a) / rs.length).toFixed(0).padStart(3)}%)`,
    );
  }

  const times = rows.map((r) => r.ms).sort((a, b) => a - b);
  const pct = (p: number) => times[Math.min(times.length - 1, Math.floor(p * times.length))];
  console.log(
    `\n  TIMING  median ${pct(0.5)} ms, p95 ${pct(0.95)} ms, ` +
      `whole battery ${(times.reduce((a, b) => a + b, 0) / 1000).toFixed(1)} s`,
  );
  console.log(
    `  DECODER  ${decoderStats.attempts} attempts, ${decoderStats.retries} retries, ` +
      `${decoderStats.refusalsAfterRetry} refusals after retry`,
  );

  // Validity is the guarantee and is asserted. Slot accuracy is reported and
  // never asserted, because asserting it would create pressure to tune the
  // fixtures, and the weak-language cases exist to be reported honestly.
  const invalid = rows.filter((r) => !r.valid);
  if (invalid.length) {
    console.error(`\n  ${invalid.length} run(s) did not produce schema-valid output.`);
    process.exit(1);
  }
  console.log('\n  Validity is a property of the grammar. Accuracy is a property of the model.\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
