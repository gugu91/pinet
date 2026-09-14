export type Project = {
  id: string;
  markdown: string;
  externalChannel: string | null;
  createdAt: number;
  updatedAt: number;
};
export type Task = {
  id: string;
  projectId: string;
  markdown: string;
  createdAt: number;
  updatedAt: number;
};
export interface WorkStorage {
  putProject(value: Project): Project;
  getProject(id: string): Project | undefined;
  listProjects(limit: number, offset: number): Project[];
  deleteProject(id: string): boolean;
  putTask(value: Task): Task;
  getTask(id: string): Task | undefined;
  listTasks(projectId: string | undefined, limit: number, offset: number): Task[];
  deleteTask(id: string): boolean;
  search(query: string, limit: number, offset: number): { projects: Project[]; tasks: Task[] };
  close(): void;
}
