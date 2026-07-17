/**
 * Pi extension entry for @pinet/sonar.
 *
 * Registers one command: /sonar — sweep the broker database and open the
 * rendered datasheet. The heavy lifting lives in snapshot.ts and render.ts;
 * this file is wiring only.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { readMeshSnapshot } from "./snapshot.ts";
import { renderSonarHtml } from "./render.ts";
import { getDefaultSweepOutputPath, openDetached, parseSonarArgs } from "./sonar-bin.ts";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("sonar", {
    description:
      "Sweep the Pinet broker database and open the mesh datasheet: /sonar [--db <path>] [--out <path>]",
    handler: async (args, ctx) => {
      const parsed = parseSonarArgs(args.trim().length > 0 ? args.trim().split(/\s+/) : []);
      if ("error" in parsed) {
        ctx.ui.notify(`sonar: ${parsed.error}`, "warning");
        return;
      }
      const options = parsed.options;
      const outPath = options.outPath || getDefaultSweepOutputPath();

      try {
        if (!fs.existsSync(options.dbPath)) {
          ctx.ui.notify(`sonar: broker database not found at ${options.dbPath}`, "warning");
          return;
        }
        const snapshot = readMeshSnapshot({ dbPath: options.dbPath });
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, renderSonarHtml(snapshot));

        openDetached(outPath);

        ctx.ui.notify(
          `Sonar sweep: ${snapshot.totals.agents} agents, ${snapshot.totals.lanes} lanes → ${outPath}`,
          "info",
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`sonar: sweep failed — ${message}`, "error");
      }
    },
  });
}
