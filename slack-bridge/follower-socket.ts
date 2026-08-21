import { DEFAULT_SOCKET_PATH } from "./broker/client.js";

export function resolveFollowerBrokerSocketPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const configuredPath = env.PINET_SOCKET_PATH?.trim();
  return configuredPath && configuredPath.length > 0 ? configuredPath : DEFAULT_SOCKET_PATH;
}
