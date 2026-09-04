import { afterAll, describe, expect, it } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { AcpAdapter, createAcpAdapter } from "./acp.adapter"
import { DEFAULT_REVIEWER_PROMPT, DEFAULT_WORKER_PROMPT } from "./prompts"
import { Thread } from "../store/artifact.models"
import { LaneConfig } from "../store/settings.models"
import { DutyInput, SeedSpec } from "./host.adapter"

const execPath = process.execPath
const fixturePath = join(import.meta.dir, "fake-acp-agent.ts")

const workspaces: string[] = []
let fixtureCounter = 0

afterAll(async () => {
  for (const dir of workspaces) rmSync(dir, { recursive: true, force: true })
})

const makeWorkspace = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "redline-acp-"))
  workspaces.push(dir)
  return dir
}

// The fixture writes its pid at startup so tests can observe process death.
const fixtureCommand = (workspace: string, flags: string[] = []): { argv: string[]; pidFile: string } => {
  fixtureCounter += 1
  const pidFile = join(workspace, "agent-" + String(fixtureCounter) + ".pid")
  return { argv: [execPath, fixturePath, "--pid-file", pidFile, ...flags], pidFile }
}

const pidFrom = async (pidFile: string): Promise<number> => {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (existsSync(pidFile)) break
    await sleep(10)
  }
  return Number(readFileSync(pidFile, "utf8").trim())
}

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

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

const waitFor = async (probe: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (probe()) return
    await sleep(10)
  }
  throw new Error("condition not met within timeout")
}

const laneConfig = (argv: string[]): LaneConfig => ({
  adapter: "acp",
  preset: "custom",
  acpCommand: argv,
  model: "",
})

const makeAdapter = (
  commands: { reviewer?: string[]; worker?: string[] },
  timeoutSeconds?: number,
): AcpAdapter =>
  createAcpAdapter({
    getLaneConfig: async (lane) =>
      laneConfig(
        lane === "reviewer"
          ? (commands.reviewer ?? [])
          : (commands.worker ?? commands.reviewer ?? []),
      ),
    timeoutSeconds,
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

describe("acp adapter", () => {
  it("runs a reviewer duty end to end against the fixture agent", async () => {
    const workspace = makeWorkspace()
    const { argv } = fixtureCommand(workspace)
    const adapter = makeAdapter({ reviewer: argv })
    const session = await adapter.ensureSession("reviewer", "a1")
    expect(session.lane).toBe("reviewer")
    expect(session.artifactId).toBe("a1")

    const result = await adapter.runDuty(session, reviewerInput())
    expect(result).toEqual({
      kind: "replies",
      items: [{ threadId: "t1", messageId: "m2", body: "reply to m2" }],
    })
    await adapter.discard(session)
  })

  it("runs a worker duty that points at the on-disk document", async () => {
    const workspace = makeWorkspace()
    const htmlPath = join(workspace, "index.html")
    writeFileSync(htmlPath, "<html><body>v1</body></html>", "utf8")
    const { argv } = fixtureCommand(workspace)
    const adapter = makeAdapter({ worker: argv })
    const seed: SeedSpec = { html: "<html><body>v1</body></html>", version: "v1" }
    const session = await adapter.ensureSession("worker", "a1", seed)

    const result = await adapter.runDuty(session, workerInput({ htmlPath }))
    // The note marker proves the prompt carried the path, not inline html.
    expect(result.kind === "document" && result.note).toBe("note from disk prompt")
    expect(result.kind === "document" && result.html).toContain("fake v-next")
    await adapter.discard(session)
  })

  it("inlines the seed html when no readable htmlPath exists, once per session", async () => {
    const workspace = makeWorkspace()
    const { argv } = fixtureCommand(workspace)
    const adapter = makeAdapter({ worker: argv })
    const seed: SeedSpec = { html: "<html><body>v1</body></html>", version: "v1" }
    const session = await adapter.ensureSession("worker", "a1", seed)

    const first = await adapter.runDuty(session, workerInput())
    expect(first.kind === "document" && first.note).toBe("note from inline prompt")
    // Seed context ships only on the first duty of a session.
    const second = await adapter.runDuty(session, workerInput())
    expect(second.kind === "document" && second.note).toBe("fake iteration note")
    await adapter.discard(session)
  })

  it("discard kills the agent process", async () => {
    const workspace = makeWorkspace()
    const { argv, pidFile } = fixtureCommand(workspace)
    const adapter = makeAdapter({ reviewer: argv })
    const session = await adapter.ensureSession("reviewer", "a1")
    const pid = await pidFrom(pidFile)
    expect(isAlive(pid)).toBe(true)

    await adapter.discard(session)
    await waitFor(() => !isAlive(pid))
  })

  it("times a hung duty out, kills the agent, and drops the session", async () => {
    const workspace = makeWorkspace()
    const { argv, pidFile } = fixtureCommand(workspace, ["--silent-prompt"])
    const adapter = makeAdapter({ reviewer: argv }, 1)
    const session = await adapter.ensureSession("reviewer", "a1")
    const pid = await pidFrom(pidFile)

    await rejectsWith(adapter.runDuty(session, reviewerInput()), "duty timed out after 1s")
    await waitFor(() => !isAlive(pid))
    await rejectsWith(adapter.runDuty(session, reviewerInput()), "acp session is gone")
  })

  it("rejects ensureSession with detail when the command cannot spawn", async () => {
    const adapter = makeAdapter({ reviewer: ["redline-no-such-binary-acp-7q"] })
    await rejectsWith(
      adapter.ensureSession("reviewer", "a1"),
      "command not found: redline-no-such-binary-acp-7q",
    )
  })
})
