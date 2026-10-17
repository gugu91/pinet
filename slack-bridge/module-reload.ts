import * as nodeModule from "node:module";

// Pi loads extensions with jiti, which imports Pinet's built ES modules with
// Node's native import whenever it can. Node evaluates a native module once per
// URL for the life of the process, so /reload would re-run only the few files
// jiti compiles itself and keep the old copy of every other module, even after
// `pi update`. This hook is registered on the first load. Each later load of
// the entry gives every Pinet module a new URL, so Node evaluates the code on
// disk again.
const LOAD_PARAM = "pinet-load";
const SELF_URL = import.meta.url;
const ENTRY_URL = new URL("./index.js", import.meta.url).href;
// A Git install keeps every Pinet package in the repository; npm installs them as @pinet/*
// packages, hoisted or nested, among third-party dependencies that keep their one copy.
const REPOSITORY_URL = new URL("../../", import.meta.url).href;
const NODE_MODULES = "/node_modules/";

let reloadCount = 0;

// Pi binaries compiled with Bun may not provide registerHooks; they keep Node's cache.
if (typeof nodeModule.registerHooks === "function") {
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      const resolved = nextResolve(specifier, context);
      const { url } = resolved;
      const nodeModulesAt = url.lastIndexOf(NODE_MODULES);
      const pinetModule =
        nodeModulesAt === -1
          ? url.startsWith(REPOSITORY_URL)
          : url.startsWith("@pinet/", nodeModulesAt + NODE_MODULES.length);
      // This module stays loaded once, so the process keeps a single hook.
      if (url === SELF_URL || !pinetModule) return resolved;

      if (url === ENTRY_URL) reloadCount += 1;
      return reloadCount > 0
        ? { ...resolved, url: `${url}?${LOAD_PARAM}=${reloadCount}` }
        : resolved;
    },
  });
}
