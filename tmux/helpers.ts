export type State = "idle" | "working" | "compacting" | "blocked" | "done" | "error";
export type Outcome = "completed" | "aborted" | "error";
export interface Activity {
  base: Exclude<State, "blocked" | "compacting">;
  compacting: boolean;
  prompts: number;
  outcome: Outcome;
  unread: boolean;
  resumeUnread: boolean;
  /** Background subagent runs this Pi is still waiting on. */
  background: number;
  /** Unread was requested with `/unread`, not derived from completion. */
  explicit: boolean;
  /** A done/error alert raised but not yet shown: overlays (dialogs, compaction, background runs) defer it. */
  pending: boolean;
}
export type Event =
  | { type: "start" }
  | { type: "outcome"; outcome: Outcome }
  | { type: "settled"; aborted: boolean }
  | { type: "prompt-start" }
  | { type: "prompt-end" }
  | { type: "ack" }
  | { type: "unread" }
  | { type: "refresh" }
  | { type: "compact-start" }
  | { type: "compact-end"; failed: boolean; aborted: boolean }
  | { type: "background"; count: number };
export const INITIAL: Activity = {
  base: "idle",
  compacting: false,
  prompts: 0,
  outcome: "completed",
  unread: false,
  resumeUnread: false,
  background: 0,
  explicit: false,
  pending: false,
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
  if (activity.prompts > 0) return "blocked";
  if (activity.compacting) return "compacting";
  // An idle parent waiting on its own background subagents is still working.
  return activity.background > 0 ? "working" : activity.base;
}
/** Completion attention waits for background subagents; questions and `/unread` never wait. */
export function visibleUnread(activity: Activity): boolean {
  return (
    activity.unread && (activity.explicit || activity.prompts > 0 || activity.background === 0)
  );
}
interface BackgroundRunNotice {
  id?: string;
  runId?: string;
  pid?: number;
}
/** pi-subagents `subagent:async-started`/`subagent:async-complete` payloads. */
export function backgroundRun(data: object): { id: string; pid?: number } | undefined {
  const notice = data as BackgroundRunNotice;
  const id = typeof notice.runId === "string" ? notice.runId : notice.id;
  if (typeof id !== "string" || !id) return undefined;
  return Number.isSafeInteger(notice.pid) && Number(notice.pid) > 0
    ? { id, pid: notice.pid }
    : { id };
}
/**
 * Applies an event and reports whether it raises a new alert (fresh attention token).
 * Dialog alerts fire when the first dialog opens; completion alerts fire once, when
 * done/error first becomes visible, however long overlays deferred it.
 */
export function step(activity: Activity, event: Event): { activity: Activity; alert: boolean } {
  const reduced = reduce(activity, event);
  // `/unread` provenance never outlives the unread mark it explains.
  const next = reduced.unread || !reduced.explicit ? reduced : { ...reduced, explicit: false };
  const state = visibleState(next);
  const completion = next.pending && visibleUnread(next) && (state === "done" || state === "error");
  return {
    activity: completion ? { ...next, pending: false } : next,
    alert: event.type === "unread" || (activity.prompts === 0 && next.prompts > 0) || completion,
  };
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
        explicit: activity.prompts > 0 && activity.explicit,
        pending: false,
      };
    case "outcome":
      return { ...activity, outcome: event.outcome };
    case "settled": {
      if (activity.base !== "working") return activity;
      // Pi skips agent_before_settle on cancellation; settlement's flag is authoritative.
      const base =
        event.aborted || activity.outcome === "aborted"
          ? "idle"
          : activity.outcome === "error"
            ? "error"
            : "done";
      return {
        ...activity,
        base,
        unread: activity.prompts > 0 ? activity.unread : base !== "idle",
        resumeUnread: base !== "idle",
        pending: base !== "idle",
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
      return { ...activity, unread: false, resumeUnread: false, explicit: false, pending: false };
    case "unread":
      return { ...activity, unread: true, resumeUnread: true, explicit: true };
    case "refresh":
      return activity;
    case "background":
      return { ...activity, background: event.count };
    case "compact-start":
      return { ...activity, compacting: true };
    case "compact-end":
      return {
        ...activity,
        compacting: false,
        ...(event.failed && !event.aborted && activity.base !== "working"
          ? { base: "error" as const, unread: true, resumeUnread: true, pending: true }
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
export function isInteraction(data: string): boolean {
  if (!data || data.startsWith("\x1b]") || data.startsWith("\x1bP")) return false;
  // eslint-disable-next-line no-control-regex -- Filter terminal replies and focus-out, not actual user input.
  return data.replace(/\x1b\[[?=>\d;]*[cnRt]|\x1b\[O/g, "").length > 0;
}
