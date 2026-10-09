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

export class LinkWindowState {
  readonly input = new Input();
  selectedUrl?: string;
  readonly viewedUrls = new Set<string>();
}

export class LinkWindow implements Component {
  private readonly input: Input;
  private list: SelectList;
  private visibleItems = 5;
  private confirmRemove = false;
  private renderedWidth = Number.POSITIVE_INFINITY;

  constructor(
    private readonly links: GoalLink[],
    private readonly title: string,
    private readonly theme: Theme,
    private readonly done: (action: LinkWindowAction) => void,
    private readonly requestRender: () => void,
    query = "",
    private readonly error?: string,
    private readonly state = new LinkWindowState(),
    private readonly maxRows: () => number = () => 24,
  ) {
    this.input = state.input;
    if (this.input.getValue() !== query) this.input.setValue(query);
    this.list = this.createList(state.selectedUrl);
  }

  get focused(): boolean {
    return this.input.focused;
  }
  set focused(value: boolean) {
    this.input.focused = value;
  }

  private createList(selectedUrl?: string): SelectList {
    const filtered = filterLinks(this.links, this.input.getValue());
    const list = new SelectList(
      filtered.map((link) => ({
        value: link.url,
        label: displayGoalText(link.title, 200),
        description: new URL(link.url).hostname,
      })),
      this.visibleItems,
      {
        selectedPrefix: (text) => this.theme.fg("accent", text),
        selectedText: (text) => this.theme.fg("accent", this.theme.bold(text)),
        description: (text) => this.theme.fg("muted", text),
        scrollInfo: (text) => this.theme.fg("dim", text),
        noMatch: (text) => this.theme.fg("muted", text),
      },
    );
    const selectedIndex = filtered.findIndex((link) => link.url === selectedUrl);
    if (selectedIndex >= 0) list.setSelectedIndex(selectedIndex);
    return list;
  }

  handleInput(data: string): void {
    const tooSmall = this.maxRows() < 8 || this.renderedWidth < 8;
    if (
      matchesKey(data, "ctrl+c") ||
      (matchesKey(data, "escape") && (!this.confirmRemove || tooSmall))
    ) {
      this.done({ type: "close" });
      return;
    }
    if (tooSmall) {
      this.confirmRemove = false;
      return;
    }
    const selected = this.list.getSelectedItem();
    this.state.selectedUrl = selected?.value;
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
    this.state.selectedUrl = this.list.getSelectedItem()?.value;
    this.requestRender();
  }

  render(width: number): string[] {
    this.renderedWidth = width;
    if (width < 8) return [truncateToWidth("Links", Math.max(0, width), "")];
    const height = this.maxRows();
    if (height < 8) return [truncateToWidth("Enlarge pane to browse links · Esc close", width, "")];
    for (const link of filterLinks(this.links, this.input.getValue()))
      this.state.viewedUrls.add(link.url);
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
    // Reserve title/search, destination, action feedback, error and bottom border first.
    const detailRows = Math.min(6, Math.max(1, height - 8));
    const visibleItems = Math.max(1, Math.min(5, height - detailRows - 6 - (this.error ? 1 : 0)));
    if (visibleItems !== this.visibleItems) {
      const selectedUrl = this.list.getSelectedItem()?.value;
      this.visibleItems = visibleItems;
      this.list = this.createList(selectedUrl);
    }
    const lines = [
      `${border("╭")}${heading}${border(`${"─".repeat(Math.max(0, inner - visibleWidth(heading)))}╮`)}`,
      ...this.input.render(contentWidth).map((line) => row(` ${line}`)),
      ...this.list.render(contentWidth).map((line) => row(` ${line}`)),
    ];
    const details: string[] = [];
    const selected = this.links.find((link) => link.url === this.list.getSelectedItem()?.value);
    if (selected) {
      details.push(row(` ${this.theme.fg("accent", new URL(selected.url).hostname)}`));
      for (const line of wrapTextWithAnsi(selected.url, contentWidth).slice(0, 3))
        details.push(row(` ${this.theme.fg("muted", line)}`));
      if (selected.description)
        details.push(row(` ${displayGoalText(selected.description, contentWidth)}`));
      if (selected.goalName)
        details.push(
          row(
            ` ${this.theme.fg("dim", `Goal: ${displayGoalText(selected.goalName, contentWidth)}`)}`,
          ),
        );
    }
    lines.push(...details.slice(0, detailRows));
    lines.push(
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
