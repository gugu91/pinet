import { runRelay } from "./rex.ts";
try {
  await runRelay(process.argv.slice(2));
} catch (error) {
  // Status jobs must remain invisible; explicit commands surface failures.
  if (process.argv[5] !== "tick")
    console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
