import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@gugu910\/pi-broker-core$/,
        replacement: fileURLToPath(new URL("../broker-core/index.ts", import.meta.url)),
      },
      {
        find: /^@gugu910\/pi-broker-core\/(.+)$/,
        replacement: `${fileURLToPath(new URL("../broker-core/", import.meta.url))}$1.ts`,
      },
      {
        find: /^@gugu910\/pi-imessage-bridge$/,
        replacement: fileURLToPath(new URL("../imessage-bridge/index.ts", import.meta.url)),
      },
      {
        find: /^@gugu910\/pi-pinet-core$/,
        replacement: fileURLToPath(new URL("../pinet-core/index.ts", import.meta.url)),
      },
      {
        find: /^@gugu910\/pi-pinet-core\/(.+)$/,
        replacement: `${fileURLToPath(new URL("../pinet-core/", import.meta.url))}$1.ts`,
      },
      {
        find: /^@gugu910\/pi-transport-core$/,
        replacement: fileURLToPath(new URL("../transport-core/index.ts", import.meta.url)),
      },
      {
        find: /^@pinet\/broker-core$/,
        replacement: fileURLToPath(new URL("../broker-core/index.ts", import.meta.url)),
      },
      {
        find: /^@pinet\/broker-core\/(.+)$/,
        replacement: `${fileURLToPath(new URL("../broker-core/", import.meta.url))}$1.ts`,
      },
      {
        find: /^@pinet\/imessage-bridge$/,
        replacement: fileURLToPath(new URL("../imessage-bridge/index.ts", import.meta.url)),
      },
      {
        find: /^@pinet\/pinet-core$/,
        replacement: fileURLToPath(new URL("../pinet-core/index.ts", import.meta.url)),
      },
      {
        find: /^@pinet\/pinet-core\/(.+)$/,
        replacement: `${fileURLToPath(new URL("../pinet-core/", import.meta.url))}$1.ts`,
      },
      {
        find: /^@pinet\/transport-core$/,
        replacement: fileURLToPath(new URL("../transport-core/index.ts", import.meta.url)),
      },
    ],
  },
  test: {
    include: ["**/*.test.ts"],
  },
});
