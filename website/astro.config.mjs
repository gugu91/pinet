// @ts-check
import { defineConfig } from "astro/config";

// Set `site` (and `base` if deploying under a sub-path, e.g. GitHub Pages
// project sites) before wiring up a deployment.
export default defineConfig({
  trailingSlash: "ignore",
});
