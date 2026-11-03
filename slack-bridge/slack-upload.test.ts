import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chooseSlackSnippetType,
  inferSlackUploadFiletype,
  performSlackUpload,
  prepareSlackUpload,
  resolveSlackUploadPath,
} from "./slack-upload.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("inferSlackUploadFiletype", () => {
  it("normalizes common extensions", () => {
    expect(inferSlackUploadFiletype("report.ts")).toBe("typescript");
    expect(inferSlackUploadFiletype("config.yml")).toBe("yaml");
    expect(inferSlackUploadFiletype("script.sh")).toBe("shell");
  });

  it("prefers an explicit filetype", () => {
    expect(inferSlackUploadFiletype("report.txt", "diff")).toBe("diff");
  });
});

describe("chooseSlackSnippetType", () => {
  it("uses syntax-aware snippet types for inline content", () => {
    expect(
      chooseSlackSnippetType({
        source: "content",
        byteLength: 128,
        filename: "helpers.ts",
      }),
    ).toBe("typescript");
  });

  it("preserves inferred inline snippet type for known/known-missing extensions", () => {
    expect(
      chooseSlackSnippetType({
        source: "content",
        byteLength: 256,
        filename: "release-notes.txt",
      }),
    ).toBe("txt");
  });

  it("does not enable snippet mode for path uploads or oversized content", () => {
    expect(
      chooseSlackSnippetType({
        source: "path",
        byteLength: 128,
        filename: "helpers.ts",
      }),
    ).toBeUndefined();
    expect(
      chooseSlackSnippetType({
        source: "content",
        byteLength: 1_000_001,
        filename: "helpers.ts",
      }),
    ).toBeUndefined();
  });
});

describe("resolveSlackUploadPath", () => {
  it("allows files inside the current working directory", async () => {
    const root = await makeTempDir("slack-upload-root-");
    const cwd = path.join(root, "repo");
    const tmpdir = path.join(root, "tmp");
    await mkdir(cwd, { recursive: true });
    await mkdir(tmpdir, { recursive: true });
    await writeFile(path.join(cwd, "artifact.log"), "hello");

    await expect(resolveSlackUploadPath("artifact.log", cwd, tmpdir)).resolves.toBe(
      await realpath(path.join(cwd, "artifact.log")),
    );
  });

  it("allows files inside the configured temp directory", async () => {
    const root = await makeTempDir("slack-upload-temp-");
    const cwd = path.join(root, "repo");
    const tmpdir = path.join(root, "tmp");
    await mkdir(cwd, { recursive: true });
    await mkdir(tmpdir, { recursive: true });
    await writeFile(path.join(tmpdir, "screenshot.png"), "png-bytes");

    await expect(
      resolveSlackUploadPath(path.join(tmpdir, "screenshot.png"), cwd, tmpdir),
    ).resolves.toBe(await realpath(path.join(tmpdir, "screenshot.png")));
  });

  it("rejects paths outside the working directory and temp directory", async () => {
    const root = await mkdtemp(path.join(os.homedir(), ".slack-upload-outside-"));
    tempDirs.push(root);
    const cwd = path.join(root, "repo");
    const tmpdir = path.join(root, "tmp");
    const outside = path.join(root, "outside");
    await mkdir(cwd, { recursive: true });
    await mkdir(tmpdir, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "secret.txt"), "nope");

    await expect(
      resolveSlackUploadPath(path.join(outside, "secret.txt"), cwd, tmpdir),
    ).rejects.toThrow("only allows local file paths inside the current working directory");
  });

  it("rejects symlinks that escape the allowed roots", async () => {
    const root = await mkdtemp(path.join(os.homedir(), ".slack-upload-symlink-"));
    tempDirs.push(root);
    const cwd = path.join(root, "repo");
    const tmpdir = path.join(root, "tmp");
    const outside = path.join(root, "outside");
    await mkdir(cwd, { recursive: true });
    await mkdir(tmpdir, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "secret.txt"), "nope");
    await symlink(path.join(outside, "secret.txt"), path.join(cwd, "secret-link.txt"));

    await expect(resolveSlackUploadPath("secret-link.txt", cwd, tmpdir)).rejects.toThrow(
      "only allows local file paths inside the current working directory",
    );
  });

  it("allows conventional tmp when the per-user temp directory differs", async () => {
    const root = await makeTempDir("slack-upload-personal-");
    const cwd = path.join(root, "repo");
    const tmpdir = path.join(root, "personal");
    await mkdir(cwd);
    await mkdir(tmpdir);
    const conventional = await mkdtemp("/tmp/slack-upload-conventional-");
    tempDirs.push(conventional);
    const file = path.join(conventional, "evidence.txt");
    await writeFile(file, "evidence");
    const expected = await realpath(file);
    await expect(resolveSlackUploadPath(file, cwd, tmpdir)).resolves.toBe(expected);
  });
});

describe("prepareSlackUpload", () => {
  it("prepares inline content as a syntax-highlighted snippet", async () => {
    const root = await makeTempDir("slack-upload-inline-");
    const cwd = path.join(root, "repo");
    const tmpdir = path.join(root, "tmp");
    await mkdir(cwd, { recursive: true });
    await mkdir(tmpdir, { recursive: true });

    const upload = await prepareSlackUpload(
      {
        content: "console.log('hi');\n",
        filename: "example.ts",
        title: "TypeScript example",
      },
      cwd,
      tmpdir,
    );

    expect(upload.source).toBe("content");
    expect(upload.filename).toBe("example.ts");
    expect(upload.title).toBe("TypeScript example");
    expect(upload.filetype).toBe("typescript");
    expect(upload.snippetType).toBe("typescript");
    expect(Buffer.from(upload.bytes).toString("utf8")).toContain("console.log");
  });

  it("prepares a local file upload and derives the filename", async () => {
    const root = await makeTempDir("slack-upload-file-");
    const cwd = path.join(root, "repo");
    const tmpdir = path.join(root, "tmp");
    await mkdir(cwd, { recursive: true });
    await mkdir(tmpdir, { recursive: true });
    await writeFile(path.join(cwd, "diff.patch"), "@@ -1 +1 @@\n");

    const upload = await prepareSlackUpload({ path: "diff.patch" }, cwd, tmpdir);

    expect(upload.source).toBe("path");
    expect(upload.filename).toBe("diff.patch");
    expect(upload.title).toBe("diff.patch");
    expect(upload.filetype).toBe("patch");
    expect(upload.snippetType).toBeUndefined();
    expect(upload.resolvedPath).toBe(await realpath(path.join(cwd, "diff.patch")));
  });

  it("requires exactly one source and a filename for inline content", async () => {
    const root = await makeTempDir("slack-upload-errors-");
    const cwd = path.join(root, "repo");
    const tmpdir = path.join(root, "tmp");
    await mkdir(cwd, { recursive: true });
    await mkdir(tmpdir, { recursive: true });

    await expect(prepareSlackUpload({}, cwd, tmpdir)).rejects.toThrow(
      "Provide exactly one of content or path.",
    );
    await expect(
      prepareSlackUpload({ content: "hello", path: "artifact.txt" }, cwd, tmpdir),
    ).rejects.toThrow("Provide exactly one of content or path.");
    await expect(prepareSlackUpload({ content: "hello" }, cwd, tmpdir)).rejects.toThrow(
      "filename is required when uploading inline content.",
    );
  });
});

describe("performSlackUpload", () => {
  it("uses Slack's external upload flow", async () => {
    const slack = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        upload_url: "https://uploads.slack.test/file",
        file_id: "F123",
      })
      .mockResolvedValueOnce({
        ok: true,
        files: [{ id: "F123", permalink: "https://slack.test/F123" }],
      });
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => "",
    }));

    const upload = await prepareSlackUpload(
      {
        content: "diff --git a/file b/file\n",
        filename: "changes.diff",
        title: "Latest diff",
      },
      "/repo",
      "/tmp",
    );

    const result = await performSlackUpload({
      upload,
      channelId: "C123",
      threadTs: "171234.5678",
      slack,
      token: "xoxb-token",
      fetchImpl,
    });

    expect(slack).toHaveBeenNthCalledWith(1, "files.getUploadURLExternal", "xoxb-token", {
      filename: "changes.diff",
      length: upload.byteLength,
      snippet_type: "diff",
    });
    expect(fetchImpl).toHaveBeenCalledWith("https://uploads.slack.test/file", {
      method: "POST",
      headers: {
        "Content-Length": String(upload.byteLength),
        "Content-Type": "text/plain; charset=utf-8",
      },
      body: expect.any(Blob),
    });

    const rawUploadCalls = fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(rawUploadCalls[0]).toBeTruthy();
    const rawUploadInit = rawUploadCalls[0][1];
    expect(await (rawUploadInit.body as Blob).text()).toBe("diff --git a/file b/file\n");
    expect(slack).toHaveBeenNthCalledWith(2, "files.completeUploadExternal", "xoxb-token", {
      files: [{ id: "F123", title: "Latest diff" }],
      channel_id: "C123",
      thread_ts: "171234.5678",
    });
    expect(result.fileId).toBe("F123");
  });

  it("retries files.getUploadURLExternal without snippet_type when invalid arguments happen", async () => {
    const slack = vi
      .fn()
      .mockRejectedValueOnce(new Error("Slack files.getUploadURLExternal: invalid_arguments"))
      .mockResolvedValueOnce({
        ok: true,
        upload_url: "https://uploads.slack.test/file",
        file_id: "F123",
      })
      .mockResolvedValueOnce({
        ok: true,
        files: [{ id: "F123", permalink: "https://slack.test/F123" }],
      });
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => "",
    }));

    const upload = await prepareSlackUpload(
      {
        content: "const answer = 42;\n",
        filename: "release-notes.txt",
        title: "Release notes",
      },
      "/repo",
      "/tmp",
    );

    await performSlackUpload({
      upload,
      channelId: "C123",
      threadTs: "171234.5678",
      slack,
      token: "xoxb-token",
      fetchImpl,
    });

    expect(slack).toHaveBeenCalledTimes(3);
    expect(slack).toHaveBeenNthCalledWith(1, "files.getUploadURLExternal", "xoxb-token", {
      filename: "release-notes.txt",
      length: upload.byteLength,
      snippet_type: "txt",
    });
    expect(slack).toHaveBeenNthCalledWith(2, "files.getUploadURLExternal", "xoxb-token", {
      filename: "release-notes.txt",
      length: upload.byteLength,
    });
    expect(slack).toHaveBeenNthCalledWith(3, "files.completeUploadExternal", "xoxb-token", {
      files: [{ id: "F123", title: "Release notes" }],
      channel_id: "C123",
      thread_ts: "171234.5678",
    });
  });

  it("adds context when Slack rejects upload metadata after the snippet_type retry", async () => {
    const slack = vi
      .fn()
      .mockRejectedValueOnce(
        new Error("Slack files.getUploadURLExternal: invalid_arguments ([ERROR] bad snippet_type)"),
      )
      .mockRejectedValueOnce(
        new Error(
          "Slack files.getUploadURLExternal: invalid_arguments ([ERROR] missing required field: filename)",
        ),
      );
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => "",
    }));

    const upload = await prepareSlackUpload(
      {
        content: "const answer = 42;\n",
        filename: "release-notes.txt",
        title: "Release notes",
      },
      "/repo",
      "/tmp",
    );

    await expect(
      performSlackUpload({
        upload,
        channelId: "C123",
        slack,
        token: "xoxb-token",
        fetchImpl,
      }),
    ).rejects.toThrow(
      'Slack files.getUploadURLExternal: invalid_arguments after retry without snippet_type; Slack rejected upload metadata for filename="release-notes.txt" byte_length=19.',
    );
    expect(slack).toHaveBeenCalledTimes(2);
  });

  it("surfaces raw upload failures", async () => {
    const slack = vi.fn().mockResolvedValue({
      ok: true,
      upload_url: "https://uploads.slack.test/file",
      file_id: "F123",
    });
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      text: async () => "boom",
    }));

    const upload = await prepareSlackUpload(
      {
        content: "hello",
        filename: "hello.txt",
      },
      "/repo",
      "/tmp",
    );

    await expect(
      performSlackUpload({
        upload,
        channelId: "C123",
        slack,
        token: "xoxb-token",
        fetchImpl,
      }),
    ).rejects.toThrow("Slack raw upload failed (HTTP 500 Internal Server Error)");
  });

  it("flags likely proxy/firewall blocked raw upload responses", async () => {
    const slack = vi.fn().mockResolvedValue({
      ok: true,
      upload_url: "https://files.slack.com/upload/abc",
      file_id: "F123",
    });
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      text: async () => "X-Proxy-Error: blocked-by-allowlist",
    }));

    const upload = await prepareSlackUpload(
      {
        content: "hello",
        filename: "hello.txt",
      },
      "/repo",
      "/tmp",
    );

    await expect(
      performSlackUpload({
        upload,
        channelId: "C123",
        slack,
        token: "xoxb-token",
        fetchImpl,
      }),
    ).rejects.toThrow("[possible outbound proxy/firewall block]");
  });

  it("does not label generic HTTP 403 as a proxy/firewall issue", async () => {
    const slack = vi.fn().mockResolvedValue({
      ok: true,
      upload_url: "https://uploads.slack.test/file",
      file_id: "F123",
    });
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      text: async () => "forbidden",
    }));

    const upload = await prepareSlackUpload(
      {
        content: "hello",
        filename: "hello.txt",
      },
      "/repo",
      "/tmp",
    );

    await expect(
      performSlackUpload({
        upload,
        channelId: "C123",
        slack,
        token: "xoxb-token",
        fetchImpl,
      }),
    ).rejects.not.toThrow("[possible outbound proxy/firewall block]");
  });

  it("surfaces network upload transport failures", async () => {
    const networkError = new Error("fetch failed");
    const dnsError = new Error("getaddrinfo ENOTFOUND files.slack.com");
    (dnsError as NodeJS.ErrnoException).code = "ENOTFOUND";
    (networkError as Error & { cause?: Error }).cause = dnsError;
    const slack = vi.fn().mockResolvedValue({
      ok: true,
      upload_url: "https://files.slack.com/upload/abc",
      file_id: "F123",
    });
    const fetchImpl = vi.fn(async () => {
      throw networkError;
    });

    const upload = await prepareSlackUpload(
      {
        content: "hello",
        filename: "hello.txt",
      },
      "/repo",
      "/tmp",
    );

    await expect(
      performSlackUpload({
        upload,
        channelId: "C123",
        slack,
        token: "xoxb-token",
        fetchImpl,
      }),
    ).rejects.toThrow("host=files.slack.com");
  });
});
