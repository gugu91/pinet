import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { assertPrivateTcpHost } from "./private-network.js";

export interface BrokerNetworkConfig {
  listenTarget: { type: "tcp"; host: string; port: number };
  privateNetwork: true;
}

/** Optional cold-start config. Changing the bind address requires a broker restart. */
export function readBrokerNetworkConfig(): BrokerNetworkConfig | undefined {
  const filename =
    process.env.PINET_BROKER_CONFIG ||
    path.join(os.homedir(), ".pi", "agent", "pinet", "broker.json");
  if (!fs.existsSync(filename)) return undefined;
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let config: Partial<BrokerNetworkConfig>;
  try {
    const stat = fs.fstatSync(fd);
    if (
      !stat.isFile() ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    ) {
      throw new Error("Pinet broker config must be an owner-only regular file (chmod 600).");
    }
    try {
      config = JSON.parse(fs.readFileSync(fd, "utf8")) as Partial<BrokerNetworkConfig>;
    } catch {
      throw new Error("Invalid JSON in Pinet broker config.");
    }
  } finally {
    fs.closeSync(fd);
  }
  if (
    !config ||
    config.privateNetwork !== true ||
    config.listenTarget?.type !== "tcp" ||
    typeof config.listenTarget.host !== "string" ||
    !Number.isInteger(config.listenTarget.port) ||
    config.listenTarget.port < 1 ||
    config.listenTarget.port > 65535
  )
    throw new Error("Invalid broker network config: require privateNetwork and a TCP host/port.");
  assertPrivateTcpHost(config.listenTarget.host, true);
  return { listenTarget: config.listenTarget, privateNetwork: true };
}
