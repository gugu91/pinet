export function renderMarkdownForSlackMrkdwn(text: string): string {
  if (!text.includes("**")) {
    return text;
  }

  return transformOutsideBacktickCode(text, convertMarkdownStrongToSlackBold);
}

function transformOutsideBacktickCode(
  text: string,
  transform: (segment: string) => string,
): string {
  let output = "";
  let segmentStart = 0;
  let index = 0;

  while (index < text.length) {
    if (text[index] !== "`") {
      index += 1;
      continue;
    }

    const runLength = countRepeated(text, index, "`");
    const closingIndex = findClosingBacktickRun(text, index + runLength, runLength);
    if (closingIndex === -1) {
      index += runLength;
      continue;
    }

    output += transform(text.slice(segmentStart, index));
    output += text.slice(index, closingIndex + runLength);
    index = closingIndex + runLength;
    segmentStart = index;
  }

  output += transform(text.slice(segmentStart));
  return output;
}

function convertMarkdownStrongToSlackBold(segment: string): string {
  let output = "";
  let index = 0;

  while (index < segment.length) {
    if (segment.startsWith("**", index) && isStrongOpeningDelimiter(segment, index)) {
      const closingIndex = findStrongClosingDelimiter(segment, index + 2);
      if (closingIndex !== -1) {
        output += `*${segment.slice(index + 2, closingIndex)}*`;
        index = closingIndex + 2;
        continue;
      }
    }

    output += segment[index];
    index += 1;
  }

  return output;
}

function findStrongClosingDelimiter(segment: string, fromIndex: number): number {
  let index = fromIndex;
  while (index < segment.length) {
    const next = segment.indexOf("**", index);
    if (next === -1) {
      return -1;
    }
    if (isStrongClosingDelimiter(segment, next)) {
      return next;
    }
    index = next + 2;
  }

  return -1;
}

function isStrongOpeningDelimiter(text: string, index: number): boolean {
  if (isEscaped(text, index)) {
    return false;
  }

  const previous = text[index - 1];
  const next = text[index + 2];
  return isSafeOpeningBoundary(previous, next);
}

function isStrongClosingDelimiter(text: string, index: number): boolean {
  if (isEscaped(text, index)) {
    return false;
  }

  const previous = text[index - 1];
  const next = text[index + 2];
  return isSafeClosingBoundary(previous, next);
}

function isSafeOpeningBoundary(previous: string | undefined, next: string | undefined): boolean {
  if (!next || isWhitespace(next) || next === "*" || next === "/") {
    return false;
  }
  if (previous === "*" || previous === "/") {
    return false;
  }
  return true;
}

function isSafeClosingBoundary(previous: string | undefined, next: string | undefined): boolean {
  if (!previous || isWhitespace(previous) || previous === "*" || previous === "/") {
    return false;
  }
  if (next === "*" || next === "/") {
    return false;
  }
  return true;
}

function isWhitespace(value: string): boolean {
  return /\s/u.test(value);
}

function countRepeated(text: string, index: number, char: string): number {
  let count = 0;
  while (text[index + count] === char) {
    count += 1;
  }
  return count;
}

function findClosingBacktickRun(text: string, fromIndex: number, runLength: number): number {
  let index = fromIndex;
  while (index < text.length) {
    const next = text.indexOf("`", index);
    if (next === -1) {
      return -1;
    }

    const nextRunLength = countRepeated(text, next, "`");
    if (nextRunLength === runLength) {
      return next;
    }
    index = next + nextRunLength;
  }

  return -1;
}

function isEscaped(text: string, index: number): boolean {
  let slashCount = 0;
  let cursor = index - 1;
  while (cursor >= 0 && text[cursor] === "\\") {
    slashCount += 1;
    cursor -= 1;
  }
  return slashCount % 2 === 1;
}
