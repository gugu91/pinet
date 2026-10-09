import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Input,
  SelectList,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";
import { displayGoalText } from "./dashboard.js";
import type { GoalLink } from "./domain.js";
import { filterLinks } from "./link-helpers.js";

export type LinkWindowAction =
  | { type: "close" }
  | { type: "open" | "remove"; url: string; query: string };

export class LinkWindow implements Component {
  private readonly input = new Input();
  private list: SelectList;
  private confirmRemove = false;

  constructor(
    private readonly links: GoalLink[],
    private readonly title: string,
    private readonly theme: Theme,
    private readonly done: (action: LinkWindowAction) => void,
    private readonly requestRender: () => void,
    query = "",
    private readonly error?: string,
  ) {
    this.input.setValue(query);
    this.list = this.createList();
  }

  get focused(): boolean {
    return this.input.focused;
  }
  set focused(value: boolean) {
    this.input.focused = value;
  }

  private createList(): SelectList {
    return new SelectList(
      filterLinks(this.links, this.input.getValue()).map((link) => ({
        value: link.url,
        label: displayGoalText(link.title, 200),
        description: new URL(link.url).hostname,
      })),
      5,
      {
        selectedPrefix: (text) => this.theme.fg("accent", text),
        selectedText: (text) => this.theme.fg("accent", this.theme.bold(text)),
        description: (text) => this.theme.fg("muted", text),
        scrollInfo: (text) => this.theme.fg("dim", text),
        noMatch: (text) => this.theme.fg("muted", text),
      },
    );
  }

  handleInput(data: string): void {
    if (matchesKey(data, "ctrl+c") || (matchesKey(data, "escape") && !this.confirmRemove)) {
      this.done({ type: "close" });
      return;
    }
    const selected = this.list.getSelectedItem();
    if (this.confirmRemove) {
      if (matchesKey(data, "enter") && selected)
        this.done({ type: "remove", url: selected.value, query: this.input.getValue() });
      this.confirmRemove = false;
    } else if (matchesKey(data, "enter") && selected) {
      this.done({ type: "open", url: selected.value, query: this.input.getValue() });
    } else if (matchesKey(data, "ctrl+d") && selected) {
      this.confirmRemove = true;
    } else if (matchesKey(data, "up") || matchesKey(data, "down")) {
      this.list.handleInput(data);
    } else {
      const previous = this.input.getValue();
      this.input.handleInput(data);
      if (previous !== this.input.getValue()) this.list = this.createList();
    }
    this.requestRender();
  }

  render(width: number): string[] {
    if (width < 8) return [truncateToWidth("Links", Math.max(0, width), "")];
    const inner = width - 2;
    const contentWidth = Math.max(1, inner - 2);
    const border = (text: string): string => this.theme.fg("borderAccent", text);
    const row = (text = ""): string => {
      const clipped = truncateToWidth(text, inner, "", true);
      return `${border("│")}${clipped}${" ".repeat(Math.max(0, inner - visibleWidth(clipped)))}${border("│")}`;
    };
    const heading = truncateToWidth(
      this.theme.fg("accent", this.theme.bold(` ${this.title} · ${this.links.length} saved `)),
      inner,
      "",
    );
    const lines = [
      `${border("╭")}${heading}${border(`${"─".repeat(Math.max(0, inner - visibleWidth(heading)))}╮`)}`,
      row(` ${this.theme.fg("muted", "Search titles, URLs, descriptions, goals")}`),
      ...this.input.render(contentWidth).map((line) => row(` ${line}`)),
      row(),
      ...this.list.render(contentWidth).map((line) => row(` ${line}`)),
    ];
    const selected = this.links.find((link) => link.url === this.list.getSelectedItem()?.value);
    if (selected) {
      lines.push(row(), row(` ${this.theme.fg("accent", new URL(selected.url).hostname)}`));
      for (const line of wrapTextWithAnsi(selected.url, contentWidth).slice(0, 3))
        lines.push(row(` ${this.theme.fg("muted", line)}`));
      if (selected.description)
        lines.push(row(` ${displayGoalText(selected.description, contentWidth)}`));
      if (selected.goalName)
        lines.push(
          row(
            ` ${this.theme.fg("dim", `Goal: ${displayGoalText(selected.goalName, contentWidth)}`)}`,
          ),
        );
    }
    lines.push(
      row(),
      row(
        this.confirmRemove
          ? " Enter remove saved link · Esc cancel"
          : " ↑↓ select · Enter open · Ctrl+D remove · Esc close",
      ),
    );
    if (this.error)
      lines.push(row(` ${this.theme.fg("error", displayGoalText(this.error, contentWidth))}`));
    lines.push(border(`╰${"─".repeat(inner)}╯`));
    return lines;
  }

  invalidate(): void {
    this.input.invalidate();
    this.list.invalidate();
  }
}
