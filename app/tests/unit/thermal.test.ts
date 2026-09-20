// The thermal cost exists twice: inside the WASM cost rule tree, as a term in
// router/examples/profile-*.json, and in TypeScript, because transit waits are
// priced where the cost tree never runs. These tests are the only thing
// standing between the two copies and silent drift.
//
// They also assert that the published numbers the whole argument rests on are
// actually the ones shipping.

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MRT_SHADE_C,
  MRT_SUN_C,
  SUN_INFLATION_DEFAULT,
  SUN_INFLATION_SENSITIVE,
  UTCI_CATEGORY_MRT_C,
  THERMAL_OFF,
  THERMAL_ON,
  exposureFraction,
  makeStopThermalIndex,
  routeThermalStats,
  stressCategory,
  thermalArgsJSON,
  thermalLoad,
  thermalWaitSeconds,
  type PlatformThermal,
} from '../../src/lib/domain/thermal';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

type ProfileJSON = {
  args: Array<{ name: string; default?: unknown; description?: string }>;
  cost: { terms?: Array<Record<string, unknown>> };
};

function loadProfile(id: string): ProfileJSON {
  return JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'router/examples', `profile-${id}.json`), 'utf8'),
  );
}

const PROFILE_IDS = ['generic_pedestrian', 'manual_wheelchair', 'low_vision'];

describe('the shipped profiles match the generated constants', () => {
  for (const id of PROFILE_IDS) {
    it(`${id} anchors match MRT_SHADE_C and MRT_SUN_C`, () => {
      const args = loadProfile(id).args;
      const get = (n: string) => args.find((a) => a.name === n);
      expect(get('mrt_shade')?.default).toBeCloseTo(MRT_SHADE_C, 6);
      expect(get('mrt_sun')?.default).toBeCloseTo(MRT_SUN_C, 6);
    });

    it(`${id} ships the thermal layer switched off`, () => {
      // Shipping it on would silently change every existing route.
      const arg = loadProfile(id).args.find((a) => a.name === 'sun_inflation');
      expect(arg?.default).toBe(0);
    });

    it(`${id} carries exactly one continuous term, on mrt`, () => {
      const terms = loadProfile(id).cost.terms ?? [];
      expect(terms).toHaveLength(1);
      expect(terms[0].attr).toBe('mrt');
      expect(terms[0].from).toBe('mrt_shade');
      expect(terms[0].to).toBe('mrt_sun');
      expect(terms[0].coefficient).toBe('sun_inflation');
    });
  }

  it('the coefficient cites its source in the shipped data file', () => {
    const arg = loadProfile('generic_pedestrian').args.find((a) => a.name === 'sun_inflation');
    expect(arg?.description).toContain('Melnikov');
    expect(arg?.description).toContain('2022');
  });
});

describe('the published values are the ones shipping', () => {
  it('the default is the Melnikov population mean, beta = 1.16', () => {
    expect(SUN_INFLATION_DEFAULT).toBeCloseTo(0.16, 10);
  });

  it('the sensitive value is the Melnikov observed individual maximum, beta = 1.84', () => {
    expect(SUN_INFLATION_SENSITIVE).toBeCloseTo(0.84, 10);
  });

  it('the anchors sit in the range the field measurements report', () => {
    // Middel et al. (2021) measure urban-form shade buying 22.8 to 30.9 K.
    expect(MRT_SUN_C - MRT_SHADE_C).toBeGreaterThan(20);
    expect(MRT_SUN_C - MRT_SHADE_C).toBeLessThan(34);
  });
});

describe('exposureFraction', () => {
  it('is 0 at the shade anchor and 1 at the sun anchor', () => {
    expect(exposureFraction(MRT_SHADE_C)).toBeCloseTo(0);
    expect(exposureFraction(MRT_SUN_C)).toBeCloseTo(1);
  });

  it('clamps rather than extrapolating outside the anchors', () => {
    expect(exposureFraction(MRT_SHADE_C - 20)).toBe(0);
    expect(exposureFraction(MRT_SUN_C + 20)).toBe(1);
  });

  it('is 0 for an unknown temperature', () => {
    expect(exposureFraction(null)).toBe(0);
    expect(exposureFraction(undefined)).toBe(0);
    expect(exposureFraction(NaN)).toBe(0);
  });
});

describe('thermalLoad', () => {
  it('charges nothing for an unknown temperature', () => {
    // Unsurveyed is not cool. It is unknown, and inventing a penalty for it
    // would be worse than declining to charge one.
    expect(thermalLoad(null, THERMAL_ON)).toBe(1);
    expect(thermalLoad(undefined, THERMAL_ON)).toBe(1);
    expect(thermalLoad(NaN, THERMAL_ON)).toBe(1);
  });

  it('charges nothing when heat awareness is off', () => {
    expect(thermalLoad(MRT_SUN_C, THERMAL_OFF)).toBe(1);
  });

  it('charges nothing in full shade, which is what an unsurveyed edge pays', () => {
    // This is the property that stops the router being paid to leave coverage.
    expect(thermalLoad(MRT_SHADE_C, THERMAL_ON)).toBeCloseTo(1);
    expect(thermalLoad(null, THERMAL_ON)).toBeCloseTo(thermalLoad(MRT_SHADE_C, THERMAL_ON));
  });

  it('charges exactly beta - 1 at full sun', () => {
    expect(thermalLoad(MRT_SUN_C, THERMAL_ON)).toBeCloseTo(1 + SUN_INFLATION_DEFAULT, 10);
  });

  it('is linear between the anchors', () => {
    const mid = (MRT_SHADE_C + MRT_SUN_C) / 2;
    expect(thermalLoad(mid, THERMAL_ON)).toBeCloseTo(1 + SUN_INFLATION_DEFAULT / 2, 10);
  });

  it('is monotone', () => {
    let previous = 0;
    for (const t of [20, 33, 40, 48, 55, 62, 80]) {
      const load = thermalLoad(t, THERMAL_ON);
      expect(load).toBeGreaterThanOrEqual(previous);
      previous = load;
    }
  });

  it('responds to a raised coefficient, which is how sensitivity is expressed', () => {
    const mean = thermalLoad(MRT_SUN_C, THERMAL_ON);
    const sensitive = thermalLoad(MRT_SUN_C, {
      heat_aware: true,
      sun_inflation: SUN_INFLATION_SENSITIVE,
    });
    expect(sensitive).toBeGreaterThan(mean);
    expect(sensitive).toBeCloseTo(1.84, 10);
  });
});

describe('thermalArgsJSON', () => {
  it('returns null when off, so the router takes its default path', () => {
    expect(thermalArgsJSON(undefined)).toBeNull();
    expect(thermalArgsJSON(THERMAL_OFF)).toBeNull();
  });

  it('sends the coefficient when on', () => {
    expect(JSON.parse(thermalArgsJSON(THERMAL_ON)!)).toEqual({
      sun_inflation: SUN_INFLATION_DEFAULT,
    });
  });

  it('passes anchors through only when overridden', () => {
    const json = JSON.parse(thermalArgsJSON({ heat_aware: true, mrt_shade: 30 })!);
    expect(json.mrt_shade).toBe(30);
    expect(json).not.toHaveProperty('mrt_sun');
  });
});

describe('stressCategory', () => {
  it('labels full sun as very strong heat stress at the design condition', () => {
    // The headline finding: shade moves a pedestrian a full UTCI category.
    expect(stressCategory(MRT_SUN_C)).toBe('very strong heat stress');
  });

  it('puts full building shade just below strong heat stress', () => {
    // A finding, not a rounding artefact. On a heat advisory afternoon the
    // coolest shade a Brownsville street offers lands within a third of a
    // degree of the strong-heat-stress boundary. Shade is the difference
    // between very strong heat stress and the edge of strong heat stress; it
    // is not the difference between danger and comfort.
    const strong = UTCI_CATEGORY_MRT_C['strong heat stress'] as number;
    expect(MRT_SHADE_C).toBeLessThan(strong);
    expect(strong - MRT_SHADE_C).toBeLessThan(1.0);
    expect(stressCategory(MRT_SHADE_C)).toBe('moderate heat stress');
  });

  it('moves a full UTCI category between shade and sun', () => {
    expect(stressCategory(MRT_SUN_C)).toBe('very strong heat stress');
    expect(stressCategory(MRT_SHADE_C)).not.toBe(stressCategory(MRT_SUN_C));
  });

  it('returns null for an unknown temperature rather than guessing', () => {
    expect(stressCategory(null)).toBeNull();
    expect(stressCategory(NaN)).toBeNull();
  });
});

describe('thermalWaitSeconds', () => {
  const elevated: PlatformThermal = {
    mrt_c: 62, structure: 'Elevated', underground: false, tier: 'proxy',
  };
  const underground: PlatformThermal = {
    mrt_c: 37, structure: 'Subway', underground: true, tier: 'assumed',
  };

  it('prices an exposed elevated platform at close to full sun', () => {
    const wait = thermalWaitSeconds(480, elevated, THERMAL_ON);
    expect(wait.load).toBeCloseTo(1 + SUN_INFLATION_DEFAULT, 2);
  });

  it('inverts underground in summer, which is the point', () => {
    const above = thermalWaitSeconds(480, elevated, THERMAL_ON);
    const below = thermalWaitSeconds(480, underground, THERMAL_ON);
    expect(below.seconds).toBeLessThan(above.seconds);
    // 37 C is above the shade anchor but well below the sun anchor.
    expect(below.load).toBeGreaterThan(1);
    expect(below.load).toBeLessThan(above.load);
  });

  it('carries the tier so the interface can say the number is assumed', () => {
    expect(thermalWaitSeconds(60, underground, THERMAL_ON).tier).toBe('assumed');
    expect(thermalWaitSeconds(60, undefined, THERMAL_ON).tier).toBe('unmodelled');
  });

  it('charges a plain wait when heat awareness is off', () => {
    expect(thermalWaitSeconds(480, elevated, THERMAL_OFF).seconds).toBe(480);
  });
});

describe('routeThermalStats', () => {
  it('weights by length rather than by edge count', () => {
    const stats = routeThermalStats([
      { mrt: 40, length: 900 },
      { mrt: 60, length: 100 },
    ]);
    expect(stats.mean_mrt_c).toBeCloseTo(42);
    expect(stats.max_mrt_c).toBe(60);
    expect(stats.surveyed_share).toBe(1);
  });

  it('excludes unsurveyed edges instead of treating them as cool', () => {
    const stats = routeThermalStats([{ mrt: 60, length: 500 }, { length: 500 }]);
    expect(stats.mean_mrt_c).toBe(60);
    expect(stats.surveyed_share).toBeCloseTo(0.5);
  });

  it('reports no temperature at all when nothing was surveyed', () => {
    const stats = routeThermalStats([{ length: 100 }, { length: 200 }]);
    expect(stats.mean_mrt_c).toBeNull();
    expect(stats.max_mrt_c).toBeNull();
    expect(stats.surveyed_share).toBe(0);
  });
});

describe('stop thermal index', () => {
  it('reads the pipeline artifact when it has been built', () => {
    const file = path.join(REPO_ROOT, 'data/thermal-stops.json');
    if (!fs.existsSync(file)) return; // regenerable artifact, absent on a bare clone
    const payload = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      stops: Record<string, PlatformThermal>;
    };
    const index = makeStopThermalIndex(payload);
    expect(index.size).toBeGreaterThan(400);
    expect(index.undergroundAssumptionC).toBeGreaterThan(30);

    // Every underground platform must carry the assumed tier, never proxy:
    // there is no grid underground and claiming one would be a fabrication.
    for (const [id, p] of Object.entries(payload.stops)) {
      if (p.underground) expect(p.tier, `${id} is underground`).toBe('assumed');
      if (p.tier === 'proxy') expect(p.underground, `${id} is proxy`).toBe(false);
    }
  });
});
