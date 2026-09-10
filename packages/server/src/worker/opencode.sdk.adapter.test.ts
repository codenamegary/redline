import { afterAll, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Thread } from "@redline/http-contracts/artifact.models"
import { LaneConfig } from "@redline/http-contracts/settings.models"
import { DutyInput, SeedSpec } from "./host.adapter"
import { createOpenCodeSdkAdapter } from "./opencode.sdk.adapter"
import { DEFAULT_REVIEWER_PROMPT, DEFAULT_WORKER_PROMPT } from "./prompts"

type RecordedRequest = { method: string; path: string; query: string; body: unknown }

type Reply = { status: number; body?: unknown }

type TestServer = {
  requests: RecordedRequest[]
  setMessageText: (text: string) => void
  reply: (next: (request: RecordedRequest) => Reply) => void
  url: string
  stop: () => void
}

const servers: TestServer[] = []
const workspaces: string[] = []

afterAll(async () => {
  for (const server of servers) server.stop()
  for (const dir of workspaces) rmSync(dir, { recursive: true, force: true })
})

const makeWorkspace = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "redline-oc-sdk-"))
  workspaces.push(dir)
  return dir
}

// Canned opencode-server double: records every request and answers like the
// real API for the paths the adapter touches. Session ids count per server,
// so each test owns a fresh namespace.
const makeServer = (): TestServer => {
  const requests: RecordedRequest[] = []
  let messageText = "no canned message text"
  let sessionCounter = 0
  const defaultReply = (request: RecordedRequest): Reply => {
    if (request.method === "POST" && request.path === "/session") {
      sessionCounter += 1
      return { status: 200, body: { id: "ses_" + String(sessionCounter) } }
    }
    if (request.method === "POST" && request.path.endsWith("/message")) {
      return { status: 200, body: { info: {}, parts: [{ type: "text", text: messageText }] } }
    }
    if (request.method === "POST" && request.path.endsWith("/prompt_async")) {
      return { status: 204 }
    }
    if (request.method === "DELETE" && request.path.startsWith("/session/")) {
      return { status: 200, body: true }
    }
    return { status: 404, body: { message: "no route" } }
  }
  let reply = defaultReply
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      let body: unknown = null
      const raw = await request.text()
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw) as unknown
        } catch {
          body = raw
        }
      }
      const recorded: RecordedRequest = {
        method: request.method,
        path: url.pathname,
        query: url.search,
        body: body,
      }
      requests.push(recorded)
      const outcome = reply(recorded)
      return outcome.body === undefined
        ? new Response(null, { status: outcome.status })
        : Response.json(outcome.body, { status: outcome.status })
    },
  })
  const testServer: TestServer = {
    requests: requests,
    setMessageText: (text) => {
      messageText = text
    },
    reply: (next) => {
      reply = next
    },
    url: "http://127.0.0.1:" + String(server.port),
    stop: () => void server.stop(true),
  }
  servers.push(testServer)
  return testServer
}

// A port that refuses connections: bind one, note the port, release it.
const closedPortUrl = (): string => {
  const server = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 404 }) })
  const url = "http://127.0.0.1:" + String(server.port)
  void server.stop(true)
  return url
}

// bun:test's expect().rejects types as void, which the type-aware lint
// refuses to await; assert rejections through this helper instead.
const rejectsWith = async (promise: Promise<unknown>, message: string): Promise<void> => {
  try {
    await promise
  } catch (error) {
    expect(error instanceof Error && error.message).toBe(message)
    return
  }
  throw new Error("expected rejection: " + message)
}

const laneConfig = (model: string): LaneConfig => ({
  adapter: "opencode-sdk",
  preset: "custom",
  acpCommand: [],
  model: model,
})

const makeAdapter = (serverUrl: string, model = "") =>
  createOpenCodeSdkAdapter({
    getLaneConfig: async () => laneConfig(model),
    getServerUrl: async () => serverUrl,
  })

const iso = "2026-01-01T00:00:00.000Z"

const threadFixture = (): Thread => ({
  id: "t1",
  status: "open",
  anchor: { selector: ".cta", text: "Buy now" },
  messages: [
    { id: "m1", author: "user", kind: "text", body: "The button overlaps the footer", createdAt: iso },
    { id: "m2", author: "agent", kind: "thinking", body: "…", createdAt: iso },
  ],
  createdAt: iso,
})

const reviewerInput = (): DutyInput => ({
  lane: "reviewer",
  promptTemplate: DEFAULT_REVIEWER_PROMPT,
  brief: "landing page for a coffee brand",
  title: "Landing page",
  version: "v1",
  threads: [threadFixture()],
  targets: [{ threadId: "t1", messageId: "m2" }],
})

const workerInput = (overrides?: Partial<DutyInput>): DutyInput => ({
  lane: "worker",
  promptTemplate: DEFAULT_WORKER_PROMPT,
  brief: "landing page for a coffee brand",
  title: "Landing page",
  version: "v2",
  threads: [threadFixture()],
  targets: [],
  batchThreadIds: ["t1"],
  ...overrides,
})

const seed = (): SeedSpec => ({ html: "<html><body>seed doc</body></html>", version: "v1" })

const reviewerReplyText = '[{"threadId":"t1","messageId":"m2","body":"Looks fine, fixed."}]'
const workerDocText =
  "<!-- redline-note: moved the cta --><!doctype html><html><body>new</body></html>"

const messageRequests = (requests: RecordedRequest[]): RecordedRequest[] =>
  requests.filter((request) => request.path.endsWith("/message"))

// Indexing is unchecked in tests; fail loud instead of on undefined.
const recorded = (requests: RecordedRequest[], index: number): RecordedRequest => {
  const entry = requests[index]
  if (entry === undefined) throw new Error("no recorded request at " + String(index))
  return entry
}

const promptOf = (request: RecordedRequest): string => {
  const body = request.body as { parts: { text: string }[] }
  return body.parts[0]?.text ?? ""
}

describe("opencode sdk adapter", () => {
  it("creates a session titled from lane and artifact and inlines the seed on the first worker duty", async () => {
    const server = makeServer()
    server.setMessageText(workerDocText)
    const htmlPath = join(makeWorkspace(), "index.html")
    writeFileSync(htmlPath, "<html><body>seed doc</body></html>")
    const adapter = makeAdapter(server.url)
    const session = await adapter.ensureSession("worker", "a1", seed())
    expect(session).toEqual({ artifactId: "a1", lane: "worker", hostSessionId: "ses_1" })

    const result = await adapter.runDuty(session, workerInput({ htmlPath: htmlPath }))
    expect(recorded(server.requests, 0)).toEqual({
      method: "POST",
      path: "/session",
      query: "",
      body: { title: "redline a1 worker" },
    })
    const prompt = promptOf(recorded(messageRequests(server.requests), 0))
    // The document ships inline even when a disk path exists: spawned agents
    // cannot rely on file access, so the prompt never points at htmlPath.
    expect(
      prompt.startsWith(
        "Current document (v1), complete single-file HTML:\n\n<html><body>seed doc</body></html>\n\n",
      ),
    ).toBe(true)
    expect(prompt.includes("on disk at")).toBe(false)
    expect(prompt.includes("```")).toBe(false)
    expect(result).toEqual({
      kind: "document",
      html: "<!doctype html><html><body>new</body></html>",
      note: "moved the cta",
    })
  })

  it("inlines the seed html and seeds only once per session", async () => {
    const server = makeServer()
    server.setMessageText(workerDocText)
    const adapter = makeAdapter(server.url)
    const session = await adapter.ensureSession("worker", "a1", seed())

    await adapter.runDuty(session, workerInput())
    const first = promptOf(recorded(messageRequests(server.requests), 0))
    expect(
      first.startsWith("Current document (v1), complete single-file HTML:\n\n<html><body>seed doc</body></html>\n\n"),
    ).toBe(true)

    await adapter.runDuty(session, workerInput())
    expect(messageRequests(server.requests)).toHaveLength(2)
    const second = promptOf(recorded(messageRequests(server.requests), 1))
    expect(second.includes("Current document (v1):")).toBe(false)
    expect(second.includes("complete single-file HTML:")).toBe(false)
  })

  it("never seeds a reviewer session and parses the reply contract", async () => {
    const server = makeServer()
    server.setMessageText(reviewerReplyText)
    const adapter = makeAdapter(server.url)
    const session = await adapter.ensureSession("reviewer", "a2", seed())

    const result = await adapter.runDuty(session, reviewerInput())
    const prompt = promptOf(recorded(messageRequests(server.requests), 0))
    expect(prompt.includes("Current document")).toBe(false)
    expect(prompt.includes("on disk at")).toBe(false)
    expect(prompt.includes("Output contract (a machine parses your reply)")).toBe(true)
    expect(result).toEqual({
      kind: "replies",
      items: [{ threadId: "t1", messageId: "m2", body: "Looks fine, fixed." }],
    })
  })

  it("passes the project cwd as the directory query param on /session", async () => {
    const server = makeServer()
    const adapter = makeAdapter(server.url)
    await adapter.ensureSession("worker", "a10", seed(), "/home/dev/coffee site")
    expect(recorded(server.requests, 0)).toEqual({
      method: "POST",
      path: "/session",
      query: "?directory=%2Fhome%2Fdev%2Fcoffee%20site",
      body: { title: "redline a10 worker" },
    })
  })

  it("passes lane.model through as provider/model and omits it when empty", async () => {
    const server = makeServer()
    server.setMessageText(workerDocText)
    const adapter = makeAdapter(server.url, "anthropic/claude-sonnet-4")
    const session = await adapter.ensureSession("worker", "a3", seed())
    await adapter.runDuty(session, workerInput())
    const body = recorded(messageRequests(server.requests), 0).body as { model?: unknown }
    expect(body.model).toEqual({ providerID: "anthropic", modelID: "claude-sonnet-4" })

    const plain = makeServer()
    plain.setMessageText(workerDocText)
    const plainAdapter = makeAdapter(plain.url)
    const plainSession = await plainAdapter.ensureSession("worker", "a4", seed())
    await plainAdapter.runDuty(plainSession, workerInput())
    const plainBody = recorded(messageRequests(plain.requests), 0).body as { model?: unknown }
    expect("model" in plainBody).toBe(false)
  })

  it("rejects when the agent output is unparseable", async () => {
    const server = makeServer()
    server.setMessageText("no parseable output here")
    const adapter = makeAdapter(server.url)
    const session = await adapter.ensureSession("reviewer", "a5")
    await rejectsWith(adapter.runDuty(session, reviewerInput()), "reviewer returned unparseable output")
  })

  it("rejects with a clear prefix when the server is unreachable", async () => {
    const adapter = makeAdapter(closedPortUrl())
    let detail = ""
    try {
      await adapter.ensureSession("worker", "a6")
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error)
    }
    expect(detail.startsWith("opencode server unreachable at http://127.0.0.1:")).toBe(true)
  })

  it("discards via DELETE, tolerates failure, and no-ops for unknown sessions", async () => {
    const server = makeServer()
    server.setMessageText(workerDocText)
    const adapter = makeAdapter(server.url)
    const session = await adapter.ensureSession("worker", "a8", seed())

    await adapter.discard?.(session)
    const deletes = server.requests.filter((request) => request.method === "DELETE")
    expect(deletes).toHaveLength(1)
    expect(recorded(deletes, 0).path).toBe("/session/ses_1")

    // Unknown session: no request, no throw.
    await adapter.discard?.(session)
    expect(server.requests.filter((request) => request.method === "DELETE")).toHaveLength(1)

    // Dead server: swallow and resolve.
    const deadServer = makeServer()
    deadServer.setMessageText(workerDocText)
    const deadAdapter = makeAdapter(deadServer.url)
    const deadSession = await deadAdapter.ensureSession("worker", "a9", seed())
    deadServer.stop()
    await deadAdapter.discard?.(deadSession)
  })
})
