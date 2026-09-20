// Stage 1: natural language to a profile object.
//
// This is one of only two stages that touch a model, and it does the smallest
// possible job: it classifies the user's words into a fixed vocabulary and
// copies out the place names. It decides nothing about routing. What a
// condition implies is written in config/condition-map.yaml, in the open,
// where a clinician can read it and argue with it.
//
// The output is masked at the logit level by a grammar generated from that
// same YAML file, so the model cannot emit a term the condition map does not
// define. Schema validity is a property of the decoder, not of the prompt.
//
// Nothing here routes. The profile goes to the confirmation card first, and
// the user accepts or corrects it before stage 2 runs. That is what makes a
// silently dropped constraint impossible: every field the grammar can produce
// has a control on the card, so a missing constraint is visible before it can
// affect a route.

import type { LLMAdapter } from '../adapters/llm';
import { UnconstrainedDecodeError } from '../adapters/llm';
import type { ChatMessage } from '../domain/narration';
import {
  CONDITION_LABELS,
  CONDITION_TERMS,
  PROFILE_GRAMMAR,
  RESOURCE_TYPES,
  validateProfile,
} from '../domain/profile-grammar';
import type { ConditionTerm, TravelProfile } from '../domain/profile-grammar';
import { CONDITION_DEFAULTS, CONDITION_EFFECTS } from '../domain/condition-effects';

export type ExtractionResult = {
  profile: TravelProfile;
  /** Always true in shipped code. Recorded so the receipt can prove it. */
  constrained: boolean;
  raw: string;
  elapsed_ms: number;
};

export class ExtractionError extends Error {
  constructor(message: string, readonly raw: string) {
    super(message);
    this.name = 'ExtractionError';
  }
}

// The system prompt describes the job and nothing else. It does not beg for
// JSON, because the grammar already guarantees the shape, and a prompt that
// spends its tokens on formatting has fewer left for the classification that
// actually needs judgement.
function systemPrompt(): string {
  const conditions = CONDITION_TERMS.map((t) => `${t} (${CONDITION_LABELS[t]})`).join('\n  ');
  return [
    'You read one sentence from a person who wants to walk somewhere in New York City,',
    'and you fill in a form about it. You do not plan the route.',
    '',
    'intent:',
    '  plan_route      they named both a start and a destination',
    '  find_comfort    they want the nearest place of some kind, with no time limit given',
    '  find_reachable  they asked what they can reach within a stated number of minutes',
    '',
    'origin: the place they are starting from, copied as they wrote it.',
    'If they did not say, write exactly @me and the app will ask them.',
    'Never invent a starting point.',
    '',
    'destination: where they are going, or null if they only described a need.',
    '',
    `resource_types: zero or more of ${RESOURCE_TYPES.join(', ')}.`,
    '',
    'conditions: zero or more of the following. Choose a term only when the',
    'person actually said something that matches it. Do not infer a health',
    'condition from a mobility aid, or a mobility need from a health condition.',
    `  ${conditions}`,
    '',
    'max_minutes: only when they stated a number of minutes. Otherwise null.',
    '',
    'for_someone_else: true when they are planning for another person,',
    'for example "my grandmother" or "my son". The conditions then describe',
    'that person, not the speaker.',
  ].join('\n');
}

export class ExtractionService {
  constructor(private llm: LLMAdapter) {}

  /**
   * Extract a profile from one user message.
   *
   * Throws rather than returning a best guess. A profile that is wrong in a way
   * the user cannot see is worse than no profile: the confirmation card can
   * correct a wrong value, but it cannot correct a value that was never shown.
   */
  async extract(query: string): Promise<ExtractionResult> {
    const t0 = performance.now();
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt() },
      { role: 'user', content: query },
    ];

    let raw = '';
    try {
      for await (const delta of this.llm.completion(messages, {
        max_tokens: 256,
        temperature: 0,
        grammar: PROFILE_GRAMMAR,
      })) {
        raw += delta;
      }
    } catch (e) {
      if (e instanceof UnconstrainedDecodeError) throw e;
      throw new ExtractionError(`extraction failed: ${(e as Error)?.message ?? e}`, raw);
    }

    // The grammar guarantees this parses. It is checked anyway, on every
    // extraction, so that if the constrained path is ever bypassed the failure
    // is loud rather than silent.
    const constrained = this.llm.wasLastConstrained();
    if (!constrained) {
      throw new UnconstrainedDecodeError(
        'the adapter reported an unconstrained decode for a grammar request',
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new ExtractionError(
        'grammar-constrained output did not parse, which should be impossible',
        raw,
      );
    }

    const check = validateProfile(parsed);
    if (!check.ok) {
      throw new ExtractionError(
        `grammar-constrained output failed validation: ${check.errors.join('; ')}`,
        raw,
      );
    }

    return {
      profile: check.profile,
      constrained,
      raw,
      elapsed_ms: Math.round(performance.now() - t0),
    };
  }
}

// ── turning a confirmed profile into router arguments ───────────────────────

/**
 * What the condition map says a set of terms implies, resolved.
 *
 * The map itself is the YAML file; this mirrors its combination rules. The
 * numbers are not here, they are generated into condition-effects.ts from the
 * YAML, so that editing the YAML is the only way to change a consequence.
 */
export type ResolvedEffects = {
  heat_aware: boolean;
  sun_inflation: number;
  router_profile: string;
  max_continuous_exposure_min: number | null;
  prefer_indoor_waiting: boolean;
  /** The terms that produced these effects, for the receipt. */
  from: ConditionTerm[];
};

const PROFILE_PRECEDENCE = ['manual_wheelchair', 'low_vision', 'generic_pedestrian'];

export function resolveEffects(
  conditions: ConditionTerm[],
  table: Record<string, Record<string, unknown>>,
  defaults: Record<string, unknown>,
): ResolvedEffects {
  const out: ResolvedEffects = {
    heat_aware: Boolean(defaults.heat_aware),
    sun_inflation: Number(defaults.sun_inflation ?? 0),
    router_profile: String(defaults.router_profile ?? 'generic_pedestrian'),
    max_continuous_exposure_min: (defaults.max_continuous_exposure_min as number) ?? null,
    prefer_indoor_waiting: Boolean(defaults.prefer_indoor_waiting),
    from: [...conditions],
  };

  for (const term of conditions) {
    const e = table[term];
    if (!e) continue;
    // Sensitivity accumulates and never cancels out: the most sensitive
    // matched term wins each field.
    if (e.heat_aware) out.heat_aware = true;
    if (typeof e.sun_inflation === 'number') {
      out.sun_inflation = Math.max(out.sun_inflation, e.sun_inflation);
    }
    if (typeof e.max_continuous_exposure_min === 'number') {
      out.max_continuous_exposure_min =
        out.max_continuous_exposure_min === null
          ? e.max_continuous_exposure_min
          : Math.min(out.max_continuous_exposure_min, e.max_continuous_exposure_min);
    }
    if (e.prefer_indoor_waiting) out.prefer_indoor_waiting = true;
    if (typeof e.router_profile === 'string') {
      // Most restrictive wins, so a stated wheelchair need is never silently
      // downgraded by another term.
      const current = PROFILE_PRECEDENCE.indexOf(out.router_profile);
      const candidate = PROFILE_PRECEDENCE.indexOf(e.router_profile);
      if (candidate >= 0 && (current < 0 || candidate < current)) {
        out.router_profile = e.router_profile;
      }
    }
  }

  return out;
}
