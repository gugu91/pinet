#!/usr/bin/env node
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const docsDir = path.join(repoRoot, "docs");
const siteDir = path.join(docsDir, "_site");
const checkOnly = process.argv.includes("--check");

const pages = [
  { file: "index.md", title: "Start" },
  { file: "setup.md", title: "Set up Pinet" },
  { file: "configuration.md", title: "Configure Pinet" },
  { file: "usage.md", title: "Use Pinet" },
  { file: "architecture.md", title: "Architecture" },
  { file: "troubleshooting.md", title: "Troubleshooting" },
  { file: "reference.md", title: "Reference" },
];

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function inlineMarkdown(value) {
  let html = escapeHtml(value);
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, href) => {
    const [pathPart, anchorPart] = href.split("#", 2);
    const rewrittenPath = pathPart.endsWith(".md") ? pathPart.replace(/\.md$/, ".html") : pathPart;
    const target = anchorPart === undefined ? rewrittenPath : `${rewrittenPath}#${anchorPart}`;
    return `<a href="${escapeHtml(target)}">${label}</a>`;
  });
  return html;
}

function stripFrontmatter(markdown) {
  if (!markdown.startsWith("---\n")) return markdown;
  const end = markdown.indexOf("\n---\n", 4);
  return end === -1 ? markdown : markdown.slice(end + 5);
}

function markdownToHtml(markdown) {
  const lines = stripFrontmatter(markdown).split(/\r?\n/);
  const out = [];
  let paragraph = [];
  let list = null;
  let table = null;
  let code = null;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    out.push(`<p>${inlineMarkdown(paragraph.join(" "))}</p>`);
    paragraph = [];
  };

  const flushList = () => {
    if (!list) return;
    out.push(`<${list.type}>`);
    for (const item of list.items) out.push(`<li>${inlineMarkdown(item)}</li>`);
    out.push(`</${list.type}>`);
    list = null;
  };

  const renderRow = (row, cellTag) =>
    `<tr>${row.map((cell) => `<${cellTag}>${inlineMarkdown(cell)}</${cellTag}>`).join("")}</tr>`;

  const flushTable = () => {
    if (!table) return;
    out.push("<table>");
    if (table.hasHeader && table.rows.length > 0) {
      out.push("<thead>");
      out.push(renderRow(table.rows[0], "th"));
      out.push("</thead>");
      out.push("<tbody>");
      for (const row of table.rows.slice(1)) out.push(renderRow(row, "td"));
      out.push("</tbody>");
    } else {
      out.push("<tbody>");
      for (const row of table.rows) out.push(renderRow(row, "td"));
      out.push("</tbody>");
    }
    out.push("</table>");
    table = null;
  };

  for (const line of lines) {
    if (code) {
      if (line.startsWith("```")) {
        out.push(`<pre><code>${escapeHtml(code.lines.join("\n"))}</code></pre>`);
        code = null;
      } else {
        code.lines.push(line);
      }
      continue;
    }

    if (line.startsWith("```")) {
      flushParagraph();
      flushList();
      code = { lines: [] };
      continue;
    }

    if (line.trim() === "") {
      flushParagraph();
      flushList();
      flushTable();
      continue;
    }

    const tableSeparator = line.match(/^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/);
    if (tableSeparator && table) {
      table.hasHeader = true;
      continue;
    }

    if (line.trim().startsWith("|")) {
      flushParagraph();
      flushList();
      const row = line
        .trim()
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((cell) => cell.trim());
      table ??= { rows: [], hasHeader: false };
      table.rows.push(row);
      continue;
    }

    flushTable();

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      flushTable();
      const level = heading[1].length;
      const text = heading[2].trim();
      const id = text
        .toLowerCase()
        .replace(/`/g, "")
        .replace(/[^a-z0-9\s-]/g, "")
        .trim()
        .replace(/\s+/g, "-");
      out.push(`<h${level} id="${id}">${inlineMarkdown(text)}</h${level}>`);
      continue;
    }

    const unordered = line.match(/^[-*]\s+(.+)$/);
    if (unordered) {
      flushParagraph();
      flushTable();
      if (!list || list.type !== "ul") {
        flushList();
        list = { type: "ul", items: [] };
      }
      list.items.push(unordered[1]);
      continue;
    }

    const ordered = line.match(/^\d+\.\s+(.+)$/);
    if (ordered) {
      flushParagraph();
      flushTable();
      if (!list || list.type !== "ol") {
        flushList();
        list = { type: "ol", items: [] };
      }
      list.items.push(ordered[1]);
      continue;
    }

    paragraph.push(line.trim());
  }

  flushParagraph();
  flushList();
  flushTable();
  return out.join("\n");
}

function logoSvg() {
  return `<svg class="pinet-logo" viewBox="0 0 800 800" aria-hidden="true" focusable="false"><path fill="currentColor" d="M120 120h360v120H240v120h240v120H240v200H120z"></path><path fill="currentColor" d="M520 320h160v360H520z"></path><path fill="currentColor" d="M360 520h120v160H360z"></path></svg>`;
}

function siteStyles() {
  return `<style>
    :root {
      color-scheme: dark light;
      --bg: #08090d;
      --bg-2: #0f1118;
      --panel: rgba(18, 21, 31, 0.86);
      --panel-strong: #141823;
      --text: #f4f1e8;
      --muted: #aeb5c2;
      --line: rgba(244, 241, 232, 0.16);
      --accent: #d9ff4a;
      --accent-2: #8cf7ff;
      --shadow: rgba(0, 0, 0, 0.34);
      --code-bg: #05060a;
      --max: 72rem;
    }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body {
      background:
        radial-gradient(circle at 15% 8%, rgba(217, 255, 74, 0.14), transparent 30rem),
        radial-gradient(circle at 88% 18%, rgba(140, 247, 255, 0.13), transparent 34rem),
        linear-gradient(180deg, var(--bg), var(--bg-2) 42rem, var(--bg));
      color: var(--text);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 18px;
      line-height: 1.6;
      margin: 0;
      min-height: 100vh;
    }
    body::before {
      background-image: linear-gradient(rgba(244, 241, 232, 0.035) 1px, transparent 1px), linear-gradient(90deg, rgba(244, 241, 232, 0.035) 1px, transparent 1px);
      background-size: 48px 48px;
      content: "";
      inset: 0;
      pointer-events: none;
      position: fixed;
      mask-image: linear-gradient(to bottom, black, transparent 75%);
    }
    a { color: var(--accent-2); text-decoration-thickness: 0.08em; text-underline-offset: 0.18em; }
    a:hover { color: var(--accent); }
    .skip-link { background: var(--accent); color: #08090d; left: 1rem; padding: .6rem .9rem; position: absolute; top: -4rem; z-index: 5; }
    .skip-link:focus { top: 1rem; }
    .site-nav {
      backdrop-filter: blur(18px);
      background: rgba(8, 9, 13, 0.72);
      border-bottom: 1px solid var(--line);
      position: sticky;
      top: 0;
      z-index: 4;
    }
    .site-nav-inner { align-items: center; display: flex; gap: 1rem; justify-content: space-between; margin: 0 auto; max-width: var(--max); padding: .85rem 1rem; }
    .brand { align-items: center; color: var(--text); display: inline-flex; font-weight: 800; gap: .65rem; letter-spacing: -.03em; text-decoration: none; }
    .pinet-logo { height: 2rem; width: 2rem; }
    .nav-links { align-items: center; display: flex; flex-wrap: wrap; gap: .7rem; justify-content: flex-end; }
    .nav-links a { border: 1px solid transparent; border-radius: 999px; color: var(--muted); font-size: .9rem; padding: .3rem .62rem; text-decoration: none; }
    .nav-links a:hover, .nav-links a[aria-current="page"] { border-color: var(--line); color: var(--text); }
    .hero { margin: 0 auto; max-width: var(--max); padding: 5.5rem 1rem 3rem; text-align: center; }
    .hero-mark { color: var(--accent); display: inline-block; filter: drop-shadow(0 1rem 2.5rem rgba(217, 255, 74, .18)); margin-bottom: 1.5rem; transform: rotate(-2deg); }
    .hero-mark .pinet-logo { height: clamp(5rem, 14vw, 9rem); width: clamp(5rem, 14vw, 9rem); }
    .eyebrow { color: var(--accent); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .82rem; letter-spacing: .16em; text-transform: uppercase; }
    .hero h1 { font-size: clamp(3rem, 9vw, 7.8rem); letter-spacing: -.09em; line-height: .9; margin: .5rem 0 1rem; }
    .hero h1 span { color: var(--accent); }
    .hero-copy { color: var(--muted); font-size: clamp(1.15rem, 2vw, 1.45rem); margin: 0 auto; max-width: 48rem; }
    .hero-actions { display: flex; flex-wrap: wrap; gap: .8rem; justify-content: center; margin-top: 1.8rem; }
    .button { border: 1px solid var(--line); border-radius: 999px; color: var(--text); display: inline-flex; font-weight: 750; padding: .78rem 1.05rem; text-decoration: none; }
    .button--primary { background: var(--accent); border-color: var(--accent); color: #08090d; }
    .install-panel { margin: 2rem auto 0; max-width: 48rem; }
    .terminal { background: var(--code-bg); border: 1px solid var(--line); border-radius: 1.2rem; box-shadow: 0 1.8rem 4rem var(--shadow); overflow: hidden; text-align: left; }
    .terminal-bar { align-items: center; border-bottom: 1px solid var(--line); color: var(--muted); display: flex; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .78rem; justify-content: space-between; padding: .6rem .8rem; }
    .dots { display: inline-flex; gap: .35rem; }
    .dots span { background: var(--accent); border-radius: 50%; display: inline-block; height: .55rem; width: .55rem; }
    .terminal pre { margin: 0; padding: 1rem; white-space: pre-wrap; }
    code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    code { background: rgba(244, 241, 232, .1); border-radius: .25rem; padding: .08rem .25rem; }
    pre code { background: transparent; padding: 0; }
    .section-wrap { margin: 0 auto; max-width: var(--max); padding: 2rem 1rem; }
    .story-grid { display: grid; gap: 1rem; grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 1.35rem; box-shadow: 0 1.25rem 3rem var(--shadow); padding: 1.2rem; position: relative; }
    .panel::before, .panel::after { border-color: var(--accent); border-style: solid; content: ""; height: .8rem; opacity: .75; position: absolute; width: .8rem; }
    .panel::before { border-width: 1px 0 0 1px; left: .7rem; top: .7rem; }
    .panel::after { border-width: 0 1px 1px 0; bottom: .7rem; right: .7rem; }
    .panel h2, .panel h3 { letter-spacing: -.04em; line-height: 1.05; margin: 0 0 .55rem; }
    .panel p { color: var(--muted); margin-bottom: 0; }
    .docs-layout { display: grid; gap: 2rem; grid-template-columns: minmax(12rem, 16rem) minmax(0, 45rem); margin: 0 auto; max-width: var(--max); padding: 3rem 1rem; }
    .docs-sidebar { align-self: start; background: rgba(8, 9, 13, .64); border: 1px solid var(--line); border-radius: 1rem; padding: .85rem; position: sticky; top: 5.2rem; }
    .docs-sidebar a { border-radius: .65rem; color: var(--muted); display: block; padding: .4rem .55rem; text-decoration: none; }
    .docs-sidebar a:hover, .docs-sidebar a[aria-current="page"] { background: rgba(244, 241, 232, .08); color: var(--text); }
    .docs-main { min-width: 0; }
    .docs-card { background: rgba(18, 21, 31, .78); border: 1px solid var(--line); border-radius: 1.25rem; padding: clamp(1.2rem, 4vw, 2.2rem); }
    .docs-card h1 { font-size: clamp(2.4rem, 6vw, 4.8rem); letter-spacing: -.07em; line-height: .95; margin-top: 0; }
    .docs-card h2 { border-top: 1px solid var(--line); font-size: clamp(1.7rem, 3vw, 2.5rem); letter-spacing: -.05em; line-height: 1.05; margin-top: 2.2rem; padding-top: 1.4rem; }
    .docs-card h3 { font-size: 1.35rem; margin-top: 1.6rem; }
    .docs-card p, .docs-card li { color: var(--muted); }
    .docs-card pre { background: var(--code-bg); border: 1px solid var(--line); border-radius: .9rem; overflow-x: auto; padding: 1rem; }
    .docs-card table { border-collapse: collapse; display: block; overflow-x: auto; width: 100%; }
    .docs-card th, .docs-card td { border: 1px solid var(--line); padding: .55rem; text-align: left; }
    .site-footer { border-top: 1px solid var(--line); color: var(--muted); margin-top: 3rem; padding: 2rem 1rem; text-align: center; }
    @media (max-width: 52rem) {
      .site-nav-inner { align-items: flex-start; flex-direction: column; }
      .nav-links { justify-content: flex-start; }
      .story-grid, .docs-layout { display: block; }
      .panel { margin-bottom: 1rem; }
      .docs-sidebar { margin-bottom: 1rem; position: static; }
    }
  </style>`;
}

function navLinks(currentFile) {
  return pages
    .map((page) => {
      const href = page.file.replace(/\.md$/, ".html");
      const current = page.file === currentFile ? ' aria-current="page"' : "";
      return `<a href="${href}"${current}>${page.title}</a>`;
    })
    .join("\n");
}

function topNav(currentFile) {
  return `<nav class="site-nav" aria-label="Primary">
    <div class="site-nav-inner">
      <a class="brand" href="index.html">${logoSvg()}<span>Pinet</span></a>
      <div class="nav-links">
        ${navLinks(currentFile)}
        <a href="https://github.com/gugu91/extensions">GitHub</a>
      </div>
    </div>
  </nav>`;
}

function landingPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Pinet - Slack control for Pi agents</title>
  ${siteStyles()}
</head>
<body>
  <a class="skip-link" href="#main">Skip to main content</a>
  ${topNav("index.md")}
  <main id="main">
    <header class="hero">
      <div class="hero-mark">${logoSvg()}</div>
      <p class="eyebrow">Slack bridge for Pi</p>
      <h1>Coordinate agents from <span>Slack</span></h1>
      <p class="hero-copy">Pinet connects pi coding agents to Slack, routes work between workers, and keeps the thread readable while the work happens.</p>
      <div class="hero-actions">
        <a class="button button--primary" href="setup.html">Set up Pinet</a>
        <a class="button" href="usage.html">Use Pinet</a>
        <a class="button" href="reference.html">Read the reference</a>
      </div>
      <div class="install-panel">
        <div class="terminal" aria-label="Example Pinet commands">
          <div class="terminal-bar"><span class="dots"><span></span><span></span><span></span></span><span>pinet session</span></div>
          <pre><code>$ /pinet start
$ /pinet agents list all
$ /pinet follow</code></pre>
        </div>
      </div>
    </header>
    <section class="section-wrap" aria-labelledby="why-pinet">
      <div class="story-grid">
        <article class="panel">
          <h2 id="why-pinet">Work in threads</h2>
          <p>Slack messages become agent tasks. Replies, blockers, and outcomes stay in the thread where the work started.</p>
        </article>
        <article class="panel">
          <h2>Coordinate workers</h2>
          <p>A broker can see available agents, assign work, and recover when a worker gets stuck.</p>
        </article>
        <article class="panel">
          <h2>Keep control</h2>
          <p>Pinet is off by default. Enable it explicitly and use allowlists plus guardrails for sensitive Slack actions.</p>
        </article>
      </div>
    </section>
    <section class="section-wrap" aria-labelledby="docs-title">
      <article class="panel">
        <p class="eyebrow">Documentation</p>
        <h2 id="docs-title">Start with setup, then tune access</h2>
        <p>Use the setup guide to configure Slack, then review configuration and usage before connecting production agents.</p>
        <div class="hero-actions">
          <a class="button button--primary" href="setup.html">Setup guide</a>
          <a class="button" href="configuration.html">Configuration</a>
          <a class="button" href="troubleshooting.html">Troubleshooting</a>
        </div>
      </article>
    </section>
  </main>
  <footer class="site-footer">Pinet is part of the extensions workspace for Pi.</footer>
</body>
</html>`;
}

function pageTemplate(page, body) {
  const nav = navLinks(page.file);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(page.title)} - Pinet documentation</title>
  ${siteStyles()}
</head>
<body>
  <a class="skip-link" href="#main">Skip to main content</a>
  ${topNav(page.file)}
  <div class="docs-layout">
    <aside class="docs-sidebar" aria-label="Documentation navigation">${nav}</aside>
    <main class="docs-main" id="main">
      <article class="docs-card">${body}</article>
    </main>
  </div>
  <footer class="site-footer">Pinet documentation. Deployment is disabled until a maintainer enables GitHub Pages.</footer>
</body>
</html>
`;
}

async function validateInputs() {
  const missing = pages.filter((page) => !existsSync(path.join(docsDir, page.file)));
  if (missing.length > 0) {
    throw new Error(`Missing documentation files: ${missing.map((page) => page.file).join(", ")}`);
  }
}

async function validateLinks() {
  const markdownFiles = (await readdir(docsDir)).filter((file) => file.endsWith(".md"));
  const known = new Set(markdownFiles);
  for (const file of markdownFiles) {
    const markdown = await readFile(path.join(docsDir, file), "utf8");
    for (const match of markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const href = match[1];
      if (/^(https?:|mailto:|#)/.test(href)) continue;
      const target = href.split("#")[0];
      if (target === "") continue;
      if (!known.has(target)) throw new Error(`Broken internal link in ${file}: ${href}`);
    }
  }
}

await validateInputs();
await validateLinks();

if (!checkOnly) await rm(siteDir, { recursive: true, force: true });
await mkdir(siteDir, { recursive: true });

for (const page of pages) {
  const markdown = await readFile(path.join(docsDir, page.file), "utf8");
  const html =
    page.file === "index.md" ? landingPage() : pageTemplate(page, markdownToHtml(markdown));
  await writeFile(path.join(siteDir, page.file.replace(/\.md$/, ".html")), html);
}

console.log(`Built Pinet documentation site in ${path.relative(repoRoot, siteDir)}`);
