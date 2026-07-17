import { appendFileSync, openSync, closeSync, fsyncSync } from "node:fs";
import type { ExecutionStatus } from "./contracts.js";
export class JsonlAudit {
  constructor(private readonly path: string) {}
  write(record: {
    receiptId: string;
    receiptHash: string;
    state: ExecutionStatus["state"];
    at: string;
    errorCode?: string;
  }): void {
    appendFileSync(this.path, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
    const fd = openSync(this.path, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}
