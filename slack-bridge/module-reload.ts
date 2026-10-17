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
// The repository for Git installs, or the npm scope directory for npm installs.
const SCOPE_URL = new URL("../../", import.meta.url).href;

let reloadCount = 0;

// Pi binaries compiled with Bun may not provide registerHooks; they keep Node's cache.
if (typeof nodeModule.registerHooks === "function") {
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      const resolved = nextResolve(specifier, context);
      const { url } = resolved;
      // This module stays loaded once, so the process keeps a single hook.
      if (
        url === SELF_URL ||
        !url.startsWith(SCOPE_URL) ||
        url.includes("/node_modules/", SCOPE_URL.length - 1)
      ) {
        return resolved;
      }

      if (url === ENTRY_URL) reloadCount += 1;
      return reloadCount > 0
        ? { ...resolved, url: `${url}?${LOAD_PARAM}=${reloadCount}` }
        : resolved;
    },
  });
}
