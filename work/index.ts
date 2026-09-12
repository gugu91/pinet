import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export * from "./domain.js";
export * from "./server.js";
export * from "./storage.js";
type Params = {
  action: string;
  id?: string;
  projectId?: string;
  markdown?: string;
  externalChannel?: string;
  query?: string;
};
export type WorkExtensionOptions = { baseUrl?: string; token?: string; fetch?: typeof fetch };
const help = {
  actions: {
    help: {},
    projects: {},
    project_get: { id: "string" },
    project_create: { markdown: "string", externalChannel: "string?" },
    project_update: {
      id: "string",
      markdown: "complete replacement Markdown",
      externalChannel: "string?",
    },
    project_delete: { id: "string" },
    tasks: { projectId: "string?" },
    task_get: { id: "string" },
    task_create: { projectId: "string", markdown: "string" },
    task_update: { id: "string", markdown: "complete replacement Markdown", projectId: "string?" },
    task_delete: { id: "string" },
    search: { query: "string" },
  },
};
export function registerWork(pi: ExtensionAPI, supplied: WorkExtensionOptions = {}) {
  const baseUrl = supplied.baseUrl ?? process.env.PINET_WORK_URL,
    token = supplied.token ?? process.env.PINET_WORK_TOKEN,
    transport = supplied.fetch ?? fetch;
  async function call(method: string, path: string, body?: object) {
    if (!baseUrl || !token) throw new Error("Set PINET_WORK_URL and PINET_WORK_TOKEN");
    const response = await transport(new URL(path, baseUrl), {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const value: { data?: object | null; error?: { message: string } } =
      response.status === 204
        ? { data: null }
        : ((await response.json()) as { data?: object; error?: { message: string } });
    if (!response.ok)
      throw new Error(value.error?.message ?? `Work request failed (${response.status})`);
    return value;
  }
  pi.registerTool({
    name: "pinet_work",
    label: "Pinet work",
    description:
      "Dispatch simple Markdown project/task CRUD and search. Call action=help for schemas. Updates are full replacement and last write wins.",
    promptSnippet: "Independent Markdown work dispatcher; use help for schemas.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string" },
        id: { type: "string" },
        projectId: { type: "string" },
        markdown: { type: "string" },
        externalChannel: { type: "string" },
        query: { type: "string" },
      },
      required: ["action"],
      additionalProperties: false,
    },
    async execute(_callId, raw) {
      const p = raw as Params;
      try {
        let value: object;
        switch (p.action) {
          case "help":
            value = help;
            break;
          case "projects":
            value = await call("GET", "/v1/projects");
            break;
          case "project_get":
            value = await call("GET", `/v1/projects/${need(p.id, "id")}`);
            break;
          case "project_create":
            value = await call("POST", "/v1/projects", {
              markdown: need(p.markdown, "markdown"),
              externalChannel: p.externalChannel,
            });
            break;
          case "project_update":
            value = await call("PUT", `/v1/projects/${need(p.id, "id")}`, {
              markdown: need(p.markdown, "markdown"),
              externalChannel: p.externalChannel,
            });
            break;
          case "project_delete":
            value = await call("DELETE", `/v1/projects/${need(p.id, "id")}`);
            break;
          case "tasks":
            value = await call(
              "GET",
              `/v1/tasks${p.projectId ? `?projectId=${encodeURIComponent(p.projectId)}` : ""}`,
            );
            break;
          case "task_get":
            value = await call("GET", `/v1/tasks/${need(p.id, "id")}`);
            break;
          case "task_create":
            value = await call("POST", "/v1/tasks", {
              projectId: need(p.projectId, "projectId"),
              markdown: need(p.markdown, "markdown"),
            });
            break;
          case "task_update":
            value = await call("PUT", `/v1/tasks/${need(p.id, "id")}`, {
              projectId: p.projectId,
              markdown: need(p.markdown, "markdown"),
            });
            break;
          case "task_delete":
            value = await call("DELETE", `/v1/tasks/${need(p.id, "id")}`);
            break;
          case "search":
            value = await call("GET", `/v1/search?q=${encodeURIComponent(need(p.query, "query"))}`);
            break;
          default:
            throw new Error("Unknown action; call help");
        }
        return {
          content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
          details: value,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: message }],
          details: { error: message },
          isError: true,
        };
      }
    },
  });
  pi.registerCommand("pinet-work", {
    description: "Show Pinet work configuration",
    handler: async (_args, ctx) =>
      ctx.ui.notify(
        baseUrl ? `Pinet work: ${baseUrl}` : "Pinet work is not configured",
        baseUrl ? "info" : "warning",
      ),
  });
}
function need(value: string | undefined, name: string) {
  if (!value) throw new Error(`${name} is required`);
  return value;
}
export default function work(pi: ExtensionAPI) {
  registerWork(pi);
}
