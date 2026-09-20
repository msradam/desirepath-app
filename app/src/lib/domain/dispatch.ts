// Which router tool a confirmed profile calls.
//
// This used to be a field the model decoded. It was wrong in 65 percent of
// runs, and the reason is in the schema rather than in the model: XGrammar
// generates keys in the order the schema declares them, so `intent` was
// produced before `destination` and `max_minutes`, the only two slots that
// carry any evidence for it. The model had to commit to a classification
// before it had read the sentence out into the form.
//
// So the mapping is stated here instead, as three lines a person can check
// against the fixtures. The card still shows what it chose and lets the user
// change it, because a derived answer can be wrong about an ambiguous
// sentence even when it is never wrong about the slots it reads.

/** The three stage-2 entry points. These are router tool names, not labels. */
export const TOOLS = ['plan_route', 'find_comfort_and_route', 'find_reachable_resources'] as const;

export type Tool = (typeof TOOLS)[number];

/** The slots the dispatch reads. A subset of TravelProfile, so tests can be small. */
export type DispatchSlots = {
  destination: string | null;
  max_minutes: number | null;
};

/**
 * Named a destination      → route to it.
 * No destination, no clock → find the nearest thing of the kind they asked for.
 * No destination, a clock  → draw what is reachable inside it.
 */
export function dispatchFor(p: DispatchSlots): Tool {
  if (p.destination !== null && p.destination.trim() !== '') return 'plan_route';
  return p.max_minutes === null ? 'find_comfort_and_route' : 'find_reachable_resources';
}

/** What the card calls each tool. The user reads these, not the tool names. */
export const TOOL_LABELS: Record<Tool, string> = {
  plan_route: 'Route between two places',
  find_comfort_and_route: 'Find the nearest',
  find_reachable_resources: 'What can I reach',
};
