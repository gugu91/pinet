import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchSlackFileToCache } from "./slack-file-access.js";
import type { SlackResult } from "./slack-api.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "slack-file-access-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function slackFile(input: {
  id: string;
  name: string;
  mimetype: string;
  filetype: string;
  prettyType: string;
  size: number;
  url: string;
}): Record<string, unknown> {
  return {
    id: input.id,
    name: input.name,
    mimetype: input.mimetype,
    filetype: input.filetype,
    pretty_type: input.prettyType,
    size: input.size,
    url_private_download: input.url,
  };
}

function toArrayBuffer(bytes: Buffer): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function okResponse(
  bytes: Buffer,
): Pick<Response, "ok" | "status" | "statusText" | "arrayBuffer" | "text"> {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    arrayBuffer: async () => toArrayBuffer(bytes),
    text: async () => "",
  };
}

describe("fetchSlackFileToCache", () => {
  it("downloads an image from a verified thread without exposing private URLs", async () => {
    const cacheDir = await makeTempDir();
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const slack = vi.fn(async (method: string): Promise<SlackResult> => {
      expect(method).toBe("conversations.replies");
      return {
        ok: true,
        messages: [
          {
            ts: "1.2",
            files: [
              slackFile({
                id: "FIMG",
                name: "screen.png",
                mimetype: "image/png",
                filetype: "png",
                prettyType: "PNG",
                size: bytes.byteLength,
                url: "https://files.slack.com/private/image",
              }),
            ],
          },
        ],
      };
    });
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.headers).toEqual({ Authorization: "Bearer xoxb-test" });
      return okResponse(bytes);
    });

    const descriptor = await fetchSlackFileToCache(
      "FIMG",
      { channelId: "C1", threadTs: "1.1", messageTs: "1.2" },
      {
        slack,
        token: "xoxb-test",
        fetchImpl,
        cacheDir,
        now: () => new Date("2026-06-08T00:00:00Z"),
      },
    );

    expect(descriptor.filename).toBe("screen.png");
    expect(descriptor.mimetype).toBe("image/png");
    expect(descriptor.size).toBe(bytes.byteLength);
    expect(descriptor.path).toContain(cacheDir);
    expect(JSON.stringify(descriptor)).not.toContain("files.slack.com/private");
    expect(fetchImpl).toHaveBeenCalledWith("https://files.slack.com/private/image", {
      method: "GET",
      headers: { Authorization: "Bearer xoxb-test" },
    });
  });

  it("downloads a PDF/document through files.info", async () => {
    const cacheDir = await makeTempDir();
    const bytes = Buffer.from("%PDF-1.7");
    const slack = vi.fn(async (method: string): Promise<SlackResult> => {
      expect(method).toBe("files.info");
      return {
        ok: true,
        file: slackFile({
          id: "FPDF",
          name: "proposal.pdf",
          mimetype: "application/pdf",
          filetype: "pdf",
          prettyType: "PDF",
          size: bytes.byteLength,
          url: "https://files.slack.com/private/pdf",
        }),
      };
    });

    const descriptor = await fetchSlackFileToCache(
      "FPDF",
      {},
      {
        slack,
        token: "xoxb-test",
        fetchImpl: async () => okResponse(bytes),
        cacheDir,
      },
    );

    expect(descriptor.filename).toBe("proposal.pdf");
    expect(descriptor.filetype).toBe("pdf");
    expect(descriptor.sha256).toHaveLength(64);
  });

  it("rejects non-Slack private download hosts before sending bot auth", async () => {
    const cacheDir = await makeTempDir();
    const slack = vi.fn(
      async (): Promise<SlackResult> => ({
        ok: true,
        file: slackFile({
          id: "FEVIL",
          name: "evil.bin",
          mimetype: "application/octet-stream",
          filetype: "binary",
          prettyType: "Binary",
          size: 1,
          url: "https://example.test/private/file",
        }),
      }),
    );
    const fetchImpl = vi.fn(async () => okResponse(Buffer.from([1])));

    await expect(
      fetchSlackFileToCache("FEVIL", {}, { slack, token: "xoxb-test", fetchImpl, cacheDir }),
    ).rejects.toThrow("host is not allowed");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects files above the configured safe size limit before downloading", async () => {
    const cacheDir = await makeTempDir();
    const slack = vi.fn(
      async (): Promise<SlackResult> => ({
        ok: true,
        file: slackFile({
          id: "FHUGE",
          name: "huge.bin",
          mimetype: "application/octet-stream",
          filetype: "binary",
          prettyType: "Binary",
          size: 10,
          url: "https://files.slack.com/private/huge",
        }),
      }),
    );
    const fetchImpl = vi.fn(async () => okResponse(Buffer.from([1])));

    await expect(
      fetchSlackFileToCache(
        "FHUGE",
        {},
        {
          slack,
          token: "xoxb-test",
          fetchImpl,
          cacheDir,
          maxBytes: 4,
        },
      ),
    ).rejects.toThrow("too large to download safely");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("stops streaming downloads once the response exceeds the safe size limit", async () => {
    const cacheDir = await makeTempDir();
    const slack = vi.fn(
      async (): Promise<SlackResult> => ({
        ok: true,
        file: slackFile({
          id: "FSTREAM",
          name: "stream.bin",
          mimetype: "application/octet-stream",
          filetype: "binary",
          prettyType: "Binary",
          size: 2,
          url: "https://files.slack.com/private/stream",
        }),
      }),
    );
    const firstChunk = new Uint8Array(new ArrayBuffer(2));
    firstChunk.set([1, 2]);
    const secondChunk = new Uint8Array(new ArrayBuffer(2));
    secondChunk.set([3, 4]);
    const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({
      start(controller) {
        controller.enqueue(firstChunk);
        controller.enqueue(secondChunk);
        controller.close();
      },
    });

    await expect(
      fetchSlackFileToCache(
        "FSTREAM",
        {},
        {
          slack,
          token: "xoxb-test",
          fetchImpl: async () => ({
            ok: true,
            status: 200,
            statusText: "OK",
            body: stream,
            arrayBuffer: async () => toArrayBuffer(Buffer.from([1, 2, 3, 4])),
            text: async () => "",
          }),
          cacheDir,
          maxBytes: 3,
        },
      ),
    ).rejects.toThrow("download exceeded safe limit");
  });

  it("downloads audio or generic binary files and records a safe descriptor", async () => {
    const cacheDir = await makeTempDir();
    const bytes = Buffer.from([0, 1, 2, 3, 4, 5]);
    const slack = vi.fn(
      async (): Promise<SlackResult> => ({
        ok: true,
        file: slackFile({
          id: "FAUDIO",
          name: "voice.m4a",
          mimetype: "audio/mp4",
          filetype: "m4a",
          prettyType: "MPEG 4 Audio",
          size: bytes.byteLength,
          url: "https://files.slack.com/private/audio",
        }),
      }),
    );

    const descriptor = await fetchSlackFileToCache(
      "FAUDIO",
      {},
      {
        slack,
        token: "xoxb-test",
        fetchImpl: async () => okResponse(bytes),
        cacheDir,
      },
    );

    expect(descriptor.filename).toBe("voice.m4a");
    expect(descriptor.mimetype).toBe("audio/mp4");
    expect(descriptor.residualRisks.length).toBeGreaterThan(0);
  });
});
