import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { afterEach, test } from "vitest";
import { Tmux } from "./transport.ts";
import {
  HOOK,
  commandPaths,
  integration,
  install,
  installation,
  optionalFile,
  parseInstallation,
  preview,
  removeBlock,
  setupPaths,
  shellQuote,
  snapshot,
  uninstall,
  type Snapshot,
} from "./setup.ts";

const servers: Tmux[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.run(["kill-server"]);
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});
test("portable commands quote executable/package paths and preserve theme/status content", () => {
  const value = "/tmp/node ' $PATH (preview)";
  assert.equal(
    execFileSync("sh", ["-c", `printf %s ${shellQuote(value)}`], { encoding: "utf8" }),
    value,
  );
  assert.throws(() => shellQuote("bad\npath"));
  const commands = commandPaths("file:///tmp/pkg/setup.js", "/usr/bin/node");
  assert.ok(commands.status.includes("/tmp/pkg/status.js"));
  assert.ok(commands.rex.includes("/tmp/pkg/rex-cli.js"));
  const before: Snapshot = {
    "window-status-format": "#[fg=red] #I #W #F",
    "window-status-current-format": "#[bold] #I #{window_name}",
    "status-right": "#(continuum-save) #S #{?client_prefix,P,}",
    "focus-events": "off",
  };
  const plan = integration(before, setupPaths("/tmp/test"), commands);
  assert.ok(plan.applied["window-status-format"].startsWith("#[fg=red] #I "));
  assert.ok(plan.applied["window-status-format"].endsWith(" #F"));
  assert.ok(plan.applied["status-right"].endsWith(before["status-right"]));
  assert.equal(plan.applied["focus-events"], "on");
  assert.equal(parseInstallation(JSON.stringify(plan)).version, 1);
  assert.throws(() => parseInstallation("{}"));
  assert.throws(() => removeBlock("user content", plan.block));
});
test("isolated setup persists safely, re-source works with unusual paths, uninstall preserves user edits", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pinet-tmux-setup-"));
  directories.push(dir);
  const home = join(dir, "home ' $literal (space)");
  await mkdir(home);
  const paths = setupPaths(home);
  await writeFile(paths.config, "# User settings\nset-option -g status-interval 5\n");
  const tmux = new Tmux(join(dir, "socket"));
  await tmux.run(["-f", "/dev/null", "new-session", "-d", "-s", "test", "sleep 120"]);
  servers.push(tmux);
  await tmux.run(["set-hook", "-g", "pane-focus-in[123]", "display-message retained"]);
  const before = await snapshot(tmux);
  const plan = await preview(tmux, paths);
  await mkdir(dirname(paths.include), { recursive: true });
  await writeFile(paths.include, plan.include);
  await assert.rejects(() => install(tmux, paths, plan), /EEXIST/);
  assert.equal(
    await readFile(paths.include, "utf8"),
    plan.include,
    "rollback cannot delete a pre-existing include",
  );
  assert.equal(await optionalFile(paths.manifest), undefined);
  assert.deepEqual(await snapshot(tmux), before);
  await rm(paths.include);
  await install(tmux, paths, plan);
  assert.deepEqual(await snapshot(tmux), plan.applied);
  assert.ok((await tmux.run(["show-hooks", "-g", HOOK])).includes("@pi_rollup_ack"));
  await assert.rejects(() => preview(tmux, paths), /Already installed/);
  await tmux.run(["source-file", paths.config]);
  assert.deepEqual(await snapshot(tmux), plan.applied, "quoting survives persistent config reload");
  const saved = await installation(paths);
  assert.equal(saved?.config, paths.config);
  await writeFile(paths.config, (await readFile(paths.config, "utf8")) + "# Subsequent edit\n");
  await tmux.run(["set-option", "-g", "status-right", "user replacement"]);
  await uninstall(tmux, paths);
  const restored = await snapshot(tmux);
  assert.equal(restored["window-status-format"], before["window-status-format"]);
  assert.equal(restored["window-status-current-format"], before["window-status-current-format"]);
  assert.equal(restored["focus-events"], before["focus-events"]);
  assert.equal(restored["status-right"], "user replacement");
  assert.ok((await readFile(paths.config, "utf8")).includes("# Subsequent edit"));
  assert.equal(await optionalFile(paths.manifest), undefined);
  assert.ok((await tmux.run(["show-hooks", "-g", "pane-focus-in[123]"])).includes("retained"));
  assert.equal(await tmux.run(["show-hooks", "-g", HOOK]), HOOK);
  await uninstall(tmux, paths);
  const secondPlan = await preview(tmux, paths);
  await install(tmux, paths, secondPlan);
  await writeFile(paths.include, secondPlan.include + "# User edit\n");
  const beforeRefusal = await snapshot(tmux);
  await assert.rejects(() => uninstall(tmux, paths), /include was edited/);
  assert.deepEqual(await snapshot(tmux), beforeRefusal);
  await writeFile(paths.include, secondPlan.include);
  await tmux.run(["set-hook", "-g", HOOK, "set-option -p -F @pi_rollup_ack user-replacement"]);
  await uninstall(tmux, paths);
  assert.ok((await tmux.run(["show-hooks", "-g", HOOK])).includes("user-replacement"));
});
