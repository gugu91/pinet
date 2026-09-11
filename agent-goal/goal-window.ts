import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";
import { displayGoalText, formatElapsed, goalDisplayName } from "./dashboard.js";
import type { AgentGoal, GoalCheckpoint, GoalContinuationClaim } from "./domain.js";

export type GoalWindowAction =
  | "close"
  | "closeGoal"
  /** @deprecated Parsed only for compatibility with older integrations; not exposed in the UI. */
  | "pause"
  /** @deprecated Parsed only for compatibility with older integrations; not exposed in the UI. */
  | "resume"
  | {
      type: "create";
      name: string;
      objective: string;
      maxIterations?: number;
      maxRuntimeMs?: number;
    }
  | { type: "edit"; name?: string; objective?: string }
  | {
      type: "budget";
      maxIterations?: number;
      maxRuntimeMs?: number;
      maxTokens?: number;
      disabled?: boolean;
    }
  | { type: "snooze"; durationMs: number };

type Mode = "details" | "create" | "edit" | "budget" | "snooze";
type TextField = "name" | "objective" | "turns" | "runtime";
type BudgetField = "turns" | "runtime";

export class GoalWindow implements Component {
  private mode: Mode = "details";
  private textField: TextField = "name";
  private name = "";
  private objective = "";
  private initialName = "";
  private initialObjective = "";
  private budgetField: BudgetField = "turns";
  private budgetTurns = "";
  private budgetRuntime = "";
  private snoozeDuration = "30m";
  private inputError: string | undefined;
  private confirmClose = false;
  private showAllCheckpoints = false;
  private checkpointOffset = 0;
  private refreshTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly goal: AgentGoal | undefined,
    private readonly claim: GoalContinuationClaim | undefined,
    private readonly theme: Theme,
    private readonly onAction: (action: GoalWindowAction) => void,
    private readonly requestRender: () => void = () => undefined,
    private readonly now: () => number = Date.now,
    private readonly actionError?: string,
    private readonly checkpoints: GoalCheckpoint[] = [],
    initialMode: "details" | "edit" = "details",
  ) {
    if (initialMode === "edit" && goal) this.openTextForm("edit");
    if (goal?.status === "active") {
      this.refreshTimer = setInterval(this.requestRender, 1_000);
      this.refreshTimer.unref();
    }
  }

  handleInput(data: string): void {
    const key = data.toLowerCase();
    if (matchesKey(data, "ctrl+c")) {
      this.onAction("close");
      return;
    }
    if (matchesKey(data, "escape")) {
      if (this.mode !== "details") {
        this.mode = "details";
        this.inputError = undefined;
        this.requestRender();
      } else if (this.confirmClose) {
        this.confirmClose = false;
        this.requestRender();
      } else this.onAction("close");
      return;
    }

    if (this.mode === "create" || this.mode === "edit") {
      this.handleTextForm(data);
      return;
    }
    if (this.mode === "budget") {
      this.handleBudgetForm(data);
      return;
    }
    if (this.mode === "snooze") {
      this.handleSnoozeForm(data);
      return;
    }

    if (!this.goal) {
      if (key === "n" || matchesKey(data, "enter")) this.openTextForm("create");
      return;
    }
    if (this.showAllCheckpoints && matchesKey(data, "down")) {
      this.checkpointOffset = Math.min(
        Math.max(0, this.checkpoints.length - 1),
        this.checkpointOffset + 1,
      );
      this.requestRender();
      return;
    }
    if (this.showAllCheckpoints && matchesKey(data, "up")) {
      this.checkpointOffset = Math.max(0, this.checkpointOffset - 1);
      this.requestRender();
      return;
    }
    if (this.confirmClose) {
      if (key === "x") this.onAction("closeGoal");
      else {
        this.confirmClose = false;
        this.requestRender();
      }
      return;
    }
    if (key === "e") this.openTextForm("edit");
    else if (key === "b" && this.goal.status !== "complete") this.openBudgetForm();
    else if (key === "s" && this.goal.status !== "complete") {
      this.mode = "snooze";
      this.inputError = undefined;
      this.requestRender();
    } else if (key === "h" && this.checkpoints.length > 3) {
      this.showAllCheckpoints = !this.showAllCheckpoints;
      this.checkpointOffset = 0;
      this.requestRender();
    } else if (key === "x") {
      this.confirmClose = true;
      this.requestRender();
    }
  }

  private openTextForm(mode: "create" | "edit"): void {
    this.mode = mode;
    this.textField = "name";
    this.name = mode === "edit" && this.goal ? (this.goal.name ?? this.goal.objective) : "";
    this.objective = mode === "edit" && this.goal ? this.goal.objective : "";
    this.initialName = this.name;
    this.initialObjective = this.objective;
    if (mode === "create") {
      this.budgetTurns = "";
      this.budgetRuntime = "";
    }
    this.inputError = undefined;
    this.requestRender();
  }

  private handleTextForm(data: string): void {
    if (matchesKey(data, "tab") || matchesKey(data, "down")) {
      const fields: TextField[] =
        this.mode === "create" ? ["name", "objective", "turns", "runtime"] : ["name", "objective"];
      this.textField = fields[(fields.indexOf(this.textField) + 1) % fields.length]!;
    } else if (matchesKey(data, "up")) {
      const fields: TextField[] =
        this.mode === "create" ? ["name", "objective", "turns", "runtime"] : ["name", "objective"];
      this.textField =
        fields[(fields.indexOf(this.textField) + fields.length - 1) % fields.length]!;
    } else if (matchesKey(data, "backspace")) {
      if (this.textField === "name") this.name = this.name.slice(0, -1);
      else if (this.textField === "objective") this.objective = this.objective.slice(0, -1);
      else if (this.textField === "turns") this.budgetTurns = this.budgetTurns.slice(0, -1);
      else this.budgetRuntime = this.budgetRuntime.slice(0, -1);
    } else if (matchesKey(data, "enter")) {
      const name = this.name.trim();
      const objective = this.objective.trim();
      const maxIterations = this.budgetTurns ? Number(this.budgetTurns) : undefined;
      const maxRuntimeMs = this.budgetRuntime ? parseDuration(this.budgetRuntime) : undefined;
      if (!name || !objective) this.inputError = "Name and objective are required";
      else if (
        maxIterations !== undefined &&
        (!Number.isInteger(maxIterations) || maxIterations <= 0)
      )
        this.inputError = "Turns must be a positive integer";
      else if (this.budgetRuntime && maxRuntimeMs === undefined)
        this.inputError = "Runtime must use m, h, or d";
      else if (this.mode === "create")
        this.onAction({ type: "create", name, objective, maxIterations, maxRuntimeMs });
      else {
        const update = {
          ...(this.name === this.initialName ? {} : { name }),
          ...(this.objective === this.initialObjective ? {} : { objective }),
        };
        if (update.name === undefined && update.objective === undefined)
          this.inputError = "Change the name or objective before saving";
        else this.onAction({ type: "edit", ...update });
      }
      this.requestRender();
      return;
    } else if (
      data.length > 0 &&
      Array.from(data).every((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code > 31 && code !== 127;
      })
    ) {
      if (this.textField === "name") this.name += data;
      else if (this.textField === "objective") this.objective += data;
      else if (this.textField === "turns" && /^\d+$/.test(data)) this.budgetTurns += data;
      else if (this.textField === "runtime" && /^[0-9mhd]+$/i.test(data))
        this.budgetRuntime += data;
      else return;
    } else return;
    this.inputError = undefined;
    this.requestRender();
  }

  private openBudgetForm(): void {
    this.mode = "budget";
    this.budgetField = "turns";
    this.budgetTurns = this.goal?.budget.maxIterations?.toString() ?? "";
    this.budgetRuntime = this.goal?.budget.maxRuntimeMs
      ? `${Math.round(this.goal.budget.maxRuntimeMs / 60_000)}m`
      : "";
    this.inputError = undefined;
    this.requestRender();
  }

  private handleBudgetForm(data: string): void {
    if (data.toLowerCase() === "o") {
      this.onAction({ type: "budget", disabled: true });
      return;
    }
    if (matchesKey(data, "tab") || matchesKey(data, "up") || matchesKey(data, "down")) {
      this.budgetField = this.budgetField === "turns" ? "runtime" : "turns";
    } else if (matchesKey(data, "backspace")) {
      if (this.budgetField === "turns") this.budgetTurns = this.budgetTurns.slice(0, -1);
      else this.budgetRuntime = this.budgetRuntime.slice(0, -1);
    } else if (matchesKey(data, "enter")) {
      const maxIterations = this.budgetTurns ? Number(this.budgetTurns) : undefined;
      const maxRuntimeMs = this.budgetRuntime ? parseDuration(this.budgetRuntime) : undefined;
      if (maxIterations !== undefined && (!Number.isInteger(maxIterations) || maxIterations <= 0))
        this.inputError = "Turns must be a positive integer";
      else if (this.budgetRuntime && maxRuntimeMs === undefined)
        this.inputError = "Runtime must use m, h, or d (for example 2h)";
      else if (maxIterations === undefined && maxRuntimeMs === undefined)
        this.inputError = "Set a limit or press o to turn limits off";
      else this.onAction({ type: "budget", maxIterations, maxRuntimeMs });
      this.requestRender();
      return;
    } else if (/^[0-9mhd]+$/i.test(data)) {
      if (this.budgetField === "turns" && /^\d+$/.test(data)) this.budgetTurns += data;
      else if (this.budgetField === "runtime") this.budgetRuntime += data;
      else return;
    } else return;
    this.inputError = undefined;
    this.requestRender();
  }

  private handleSnoozeForm(data: string): void {
    if (matchesKey(data, "backspace")) this.snoozeDuration = this.snoozeDuration.slice(0, -1);
    else if (matchesKey(data, "enter")) {
      const durationMs = parseDuration(this.snoozeDuration);
      if (durationMs === undefined) this.inputError = "Duration must use m, h, or d";
      else this.onAction({ type: "snooze", durationMs });
      this.requestRender();
      return;
    } else if (/^[0-9mhd]+$/i.test(data)) this.snoozeDuration += data;
    else return;
    this.inputError = undefined;
    this.requestRender();
  }

  render(width: number): string[] {
    if (width < 8) return [truncateToWidth("Goal", Math.max(0, width), "")];
    const innerWidth = width - 2;
    const contentWidth = Math.max(1, innerWidth - 2);
    const border = (text: string): string => this.theme.fg("borderAccent", text);
    const row = (content = ""): string => {
      const truncated = truncateToWidth(content, innerWidth, "", true);
      return `${border("│")}${truncated}${" ".repeat(Math.max(0, innerWidth - visibleWidth(truncated)))}${border("│")}`;
    };
    const title = this.theme.fg(
      "accent",
      this.theme.bold(` Goal${this.mode === "details" ? "" : ` · ${this.mode}`} `),
    );
    const lines = [
      `${border("╭")}${title}${border(`${"─".repeat(Math.max(0, innerWidth - visibleWidth(title)))}╮`)}`,
    ];
    if (!this.goal && this.mode === "details") {
      lines.push(row(), row(` ${this.theme.fg("muted", "No goal for this session.")}`));
      lines.push(row(` ${this.theme.fg("dim", "n · enter  create · esc close")}`));
      lines.push(border(`╰${"─".repeat(innerWidth)}╯`));
      return lines;
    }
    if (this.mode === "create" || this.mode === "edit") {
      const displayedName = displayGoalText(this.name, 500);
      const displayedObjective = displayGoalText(this.objective, 500);
      const objectivePrefix = ` ${this.textField === "objective" ? "›" : " "} Objective `;
      const objectiveLines = wrapTextWithAnsi(
        displayedObjective || "_",
        Math.max(1, innerWidth - visibleWidth(objectivePrefix)),
      ).slice(0, 4);
      lines.push(
        row(` ${this.textField === "name" ? "›" : " "} Name      ${displayedName || "_"}`),
        ...objectiveLines.map((line, index) =>
          row(
            `${index === 0 ? objectivePrefix : " ".repeat(visibleWidth(objectivePrefix))}${line}`,
          ),
        ),
        ...(this.mode === "create"
          ? [
              row(
                ` ${this.textField === "turns" ? "›" : " "} Turns     ${this.budgetTurns || "off"}`,
              ),
              row(
                ` ${this.textField === "runtime" ? "›" : " "} Runtime   ${this.budgetRuntime || "off"}`,
              ),
            ]
          : []),
        row(),
        row(` ${this.theme.fg("dim", "tab field · enter save · esc cancel")}`),
      );
      if (this.mode === "edit")
        lines.push(
          row(` ${this.theme.fg("warning", "Objective applies on the next continuation.")}`),
        );
      this.finish(lines, row, border, innerWidth);
      return lines;
    }
    if (this.mode === "budget") {
      lines.push(
        row(` › Limits are opt-in and stop continuation, not in-flight work.`),
        row(` ${this.budgetField === "turns" ? "›" : " "} Turns  ${this.budgetTurns || "off"}`),
        row(
          ` ${this.budgetField === "runtime" ? "›" : " "} Runtime ${this.budgetRuntime || "off"}`,
        ),
        row(),
        row(` ${this.theme.fg("dim", "tab field · enter save · o off · esc cancel")}`),
      );
      this.finish(lines, row, border, innerWidth);
      return lines;
    }
    if (this.mode === "snooze") {
      lines.push(
        row(` Snooze for ${this.snoozeDuration || "_"}`),
        row(
          ` ${this.theme.fg("dim", "Automatically continues when due · enter save · esc cancel")}`,
        ),
      );
      this.finish(lines, row, border, innerWidth);
      return lines;
    }

    const goal = this.goal!;
    const status = goal.snoozedUntil
      ? `SNOOZED UNTIL ${goal.snoozedUntil}`
      : goal.status.toUpperCase();
    lines.push(
      row(` ${this.theme.fg(goal.status === "complete" ? "success" : "accent", `● ${status}`)}`),
    );
    lines.push(row(` ${this.theme.bold(goalDisplayName(goal))}`));
    for (const objectiveLine of wrapTextWithAnsi(
      displayGoalText(goal.objective, 500),
      contentWidth,
    ).slice(0, 3))
      lines.push(row(` ${objectiveLine}`));
    const elapsedEnd = goal.status === "active" ? this.now() : Date.parse(goal.updatedAt);
    lines.push(
      row(
        ` ${this.theme.fg("muted", `Elapsed ${formatElapsed(elapsedEnd - Date.parse(goal.createdAt))}`)}`,
      ),
    );
    const limits = [
      goal.budget.maxIterations === undefined
        ? undefined
        : `${goal.usage.iterations}/${goal.budget.maxIterations} turns`,
      goal.budget.maxRuntimeMs === undefined
        ? undefined
        : `${Math.round(goal.budget.maxRuntimeMs / 60_000)}m runtime`,
    ].filter((value): value is string => value !== undefined);
    lines.push(
      row(` ${this.theme.fg("muted", `Limits ${limits.length ? limits.join(" · ") : "off"}`)}`),
    );
    if (this.claim)
      lines.push(row(` ${this.theme.fg("muted", `Continuation ${this.claim.state}`)}`));
    if (this.checkpoints.length) {
      lines.push(row(), row(` ${this.theme.fg("accent", "Checkpoints · agent-reported")}`));
      const shown = this.showAllCheckpoints
        ? this.checkpoints.slice(this.checkpointOffset, this.checkpointOffset + 3)
        : this.checkpoints.slice(0, 3);
      for (const checkpoint of shown) {
        lines.push(
          row(
            ` ${checkpoint.createdAt.slice(11, 16)} · ${displayGoalText(checkpoint.summary, contentWidth - 10)}`,
          ),
        );
        if (this.showAllCheckpoints && checkpoint.evidence)
          lines.push(
            row(`   evidence · ${displayGoalText(checkpoint.evidence, contentWidth - 14)}`),
          );
        if (this.showAllCheckpoints && (checkpoint.blocker || checkpoint.nextStep))
          lines.push(
            row(
              `   ${checkpoint.blocker ? "blocker" : "next"} · ${displayGoalText(checkpoint.blocker ?? checkpoint.nextStep ?? "", contentWidth - 11)}`,
            ),
          );
      }
      if (!this.showAllCheckpoints && this.checkpoints.length > 3)
        lines.push(
          row(` ${this.theme.fg("dim", `… and ${this.checkpoints.length - 3} more · h show all`)}`),
        );
      else if (this.showAllCheckpoints && this.checkpoints.length > 3)
        lines.push(
          row(
            ` ${this.theme.fg(
              "dim",
              `history ${this.checkpointOffset + 1}-${Math.min(
                this.checkpointOffset + shown.length,
                this.checkpoints.length,
              )}/${this.checkpoints.length} · ↑↓ scroll · h newest 3`,
            )}`,
          ),
        );
    }
    const footer = this.confirmClose
      ? "x again to close goal · esc cancel"
      : goal.status === "complete"
        ? "x close goal · esc close overlay"
        : "e edit · b limits · s snooze · x close goal · esc close overlay";
    lines.push(row(), row(` ${this.theme.fg("dim", footer)}`));
    this.finish(lines, row, border, innerWidth);
    return lines;
  }

  private finish(
    lines: string[],
    row: (content?: string) => string,
    border: (text: string) => string,
    innerWidth: number,
  ): void {
    const error = this.inputError ?? this.actionError;
    if (error)
      lines.push(row(` ${this.theme.fg("error", displayGoalText(error, innerWidth - 2))}`));
    lines.push(border(`╰${"─".repeat(innerWidth)}╯`));
  }

  invalidate(): void {}

  dispose(): void {
    if (!this.refreshTimer) return;
    clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
  }
}

export function parseDuration(value: string): number | undefined {
  const match = value
    .trim()
    .toLowerCase()
    .match(/^(\d+)(m|h|d)$/);
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount <= 0) return undefined;
  return amount * (match[2] === "m" ? 60_000 : match[2] === "h" ? 3_600_000 : 86_400_000);
}
