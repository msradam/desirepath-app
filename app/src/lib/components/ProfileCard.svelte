<script lang="ts">
  /**
   * Profile confirmation card. A model read one sentence and filled in this
   * form; nothing routes until the user accepts it or corrects it.
   *
   * Every field the grammar can emit has a control here. That is the whole
   * point: a dropped constraint must be visible before it reaches the router,
   * because a route planned without a stated constraint looks exactly like a
   * route planned for somebody who stated nothing.
   */

  import {
    CONDITION_LABELS,
    CONDITION_TERMS,
    RESOURCE_TYPES,
  } from '$lib/domain/profile-grammar';
  import type { TravelProfile } from '$lib/domain/profile-grammar';
  import { TOOLS, TOOL_LABELS, dispatchFor } from '$lib/domain/dispatch';
  import type { Tool } from '$lib/domain/dispatch';
  import { CONDITION_DEFAULTS, CONDITION_EFFECTS, CONDITION_MAP_VERSION } from '$lib/domain/condition-effects';
  import { resolveEffects } from '$lib/services/extraction';

  type Edits = { of: TravelProfile; value: TravelProfile };

  let {
    profile,
    query = '',
    constrained = true,
    onaccept,
    oncancel,
  }: {
    profile: TravelProfile;
    /** The sentence the person actually typed. Shown so they can compare. */
    query?: string;
    /** Whether stage 1 was grammar-constrained. Always true in shipped code. */
    constrained?: boolean;
    onaccept?: (p: TravelProfile, tool: Tool) => void;
    oncancel?: () => void;
  } = $props();

  const ROUTER_LABELS: Record<string, string> = {
    generic_pedestrian: 'Walking, no mobility constraint stated',
    manual_wheelchair: 'Manual wheelchair, step-free only',
    low_vision: 'Low vision, crossings and guidance weighted',
  };

  const uid = $props.id();

  // The edits are held against the profile they were made to. A new extraction
  // arrives as a new object, and the draft re-seeds from it rather than
  // carrying over answers that belonged to a different sentence. Holding the
  // edits this way keeps the prop untouched and needs no effect to reset.
  let edits = $state.raw<Edits | null>(null);

  const draft = $derived(edits && edits.of === profile ? edits.value : { ...profile });

  // The tool is derived from the slots, not decoded. An override is held
  // separately and against the same profile, so a new extraction drops it
  // rather than carrying a choice that belonged to a different sentence, and
  // so that editing the destination moves the derived answer while the user
  // has not said otherwise.
  let override = $state.raw<{ of: TravelProfile; tool: Tool } | null>(null);
  const derivedTool = $derived(dispatchFor(draft));
  const tool = $derived(override && override.of === profile ? override.tool : derivedTool);

  function set<K extends keyof TravelProfile>(key: K, value: TravelProfile[K]) {
    edits = { of: profile, value: { ...draft, [key]: value } };
  }

  function toggle<K extends 'resource_types' | 'conditions'>(key: K, term: string, on: boolean) {
    const current = draft[key] as string[];
    const next = on ? [...current, term] : current.filter((t) => t !== term);
    set(key, next as TravelProfile[K]);
  }

  /**
   * The model is instructed to write @me precisely when the person did not say
   * where they are. It is a request for an answer, not an answer, so it is
   * never shown as one and it never passes as one.
   */
  const originUnresolved = $derived(draft.origin.trim() === '' || draft.origin.trim() === '@me');
  const originValue = $derived(draft.origin.trim() === '@me' ? '' : draft.origin);

  const effects = $derived(resolveEffects(draft.conditions, CONDITION_EFFECTS, CONDITION_DEFAULTS));
  /** A metre in full sun costs this many metres to the router. */
  const beta = $derived(1 + effects.sun_inflation);

  function words(term: string): string {
    return term.replace(/_/g, ' ');
  }

  function readMinutes(el: HTMLInputElement): number | null {
    const n = el.valueAsNumber;
    return Number.isInteger(n) && n > 0 ? n : null;
  }
</script>

<section class="card" aria-labelledby="{uid}-title">
  <h2 id="{uid}-title">Check this before anything routes</h2>

  {#if query}
    <p class="typed">You typed: <span class="quoted">{query}</span></p>
  {/if}

  {#if constrained}
    <p class="provenance">
      A model filled this form in. Its output was held to a fixed vocabulary, so it could not
      invent a term. Nothing routes until you accept.
    </p>
  {:else}
    <p class="defect" role="alert">
      This extraction was not held to the vocabulary. The model may have emitted a term the
      condition map does not define, or dropped one it does. Do not accept this profile. Report it.
    </p>
  {/if}

  <div class="form">
    <fieldset class="group">
      <legend>What you are asking for</legend>
      <div class="segments">
        {#each TOOLS as value (value)}
          <label class="segment" class:on={tool === value}>
            <input
              type="radio"
              name="{uid}-tool"
              {value}
              checked={tool === value}
              onchange={() => (override = { of: profile, tool: value })}
            />
            <span>{TOOL_LABELS[value]}</span>
          </label>
        {/each}
      </div>
      <p class="note">
        {#if tool === derivedTool}
          Chosen from what you filled in below, not by the model. Change it here if it is wrong.
        {:else}
          You changed this. It would otherwise be
          <em>{TOOL_LABELS[derivedTool]}</em>, from what you filled in below.
        {/if}
      </p>
    </fieldset>

    <div class="places">
      <div class="field">
        <label for="{uid}-origin">Starting point</label>
        <input
          id="{uid}-origin"
          class="text"
          type="text"
          value={originValue}
          placeholder="Where are you starting from?"
          aria-invalid={originUnresolved}
          aria-describedby={originUnresolved ? `${uid}-origin-note` : undefined}
          oninput={(e) => set('origin', e.currentTarget.value)}
        />
        {#if originUnresolved}
          <p class="note needed" id="{uid}-origin-note">
            You did not say where you are starting from. Type a place before accepting.
          </p>
        {/if}
      </div>

      <div class="field">
        <label for="{uid}-destination">Destination</label>
        <input
          id="{uid}-destination"
          class="text"
          type="text"
          value={draft.destination ?? ''}
          placeholder="Leave empty if you did not name one"
          oninput={(e) => set('destination', e.currentTarget.value.trim() || null)}
        />
      </div>

      <div class="field">
        <label for="{uid}-minutes">Minutes you have</label>
        <input
          id="{uid}-minutes"
          class="text mono"
          type="number"
          min="1"
          max="999"
          step="1"
          value={draft.max_minutes ?? ''}
          placeholder="Leave empty for no limit"
          aria-describedby="{uid}-minutes-note"
          oninput={(e) => set('max_minutes', readMinutes(e.currentTarget))}
        />
        <p class="note" id="{uid}-minutes-note">
          {#if tool === 'find_reachable_resources'}
            This is the time budget the reachable area is drawn from.
          {:else if draft.destination}
            Not used: you named a destination, so the route goes there.
          {:else}
            Give a number and the request becomes "What can I reach".
          {/if}
        </p>
      </div>
    </div>

    <!--
      The conditions carry the most weight on the card because they are the
      field a person is least likely to repeat if it goes missing. Resources
      are a preference; a condition is a limit on what the route may cost them.
    -->
    <fieldset class="group conditions">
      <legend>What the route has to account for</legend>
      <p class="note">
        Only what was said. Nothing here is inferred from anything else.
      </p>
      <div class="checks wide">
        {#each CONDITION_TERMS as term (term)}
          <label class="check">
            <input
              type="checkbox"
              checked={draft.conditions.includes(term)}
              onchange={(e) => toggle('conditions', term, e.currentTarget.checked)}
            />
            <span>{CONDITION_LABELS[term]}</span>
          </label>
        {/each}
      </div>

      <label class="check someone">
        <input
          type="checkbox"
          checked={draft.for_someone_else}
          onchange={(e) => set('for_someone_else', e.currentTarget.checked)}
        />
        <span>This trip is for somebody else</span>
      </label>
      {#if draft.for_someone_else}
        <p class="note">
          The conditions above describe that person, not you. The route is planned for what they
          can walk.
        </p>
      {/if}
    </fieldset>

    <fieldset class="group">
      <legend>Places worth stopping at</legend>
      <div class="checks">
        {#each RESOURCE_TYPES as type (type)}
          <label class="check compact">
            <input
              type="checkbox"
              checked={draft.resource_types.includes(type)}
              onchange={(e) => toggle('resource_types', type, e.currentTarget.checked)}
            />
            <span>{words(type)}</span>
          </label>
        {/each}
      </div>
    </fieldset>
  </div>

  <div class="consequence">
    <h3>What this will do</h3>
    <dl>
      <div class="row">
        <dt>Router profile</dt>
        <dd>{ROUTER_LABELS[effects.router_profile] ?? words(effects.router_profile)}</dd>
      </div>
      {#if effects.heat_aware}
        <div class="row">
          <dt>Heat</dt>
          <dd>
            Priced. Sun inflation <span class="mono">{effects.sun_inflation.toFixed(2)}</span>: a
            metre in full sun is costed as <span class="mono">{beta.toFixed(2)}</span> metres.
          </dd>
        </div>
      {:else}
        <div class="row">
          <dt>Heat</dt>
          <dd>Not priced. Sun and shade cost the same per metre.</dd>
        </div>
      {/if}
      <div class="row">
        <dt>Continuous exposure</dt>
        <dd>
          {#if effects.max_continuous_exposure_min === null}
            No cap. A stretch of unshaded pavement can be any length.
          {:else}
            Capped at <span class="mono">{effects.max_continuous_exposure_min}</span> minutes in
            one unbroken stretch of sun.
          {/if}
        </dd>
      </div>
      <div class="row">
        <dt>Waiting</dt>
        <dd>
          {effects.prefer_indoor_waiting
            ? 'Indoor waiting is preferred where a stop offers it.'
            : 'No preference between waiting indoors and outdoors.'}
        </dd>
      </div>
    </dl>

    {#if draft.conditions.length === 0}
      <p class="note off">
        No condition is selected. The thermal layer is off, and the route will be the ordinary
        shortest accessible one.
      </p>
    {/if}

    <p class="source">
      These values are read from <span class="mono">config/condition-map.yaml</span>, version
      <span class="mono">{CONDITION_MAP_VERSION}</span>. The file decides them, not the model.
    </p>
  </div>

  <div class="actions">
    <button class="accept" type="button" disabled={originUnresolved} onclick={() => onaccept?.(draft, tool)}>
      Accept and plan
    </button>
    <button class="cancel" type="button" onclick={() => oncancel?.()}>Cancel</button>
    {#if originUnresolved}
      <p class="blocked">Accept is unavailable until you give a starting point.</p>
    {/if}
  </div>
</section>

<style>
  .card {
    max-width: 44rem;
    padding: 24px;
    background: var(--surface);
    border: 1px solid var(--border-2);
    color: var(--ink);
    font-family: var(--font-sans);
  }

  h2 {
    margin-top: 8px;
    font-size: clamp(1.4rem, 1.1rem + 1.1vw, 1.8rem);
    font-weight: 700;
    line-height: 1.15;
    letter-spacing: -0.01em;
  }

  h3 {
    margin-top: 4px;
    font-size: 0.95rem;
    font-weight: 700;
    line-height: 1.3;
  }

  .typed {
    margin-top: 12px;
    font-size: 0.95rem;
    line-height: 1.55;
    color: var(--ink-2);
  }

  .quoted {
    color: var(--ink);
  }

  .quoted::before {
    content: '“';
  }

  .quoted::after {
    content: '”';
  }

  .provenance {
    margin-top: 12px;
    padding-top: 12px;
    border-top: 1px solid var(--border);
    font-size: 0.85rem;
    line-height: 1.5;
    color: var(--muted);
  }

  .defect {
    margin-top: 14px;
    padding: 12px 14px;
    border: 1px solid var(--error);
    font-size: 0.9rem;
    font-weight: 500;
    line-height: 1.5;
    color: var(--error);
  }

  .form {
    display: flex;
    flex-direction: column;
    gap: 28px;
    margin-top: 28px;
  }

  .group {
    border: none;
  }

  legend {
    padding: 0;
    font-size: 0.85rem;
    font-weight: 700;
    line-height: 1.3;
    color: var(--ink);
  }

  .segments {
    display: flex;
    flex-wrap: wrap;
    margin-top: 10px;
    border: 1px solid var(--border-2);
  }

  .segment {
    flex: 1 1 10rem;
    padding: 10px 12px;
    font-size: 0.85rem;
    line-height: 1.35;
    color: var(--ink-2);
    background: var(--surface);
    border-right: 1px solid var(--border-2);
    cursor: pointer;
  }

  .segment:last-child {
    border-right: none;
  }

  .segment.on {
    background: var(--primary);
    color: var(--primary-on);
    font-weight: 500;
  }

  .segment input {
    position: absolute;
    width: 1px;
    height: 1px;
    opacity: 0;
  }

  .segment:has(input:focus-visible) {
    outline: 2px solid var(--primary);
    outline-offset: -2px;
  }

  .places {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
    gap: 16px;
  }

  .field {
    min-width: 0;
  }

  label {
    display: block;
    font-size: 0.85rem;
    font-weight: 500;
    line-height: 1.3;
    color: var(--ink);
  }

  .text {
    width: 100%;
    margin-top: 6px;
    padding: 9px 10px;
    font-family: var(--font-sans);
    font-size: 0.9rem;
    color: var(--ink);
    background: var(--bg);
    border: 1px solid var(--border-2);
  }

  .text.mono {
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
  }

  .text::placeholder {
    color: var(--subtle);
  }

  .text[aria-invalid='true'] {
    border-color: var(--error);
  }

  .note {
    margin-top: 6px;
    font-size: 0.8rem;
    line-height: 1.45;
    color: var(--muted);
  }

  .note.needed {
    color: var(--error);
  }

  .conditions {
    padding: 18px 16px;
    background: var(--surface-2);
    border: 1px solid var(--border-2);
  }

  .conditions legend {
    padding: 0 6px;
    margin-left: -6px;
    font-size: 0.95rem;
    background: var(--surface-2);
  }

  .checks {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(13rem, 1fr));
    gap: 2px 14px;
    margin-top: 10px;
  }

  .checks.wide {
    grid-template-columns: repeat(auto-fill, minmax(17rem, 1fr));
    gap: 4px 16px;
  }

  .check {
    display: flex;
    align-items: baseline;
    gap: 9px;
    padding: 7px 0;
    font-weight: 400;
    line-height: 1.4;
    cursor: pointer;
  }

  .check.compact {
    padding: 4px 0;
    font-size: 0.83rem;
    color: var(--ink-2);
  }

  .check input {
    flex: none;
    width: 15px;
    height: 15px;
    accent-color: var(--primary);
  }

  .someone {
    margin-top: 14px;
    padding-top: 14px;
    border-top: 1px solid var(--border);
    font-weight: 500;
  }

  .consequence {
    margin-top: 32px;
    padding-top: 20px;
    border-top: 1px solid var(--rule);
  }

  dl {
    margin-top: 12px;
    border-top: 1px solid var(--border);
  }

  .row {
    display: grid;
    grid-template-columns: 11rem minmax(0, 1fr);
    gap: 12px;
    padding: 9px 0;
    border-bottom: 1px solid var(--border);
    font-size: 0.85rem;
    line-height: 1.45;
  }

  dt {
    color: var(--muted);
  }

  dd {
    color: var(--ink);
  }

  .mono {
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
  }

  .note.off {
    margin-top: 12px;
    color: var(--ink-2);
  }

  .source {
    margin-top: 14px;
    font-size: 0.8rem;
    line-height: 1.45;
    color: var(--muted);
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
    margin-top: 28px;
    padding-top: 20px;
    border-top: 1px solid var(--border);
  }

  button {
    padding: 10px 18px;
    font-family: var(--font-sans);
    font-size: 0.9rem;
    font-weight: 600;
    line-height: 1.2;
    border: 1px solid transparent;
    cursor: pointer;
  }

  .accept {
    color: var(--primary-on);
    background: var(--primary);
  }

  .accept:hover:not(:disabled) {
    background: var(--primary-2);
  }

  .accept:disabled {
    color: var(--muted);
    background: var(--bg-2);
    border-color: var(--border-2);
    cursor: not-allowed;
  }

  .cancel {
    color: var(--ink-2);
    background: transparent;
    border-color: var(--border-2);
  }

  .cancel:hover {
    color: var(--ink);
    border-color: var(--rule);
  }

  .blocked {
    flex: 1 1 14rem;
    font-size: 0.8rem;
    line-height: 1.45;
    color: var(--error);
  }

  @media (max-width: 600px) {
    .card {
      padding: 18px 16px;
    }

    .row {
      grid-template-columns: minmax(0, 1fr);
      gap: 2px;
    }
  }
</style>
