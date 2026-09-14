export function chatDaemonAddress(environment: NodeJS.ProcessEnv = process.env): {
  hostname: string;
  port: number;
} {
  return {
    hostname: environment.PINET_CHAT_HOST ?? "127.0.0.1",
    port: Number(environment.PORT ?? 8787),
  };
}
