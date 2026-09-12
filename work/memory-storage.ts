import type { Project, Task, WorkStorage } from "./domain.js";

export class MemoryWorkStorage implements WorkStorage {
  protected projects = new Map<string, Project>();
  protected tasks = new Map<string, Task>();
  putProject(value: Project): Project {
    this.projects.set(value.id, value);
    return value;
  }
  getProject(id: string): Project | undefined {
    return this.projects.get(id);
  }
  listProjects(limit: number, offset: number): Project[] {
    return [...this.projects.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(offset, offset + limit);
  }
  deleteProject(id: string): boolean {
    const deleted = this.projects.delete(id);
    if (deleted)
      for (const [taskId, task] of this.tasks) if (task.projectId === id) this.tasks.delete(taskId);
    return deleted;
  }
  putTask(value: Task): Task {
    if (!this.projects.has(value.projectId)) throw new Error("project not found");
    this.tasks.set(value.id, value);
    return value;
  }
  getTask(id: string): Task | undefined {
    return this.tasks.get(id);
  }
  listTasks(projectId: string | undefined, limit: number, offset: number): Task[] {
    return [...this.tasks.values()]
      .filter((row) => !projectId || row.projectId === projectId)
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(offset, offset + limit);
  }
  deleteTask(id: string): boolean {
    return this.tasks.delete(id);
  }
  search(query: string, limit: number, offset: number) {
    const needle = query.toLowerCase();
    const combined = [
      ...[...this.projects.values()].map((value) => ({ kind: "project" as const, value })),
      ...[...this.tasks.values()].map((value) => ({ kind: "task" as const, value })),
    ]
      .filter((row) => row.value.markdown.toLowerCase().includes(needle))
      .sort((left, right) =>
        left.value.createdAt === right.value.createdAt
          ? left.value.id.localeCompare(right.value.id)
          : left.value.createdAt - right.value.createdAt,
      )
      .slice(offset, offset + limit);
    return {
      projects: combined.flatMap((row) => (row.kind === "project" ? [row.value] : [])),
      tasks: combined.flatMap((row) => (row.kind === "task" ? [row.value] : [])),
    };
  }
  close(): void {}
}
