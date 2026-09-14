export type ChatClientOptions = {
  baseUrl: string;
  token: string;
  agentId: string;
  fetch?: typeof fetch;
};
export class ChatClient {
  private readonly transport: typeof fetch;
  constructor(private readonly options: ChatClientOptions) {
    this.transport = options.fetch ?? fetch;
  }
  async call(method: string, path: string, body?: object): Promise<object> {
    const response = await this.transport(new URL(path, this.options.baseUrl), {
      method,
      headers: {
        authorization: `Bearer ${this.options.token}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const value: { data?: object | null; error?: { message: string } } =
      response.status === 204
        ? { data: null }
        : ((await response.json()) as { data?: object; error?: { message: string } });
    if (!response.ok)
      throw new Error(value.error?.message ?? `Chat request failed (${response.status})`);
    return value;
  }
}
