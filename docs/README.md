# Pinet documentation site

This directory contains the source for the Pinet documentation site.

The site uses Markdown source files and a small Node.js build script. It does not need Ruby, Jekyll, or extra npm packages.

## Structure

- `index.md` - start page
- `setup.md` - installation and setup guide
- `configuration.md` - configuration options
- `usage.md` - how to use Pinet
- `architecture.md` - system design and internals
- `troubleshooting.md` - common problems and fixes
- `reference.md` - tool and action reference
- `_site/` - generated HTML output, not committed

## Preview locally

Build and serve the site:

```bash
pnpm docs:serve
```

Open http://localhost:4000.

## Check the site

Run:

```bash
pnpm docs:check
```

This checks that required pages exist, internal links resolve, and the static site can be generated.

## Deploy to GitHub Pages

The site is ready for GitHub Pages, but deployment is disabled until a maintainer approves it.

To enable deployment:

1. Rename `.github/workflows/deploy-docs.yml.disabled` to `.github/workflows/deploy-docs.yml`.
2. Go to Settings → Pages in the GitHub repository.
3. Set Source to 'GitHub Actions'.
4. Commit and push the workflow change.

The workflow will deploy `docs/_site` to GitHub Pages.

## Documentation style

Follow GOV.UK style:

- use plain English
- write in the active voice
- keep sentences short
- use sentence case for headings
- avoid unnecessary jargon
- do not use bold or italics for emphasis

See `.pi/skills/govuk-style/` for the full style guide used for this rewrite.
