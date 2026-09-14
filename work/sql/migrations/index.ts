import { initialMigration } from "./001-initial.js";

export type Migration = {
  version: number;
  sql: string;
};

export const migrations: readonly Migration[] = [{ version: 1, sql: initialMigration }];
