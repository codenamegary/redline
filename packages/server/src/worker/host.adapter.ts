import { Thread } from "@redline/http-contracts/artifact.models"

export type Lane = "reviewer" | "worker"

export type AdapterId = "acp" | "none"

export type AgentSession = { artifactId: string; lane: Lane; hostSessionId: string }

export type SeedSpec = { html: string; version: string }

// Thinking placeholder a duty must fill with a real reply.
export type ThreadRef = { threadId: string; messageId: string }

export type DutyInput = {
  lane: Lane
  promptTemplate: string
  brief: string
  title: string
  version: string
  threads: Thread[]
  // Placeholders this duty must fill (reviewer lane).
  targets: ThreadRef[]
  // Frozen batch (worker lane).
  batchThreadIds?: string[]
  // Absolute path to the current index.html on disk (worker lane seed hint).
  htmlPath?: string
  // Project directory for the duty. Sessions spawn there so duties can
  // read the repo that produced the artifact.
  cwd?: string
}

export type DutyResult =
  | { kind: "replies"; items: { threadId: string; messageId: string; body: string }[] }
  | { kind: "document"; html: string; note: string }

export type HostAdapter = {
  readonly id: AdapterId
  ensureSession(lane: Lane, artifactId: string, seed?: SeedSpec, cwd?: string): Promise<AgentSession>
  runDuty(session: AgentSession, input: DutyInput): Promise<DutyResult>
  discard?(session: AgentSession): Promise<void>
  // Best-effort cancel of an in-flight duty: the current turn is aborted so
  // runDuty throws (or has already settled) and the lane can be failed.
  interrupt?(session: AgentSession): Promise<void> | void
  // Read-only transcript of what the session has done so far. Best-effort:
  // adapters without a log story simply omit it.
  sessionLog?(session: AgentSession): Promise<string> | string
}
