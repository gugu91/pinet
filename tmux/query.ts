import { ORDER, safeName, type PaneStatus, type State } from "./helpers.ts";

export interface Summary {
  count: number;
  unread: number;
  state: State | "";
  name: string;
  states: Record<State, number>;
  text: string;
}
/** Presentation-neutral aggregate; every consumer shares liveness/acknowledgement filtering. */
export function summarize(panes: PaneStatus[]): Summary {
  const unique = [...new Map(panes.map((pane) => [pane.pane, pane])).values()];
  const primary = unique.find((pane) => pane.active) ?? unique[0];
  const states: Record<State, number> = {
    blocked: 0,
    error: 0,
    compacting: 0,
    working: 0,
    done: 0,
    idle: 0,
  };
  for (const pane of unique) states[pane.record.state]++;
  const count = unique.length;
  const unread = unique.filter((pane) => pane.record.unread).length;
  const name = primary ? safeName(primary.name || "Pi") : "";
  const state = ORDER.find((state) => states[state]) ?? "";
  const counts = ORDER.filter((state) => states[state])
    .map((state) => `${state} ${states[state]}`)
    .join(" · ");
  const text =
    count === 0
      ? ""
      : count === 1
        ? `${name} · ${state}${unread ? " · unread" : ""}`
        : `${name} + ${count - 1} ${count === 2 ? "other" : "others"} · ${counts}${unread ? ` · unread ${unread}` : ""}`;
  return { count, unread, state, name, states, text };
}
