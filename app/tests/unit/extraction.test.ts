// Stage 1 extraction: the parts that can be proved without a GPU.
//
// The claim this project makes is that schema validity is 100 percent by
// construction, not by retry. That claim decomposes into three things, and two
// of them are decidable here:
//
//   1. The grammar admits exactly the vocabulary config/condition-map.yaml
//      defines, and nothing else.
//   2. Every golden fixture's expected output satisfies the schema the grammar
//      encodes, so the fixtures cannot be the reason a run passes.
//   3. The model, given the grammar, produces output inside it. That needs
//      WebGPU and the real weights, and lives in tests/e2e/extraction.spec.ts.
//
// Anything here failing means the guarantee is broken before a model is even
// loaded.

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';

import {
  CONDITION_LABELS,
  CONDITION_TERMS,
  PROFILE_GRAMMAR,
  validateProfile,
} from '../../src/lib/domain/profile-grammar';
import { CONDITION_DEFAULTS, CONDITION_EFFECTS, CONDITION_MAP_VERSION } from '../../src/lib/domain/condition-effects';
import { resolveEffects } from '../../src/lib/services/extraction';
import { TOOLS, TOOL_LABELS, dispatchFor } from '../../src/lib/domain/dispatch';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const conditionMap = yaml.load(
  fs.readFileSync(path.join(REPO_ROOT, 'config/condition-map.yaml'), 'utf8'),
) as {
  version: number;
  defaults: Record<string, unknown>;
  vocabulary: Record<string, { label: string; effects: Record<string, unknown> }>;
};

const golden = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'app/tests/extraction-golden.json'), 'utf8'),
) as { cases: Array<{ name: string; query: string; lang: string; tool: 'plan_route' | 'find_comfort_and_route' | 'find_reachable_resources'; adversarial?: boolean; note?: string; loose?: string[]; expect: Record<string, unknown> }> };

describe('the grammar is generated from the condition map', () => {
  it('is in step with config/condition-map.yaml', () => {
    // If this fails, someone edited the YAML without regenerating. The
    // recovery is `uv run python -m pipeline.thermal.grammar`.
    expect(CONDITION_MAP_VERSION).toBe(conditionMap.version);
    expect([...CONDITION_TERMS]).toEqual(Object.keys(conditionMap.vocabulary));
  });

  it('admits every vocabulary term', () => {
    for (const term of CONDITION_TERMS) {
      // The EBNF spells a literal as \"term\", so the escaped form is what
      // must be present; matching the bare word would pass on a comment.
      expect(PROFILE_GRAMMAR, `${term} is unreachable under the grammar`).toContain(`\\"${term}\\"`);
    }
  });

  it('admits nothing outside the vocabulary', () => {
    // A model cannot emit a condition the condition map does not define,
    // because no token sequence spelling one is reachable.
    for (const absent of ['diabetes', 'asthma_severe', 'covid', 'anxiety', 'obesity']) {
      expect(PROFILE_GRAMMAR, `${absent} should not be emittable`).not.toContain(`\\"${absent}\\"`);
    }
  });

  it('cannot emit an intent field, because dispatch is derived not decoded', () => {
    // The decoder generates keys in schema order, so an intent field would be
    // produced before the destination and time budget that are the only
    // evidence for it. lib/domain/dispatch.ts derives it afterwards instead.
    expect(PROFILE_GRAMMAR).not.toContain('intent');
    for (const value of ['plan_route', 'find_comfort', 'find_reachable']) {
      expect(PROFILE_GRAMMAR, `${value} should not be emittable`).not.toContain(value);
    }
  });

  it('constrains every field of the profile', () => {
    for (const field of ['origin', 'destination', 'resource_types',
                         'conditions', 'max_minutes', 'for_someone_else']) {
      expect(PROFILE_GRAMMAR).toContain(`\\"${field}\\"`);
    }
  });

  it('carries a label for every term, for the confirmation card', () => {
    for (const term of CONDITION_TERMS) {
      expect(CONDITION_LABELS[term], `${term} has no label`).toBeTruthy();
      expect(CONDITION_LABELS[term]).toBe(conditionMap.vocabulary[term].label);
    }
  });

  it('carries the effects of every term', () => {
    for (const term of CONDITION_TERMS) {
      expect(CONDITION_EFFECTS[term], `${term} has no effects`).toBeDefined();
    }
  });
});

describe('every golden fixture is schema-valid', () => {
  // If a fixture were invalid, a passing run would prove nothing.
  for (const c of golden.cases) {
    it(c.name, () => {
      const check = validateProfile(c.expect);
      expect(check.ok ? [] : check.errors).toEqual([]);
    });
  }

  it('covers both required languages and the adversarial cases the brief names', () => {
    const langs = new Set(golden.cases.map((c) => c.lang));
    expect(langs.has('en')).toBe(true);
    expect(langs.has('es')).toBe(true);

    const names = golden.cases.map((c) => c.name).join(' | ');
    expect(names).toContain('contradictory');
    expect(names).toContain('third party');
    expect(names).toContain('empty query');
    // A language the model is known to handle badly, present on purpose.
    expect(golden.cases.some((c) => !['en', 'es'].includes(c.lang))).toBe(true);
  });

  it('has adversarial cases, and they are marked', () => {
    const adversarial = golden.cases.filter((c) => c.adversarial);
    expect(adversarial.length).toBeGreaterThanOrEqual(6);
    for (const c of adversarial) {
      expect(c.note, `${c.name} should record why it exists`).toBeTruthy();
    }
  });
});

describe('validateProfile rejects what the grammar would have prevented', () => {
  const ok = {
    origin: 'Penn Station', destination: 'Grand Central',
    resource_types: [], conditions: [], max_minutes: null, for_someone_else: false,
  };

  it('accepts a well-formed profile', () => {
    expect(validateProfile(ok).ok).toBe(true);
  });

  it('rejects a condition outside the vocabulary', () => {
    const r = validateProfile({ ...ok, conditions: ['diabetes'] });
    expect(r.ok).toBe(false);
  });

  it('rejects a resource type outside the enum', () => {
    expect(validateProfile({ ...ok, resource_types: ['swimming_pool'] }).ok).toBe(false);
  });

  it('rejects a non-integer or non-positive time budget', () => {
    expect(validateProfile({ ...ok, max_minutes: 12.5 }).ok).toBe(false);
    expect(validateProfile({ ...ok, max_minutes: 0 }).ok).toBe(false);
    expect(validateProfile({ ...ok, max_minutes: -5 }).ok).toBe(false);
  });

  it('rejects a missing field rather than defaulting it', () => {
    // An omitted constraint and a constraint the user did not give must not
    // look the same.
    const { for_someone_else, ...missing } = ok;
    expect(validateProfile(missing).ok).toBe(false);
  });
});

describe('resolveEffects follows the condition map', () => {
  const resolve = (terms: string[]) =>
    resolveEffects(terms as never, CONDITION_EFFECTS, CONDITION_DEFAULTS);

  it('leaves the thermal layer off when nothing was stated', () => {
    const r = resolve([]);
    expect(r.heat_aware).toBe(false);
    expect(r.sun_inflation).toBe(0);
    expect(r.router_profile).toBe('generic_pedestrian');
  });

  it('turns the thermal layer on for any heat term', () => {
    expect(resolve(['heat_sensitivity_moderate']).heat_aware).toBe(true);
    expect(resolve(['heat_sensitivity_moderate']).sun_inflation).toBeCloseTo(0.16);
  });

  it('takes the most sensitive coefficient when terms combine', () => {
    // Sensitivity accumulates; it never cancels out.
    const r = resolve(['heat_sensitivity_moderate', 'impaired_sweating']);
    expect(r.sun_inflation).toBeCloseTo(0.84);
  });

  it('takes the tightest exposure cap when terms combine', () => {
    const r = resolve(['respiratory_limitation', 'heat_sensitivity_high']);
    expect(r.max_continuous_exposure_min).toBe(10);
  });

  it('never downgrades a stated wheelchair need', () => {
    expect(resolve(['mobility_wheelchair', 'mobility_slow']).router_profile).toBe('manual_wheelchair');
    expect(resolve(['mobility_slow', 'mobility_wheelchair']).router_profile).toBe('manual_wheelchair');
    expect(resolve(['low_vision', 'mobility_wheelchair']).router_profile).toBe('manual_wheelchair');
  });

  it('does not infer a health condition from a mobility aid', () => {
    // The condition map is explicit that wheelchair use alone implies nothing
    // about heat tolerance. If this ever fails, the router has started doing
    // medicine.
    const r = resolve(['mobility_wheelchair']);
    expect(r.heat_aware).toBe(false);
    expect(r.sun_inflation).toBe(0);
  });

  it('keeps every coefficient inside the range the literature observed', () => {
    // Melnikov et al. (2022) report individual beta to 1.84. A value above
    // that would be extrapolating past the data with no basis.
    for (const term of CONDITION_TERMS) {
      const r = resolve([term]);
      expect(r.sun_inflation, `${term}`).toBeGreaterThanOrEqual(0);
      expect(r.sun_inflation, `${term} exceeds the observed range`).toBeLessThanOrEqual(0.84);
    }
  });

  it('records which terms produced the effects, for the receipt', () => {
    expect(resolve(['pregnancy', 'older_adult']).from).toEqual(['pregnancy', 'older_adult']);
  });
});

describe('dispatch is derived from the slots, not decoded', () => {
  // The mapping has to reproduce every fixture's expected tool from nothing
  // but destination and max_minutes. If it cannot, removing the field from
  // the schema lost information rather than removing a bad guess.
  for (const c of golden.cases) {
    it(c.name, () => {
      expect(dispatchFor(c.expect as { destination: string | null; max_minutes: number | null }))
        .toBe(c.tool);
    });
  }

  it('reads a blank destination as no destination', () => {
    // The card writes null for an emptied field, but a model can emit "".
    expect(dispatchFor({ destination: '', max_minutes: null })).toBe('find_comfort_and_route');
    expect(dispatchFor({ destination: '  ', max_minutes: 15 })).toBe('find_reachable_resources');
  });

  it('prefers a named destination over a time budget', () => {
    expect(dispatchFor({ destination: 'Betsy Head Park', max_minutes: 15 })).toBe('plan_route');
  });

  it('labels every tool for the card', () => {
    for (const t of TOOLS) expect(TOOL_LABELS[t], `${t} has no label`).toBeTruthy();
  });
});
