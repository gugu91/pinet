#!/usr/bin/env node
import { Journal } from "../dist/src/journal.js";
const [path, receiptId, receiptHash, mode] = process.argv.slice(2);
if (!path || !receiptId || !receiptHash) process.exit(2);
try {
  const result = new Journal(path).claim(receiptId, receiptHash, new Date().toISOString());
  process.stdout.write(result.inserted ? "inserted\n" : "existing\n");
  if (mode === "wait" && result.inserted) setInterval(() => {}, 1_000);
} catch (error) {
  process.stderr.write(error instanceof Error ? `${error.message}\n` : "error\n");
  process.exit(1);
}
