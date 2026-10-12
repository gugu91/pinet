export type State = "idle" | "working" | "compacting" | "blocked" | "done" | "error";
export type Outcome = "completed" | "aborted" | "error";
export interface Activity {
  base: Exclude<State, "blocked" | "compacting">;
  compacting: boolean;
  prompts: number;
  outcome: Outcome;
  unread: boolean;
  resumeUnread: boolean;
}
export type Event =
  | { type: "start" }
  | { type: "outcome"; outcome: Outcome }
  | { type: "settled" }
  | { type: "prompt-start" }
  | { type: "prompt-end" }
  | { type: "ack" }
  | { type: "unread" }
  | { type: "refresh" }
  | { type: "compact-start" }
  | { type: "compact-end"; failed: boolean; aborted: boolean };
export const INITIAL: Activity = {
  base: "idle",
  compacting: false,
  prompts: 0,
  outcome: "completed",
  unread: false,
  resumeUnread: false,
};
export const ICONS: Record<State, string> = {
  blocked: "🙋",
  error: "❌",
  working: "⚙️",
  compacting: "🗜️",
  done: "✅",
  idle: "💤",
};
export const ORDER: State[] = ["blocked", "error", "compacting", "working", "done", "idle"];
interface CompactionNotice {
  phase?: string;
  sessionFile?: string;
}
export function compactionNoticeMatches(data: object, sessionFile: string | undefined): boolean {
  const notice = data as CompactionNotice;
  return (
    notice.phase === "start" &&
    (notice.sessionFile === undefined || typeof notice.sessionFile === "string") &&
    notice.sessionFile === sessionFile
  );
}
export function visibleState(activity: Activity): State {
  return activity.prompts > 0 ? "blocked" : activity.compacting ? "compacting" : activity.base;
}
export function reduce(activity: Activity, event: Event): Activity {
  switch (event.type) {
    case "start":
      return {
        ...activity,
        base: "working",
        outcome: "completed",
        unread: activity.prompts > 0 && activity.unread,
        resumeUnread: false,
      };
    case "outcome":
      return { ...activity, outcome: event.outcome };
    case "settled": {
      if (activity.base !== "working") return activity;
      const base =
        activity.outcome === "aborted" ? "idle" : activity.outcome === "error" ? "error" : "done";
      return {
        ...activity,
        base,
        unread: activity.prompts > 0 ? activity.unread : base !== "idle",
        resumeUnread: base !== "idle",
      };
    }
    case "prompt-start":
      return {
        ...activity,
        prompts: activity.prompts + 1,
        unread: activity.prompts === 0 ? true : activity.unread,
        resumeUnread: activity.prompts === 0 ? activity.unread : activity.resumeUnread,
      };
    case "prompt-end":
      return activity.prompts === 0
        ? activity
        : {
            ...activity,
            prompts: activity.prompts - 1,
            unread: activity.prompts > 1 ? activity.unread : activity.resumeUnread,
          };
    case "ack":
      return { ...activity, unread: false, resumeUnread: false };
    case "unread":
      return { ...activity, unread: true, resumeUnread: true };
    case "refresh":
      return activity;
    case "compact-start":
      return { ...activity, compacting: true };
    case "compact-end":
      return {
        ...activity,
        compacting: false,
        ...(event.failed && !event.aborted && activity.base !== "working"
          ? { base: "error" as const, unread: true, resumeUnread: true }
          : {}),
      };
  }
}
export interface PaneRecord {
  pid: number;
  started: string;
  owner: string;
  state: State;
  unread: boolean;
}
export function encode(record: PaneRecord): string {
  return [
    "v1",
    record.pid,
    record.started,
    record.owner,
    record.state,
    record.unread ? "1" : "0",
  ].join("|");
}
export function parseRecord(text: string): PaneRecord | null {
  const parts = text.split("|");
  const [version, pid, started, owner, state, unread] = parts;
  if (
    parts.length !== 6 ||
    version !== "v1" ||
    !/^[1-9]\d{0,9}$/.test(pid) ||
    !/^[A-Za-z0-9+/=]{1,128}$/.test(started) ||
    !/^[a-f0-9-]{36}$/.test(owner) ||
    !ORDER.includes(state as State) ||
    (unread !== "0" && unread !== "1")
  )
    return null;
  return {
    pid: Number(pid),
    started,
    owner,
    state: state as State,
    unread: unread === "1",
  };
}
export interface PaneStatus {
  pane: string;
  window: string;
  record: PaneRecord;
  name?: string;
  active?: boolean;
}
export function safeName(name: string): string {
  const clean = name
    // eslint-disable-next-line no-control-regex -- Names must not emit terminal controls or bidi overrides.
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replaceAll("#", "＃")
    .trim();
  const graphemes = [
    ...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(clean),
  ].map((part) => part.segment);
  return graphemes.slice(0, 32).join("") + (graphemes.length > 32 ? "…" : "");
}
export function windowLabel(panes: PaneStatus[]): string {
  const unique = [...new Map(panes.map((pane) => [pane.pane, pane])).values()];
  if (!unique.length) return "";
  const primary = unique.find((pane) => pane.active) ?? unique[0];
  const name = safeName(primary.name || "Pi");
  if (unique.length === 1)
    return `${ICONS[primary.record.state]} ${name}${primary.record.unread ? " 🔔" : ""}`;
  return `${name} + ${unique.length - 1} ${unique.length === 2 ? "other" : "others"} · ${rollup(unique).slice(3)}`;
}
export function isInteraction(data: string): boolean {
  if (!data || data.startsWith("\x1b]") || data.startsWith("\x1bP")) return false;
  // eslint-disable-next-line no-control-regex -- Filter terminal replies and focus-out, not actual user input.
  return data.replace(/\x1b\[[?=>\d;]*[cnRt]|\x1b\[O/g, "").length > 0;
}
export function rollup(panes: PaneStatus[]): string {
  const unique = [...new Map(panes.map((pane) => [pane.pane, pane])).values()];
  const counts = ORDER.map((state) => {
    const count = unique.filter((pane) => pane.record.state === state).length;
    return count ? `${ICONS[state]} ${count}` : "";
  }).filter(Boolean);
  const unread = unique.filter((pane) => pane.record.unread).length;
  return counts.length ? `Pi ${counts.join(" · ")}${unread ? ` · 🔔 ${unread}` : ""}` : "";
}
export function shouldBell(before: Activity, after: Activity): boolean {
  const state = visibleState(after);
  return (
    after.unread &&
    !(
      before.compacting &&
      !after.compacting &&
      before.base === after.base &&
      before.prompts === after.prompts
    ) &&
    (state === "blocked" || state === "done" || state === "error") &&
    (visibleState(before) !== state || !before.unread)
  );
}
