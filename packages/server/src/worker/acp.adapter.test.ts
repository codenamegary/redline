import { afterAll, describe, expect, it } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { AcpAdapter, AcpAdapterOptions, createAcpAdapter } from "./acp.adapter"
import { DEFAULT_REVIEWER_PROMPT, DEFAULT_WORKER_PROMPT } from "./prompts"
import { Thread } from "@redline/http-contracts/artifact.models"
import { LaneConfig } from "@redline/http-contracts/settings.models"
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
})

const makeAdapter = (
  commands: { reviewer?: string[]; worker?: string[] },
  options?: Partial<AcpAdapterOptions>,
): AcpAdapter =>
  createAcpAdapter({
    getLaneConfig: async (lane) =>
      laneConfig(
        lane === "reviewer"
          ? (commands.reviewer ?? [])
          : (commands.worker ?? commands.reviewer ?? []),
      ),
    ...options,
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

  it("points the worker at the seed and serves the file through the client", async () => {
    const workspace = makeWorkspace()
    const seedPath = join(workspace, "v1-index.html")
    writeFileSync(seedPath, "SEED-CONTENT-v1", "utf8")
    const { argv } = fixtureCommand(workspace, ["--read", seedPath])
    const adapter = makeAdapter({ worker: argv })
    const seed: SeedSpec = { version: "v1", path: seedPath, bytes: 15 }

    const session = await adapter.ensureSession("worker", "a1", seed, workspace)
    const result = await adapter.runDuty(session, workerInput())
    // The fixture calls fs/read_text_file and folds what it got into its
    // note, proving the client served the pointer path.
    const note = result.kind === "document" ? result.note : ""
    expect(note).toContain("note from pointer prompt")
    expect(note).toContain("read-ok")
    expect(note).toContain("SEED-CONTENT-v1")
    await adapter.discard(session)
  })

  it("denies reads outside the artifact dir and project cwd", async () => {
    const workspace = makeWorkspace()
    const other = makeWorkspace()
    const seedPath = join(workspace, "v1-index.html")
    writeFileSync(seedPath, "<html><body>v1</body></html>", "utf8")
    const secret = join(other, "secret.txt")
    writeFileSync(secret, "top secret", "utf8")
    const { argv } = fixtureCommand(workspace, ["--read", secret])
    const adapter = makeAdapter({ worker: argv })
    const seed: SeedSpec = { version: "v1", path: seedPath, bytes: 30 }

    const session = await adapter.ensureSession("worker", "a1", seed, workspace)
    const result = await adapter.runDuty(session, workerInput())
    const note = result.kind === "document" ? result.note : ""
    expect(note).toContain("read-error")
    expect(note).not.toContain("top secret")
    await adapter.discard(session)
  })

  it("caps the bytes a single read serves", async () => {
    const workspace = makeWorkspace()
    const seedPath = join(workspace, "v1-index.html")
    writeFileSync(seedPath, "x".repeat(64), "utf8")
    const { argv } = fixtureCommand(workspace, ["--read", seedPath])
    const adapter = makeAdapter({ worker: argv }, { maxReadBytes: 8 })
    const seed: SeedSpec = { version: "v1", path: seedPath, bytes: 64 }

    const session = await adapter.ensureSession("worker", "a1", seed, workspace)
    const result = await adapter.runDuty(session, workerInput())
    const note = result.kind === "document" ? result.note : ""
    expect(note).toContain("read-error")
    expect(note).toContain("exceeds")
    await adapter.discard(session)
  })

  it("allows a read permission request inside the session roots", async () => {
    const workspace = makeWorkspace()
    const seedPath = join(workspace, "v1-index.html")
    writeFileSync(seedPath, "<html><body>v1</body></html>", "utf8")
    const { argv } = fixtureCommand(workspace, ["--permission-read", seedPath])
    const adapter = makeAdapter({ worker: argv })
    const seed: SeedSpec = { version: "v1", path: seedPath, bytes: 30 }

    const session = await adapter.ensureSession("worker", "a1", seed, workspace)
    const result = await adapter.runDuty(session, workerInput())
    expect(result.kind === "document" && result.note).toContain("perm-allow")
    await adapter.discard(session)
  })

  it("denies a read permission request outside the session roots", async () => {
    const workspace = makeWorkspace()
    const other = makeWorkspace()
    const seedPath = join(workspace, "v1-index.html")
    writeFileSync(seedPath, "<html><body>v1</body></html>", "utf8")
    const secret = join(other, "secret.txt")
    writeFileSync(secret, "top secret", "utf8")
    const { argv } = fixtureCommand(workspace, ["--permission-read", secret])
    const adapter = makeAdapter({ worker: argv })
    const seed: SeedSpec = { version: "v1", path: seedPath, bytes: 30 }

    const session = await adapter.ensureSession("worker", "a1", seed, workspace)
    const result = await adapter.runDuty(session, workerInput())
    expect(result.kind === "document" && result.note).toContain("perm-deny")
    await adapter.discard(session)
  })

  it("denies a write permission request even inside the session roots", async () => {
    const workspace = makeWorkspace()
    const seedPath = join(workspace, "v1-index.html")
    writeFileSync(seedPath, "<html><body>v1</body></html>", "utf8")
    const { argv } = fixtureCommand(workspace, ["--permission-write", seedPath])
    const adapter = makeAdapter({ worker: argv })
    const seed: SeedSpec = { version: "v1", path: seedPath, bytes: 30 }

    const session = await adapter.ensureSession("worker", "a1", seed, workspace)
    const result = await adapter.runDuty(session, workerInput())
    expect(result.kind === "document" && result.note).toContain("perm-deny")
    await adapter.discard(session)
  })

  it("ships the pointer context once per session", async () => {
    const workspace = makeWorkspace()
    const seedPath = join(workspace, "v1-index.html")
    writeFileSync(seedPath, "<html><body>v1</body></html>", "utf8")
    const { argv } = fixtureCommand(workspace)
    const adapter = makeAdapter({ worker: argv })
    const seed: SeedSpec = { version: "v1", path: seedPath, bytes: 30 }
    const session = await adapter.ensureSession("worker", "a1", seed, workspace)

    const first = await adapter.runDuty(session, workerInput())
    expect(first.kind === "document" && first.note).toBe("note from pointer prompt")
    // Seed context ships only on the first duty of a session.
    const second = await adapter.runDuty(session, workerInput())
    expect(second.kind === "document" && second.note).toBe("fake iteration note")
    await adapter.discard(session)
  })

  it("continues a truncated worker document instead of accepting it", async () => {
    const workspace = makeWorkspace()
    const seedPath = join(workspace, "v1-index.html")
    writeFileSync(seedPath, "SEED", "utf8")
    const promptFile = join(workspace, "prompts.txt")
    const { argv } = fixtureCommand(workspace, ["--truncate-once", "--prompt-file", promptFile])
    const adapter = makeAdapter({ worker: argv })
    const seed: SeedSpec = { version: "v1", path: seedPath, bytes: 4 }

    const session = await adapter.ensureSession("worker", "a1", seed, workspace)
    const result = await adapter.runDuty(session, workerInput())
    const html = result.kind === "document" ? result.html : ""
    expect(html).toContain("<p>fake v-next</p>")
    expect(html.endsWith("</html>")).toBe(true)
    // The continued stream is one document, not a restart.
    expect((html.match(/<!doctype/gi) ?? []).length).toBe(1)
    expect(readFileSync(promptFile, "utf8")).toBe("2")
    await adapter.discard(session)
  })

  it("fails after the continuation cap when the worker never finishes", async () => {
    const workspace = makeWorkspace()
    const seedPath = join(workspace, "v1-index.html")
    writeFileSync(seedPath, "SEED", "utf8")
    const promptFile = join(workspace, "prompts.txt")
    const { argv } = fixtureCommand(workspace, ["--truncate-always", "--prompt-file", promptFile])
    const adapter = makeAdapter({ worker: argv })
    const seed: SeedSpec = { version: "v1", path: seedPath, bytes: 4 }

    const session = await adapter.ensureSession("worker", "a1", seed, workspace)
    await rejectsWith(adapter.runDuty(session, workerInput()), "worker output truncated")
    // One initial turn plus six continuations.
    expect(readFileSync(promptFile, "utf8")).toBe("7")
    await adapter.discard(session)
  })

  it("stops continuing when a turn makes no progress", async () => {
    const workspace = makeWorkspace()
    const seedPath = join(workspace, "v1-index.html")
    writeFileSync(seedPath, "SEED", "utf8")
    const promptFile = join(workspace, "prompts.txt")
    const { argv } = fixtureCommand(workspace, ["--truncate-stall", "--prompt-file", promptFile])
    const adapter = makeAdapter({ worker: argv })
    const seed: SeedSpec = { version: "v1", path: seedPath, bytes: 4 }

    const session = await adapter.ensureSession("worker", "a1", seed, workspace)
    await rejectsWith(adapter.runDuty(session, workerInput()), "worker output truncated")
    // The stalled continuation ends the loop instead of burning the cap.
    expect(readFileSync(promptFile, "utf8")).toBe("2")
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

  it("interrupt kills the agent, fails the duty, and drops the session", async () => {
    const workspace = makeWorkspace()
    const { argv, pidFile } = fixtureCommand(workspace, ["--silent-prompt"])
    const adapter = makeAdapter({ reviewer: argv })
    const session = await adapter.ensureSession("reviewer", "a1")
    const pid = await pidFrom(pidFile)

    // No duty timeout: the hung duty stays in flight until interrupted.
    const duty = adapter.runDuty(session, reviewerInput())
    await sleep(100)
    void adapter.interrupt?.(session)
    await rejectsWith(duty, "acp agent killed by signal SIGTERM")
    await waitFor(() => !isAlive(pid))
    await rejectsWith(adapter.runDuty(session, reviewerInput()), "acp session is gone")
  })

  it("sessionLog returns the agent transcript, empty for unknown sessions", async () => {
    const workspace = makeWorkspace()
    const { argv } = fixtureCommand(workspace, ["--tool-call"])
    const adapter = makeAdapter({ worker: argv })
    const session = await adapter.ensureSession("worker", "a1", {
      version: "v1",
      path: join(workspace, "v1-index.html"),
      bytes: 30,
    })

    await adapter.runDuty(session, workerInput())
    const log = (await adapter.sessionLog?.(session)) ?? ""
    expect(log).toContain("[tool] Read file")
    expect(log).toContain("Checking the layout first.")
    expect(log).toContain("[done] Read file")
    expect(log).toContain("fake v-next")
    expect((await adapter.sessionLog?.({ artifactId: "a1", lane: "worker", hostSessionId: "acp-gone" })) ?? "").toBe("")
    await adapter.discard(session)
  })

  it("opens the session in the artifact's project cwd", async () => {
    const workspace = makeWorkspace()
    const cwdFile = join(workspace, "session-cwd.txt")
    const { argv } = fixtureCommand(workspace, ["--cwd-file", cwdFile])
    const adapter = makeAdapter({ worker: argv })
    const session = await adapter.ensureSession("worker", "a1", undefined, "/repo/coffee-site")

    await waitFor(() => existsSync(cwdFile))
    expect(readFileSync(cwdFile, "utf8")).toBe("/repo/coffee-site")
    await adapter.discard(session)
  })

  it("falls back to the daemon cwd when the duty carries none", async () => {
    const workspace = makeWorkspace()
    const cwdFile = join(workspace, "session-cwd.txt")
    const { argv } = fixtureCommand(workspace, ["--cwd-file", cwdFile])
    const adapter = makeAdapter({ reviewer: argv })
    const session = await adapter.ensureSession("reviewer", "a1")

    await waitFor(() => existsSync(cwdFile))
    expect(readFileSync(cwdFile, "utf8")).toBe(process.cwd())
    await adapter.discard(session)
  })

  it("rejects ensureSession with detail when the command cannot spawn", async () => {
    const adapter = makeAdapter({ reviewer: ["redline-no-such-binary-acp-7q"] })
    await rejectsWith(
      adapter.ensureSession("reviewer", "a1"),
      "command not found: redline-no-such-binary-acp-7q",
    )
  })
})
