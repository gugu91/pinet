declare module "@earendil-works/pi-tui" {
  export interface Component {
    render(width: number): string[];
    handleInput?(data: string): void;
    invalidate(): void;
  }

  export function matchesKey(data: string, key: string): boolean;
  export function truncateToWidth(
    text: string,
    width: number,
    ellipsis?: string,
    pad?: boolean,
  ): string;
  export function visibleWidth(text: string): number;
  export function wrapTextWithAnsi(text: string, width: number): string[];

  export class Input implements Component {
    focused: boolean;
    getValue(): string;
    setValue(value: string): void;
    handleInput(data: string): void;
    render(width: number): string[];
    invalidate(): void;
  }

  export interface SelectItem {
    value: string;
    label: string;
    description?: string;
  }

  export class SelectList implements Component {
    constructor(
      items: SelectItem[],
      maxVisible: number,
      theme: {
        selectedPrefix(text: string): string;
        selectedText(text: string): string;
        description(text: string): string;
        scrollInfo(text: string): string;
        noMatch(text: string): string;
      },
    );
    getSelectedItem(): SelectItem | null;
    handleInput(data: string): void;
    render(width: number): string[];
    invalidate(): void;
  }

  export class Text {
    constructor(text: string, x: number, y: number);
  }
}
