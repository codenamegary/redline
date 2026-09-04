import { Thread } from "../store/artifact.models"

export type Lane = "reviewer" | "worker"

export type AdapterId = "acp" | "opencode-sdk" | "none"

export type OriginRef = { host: string; sessionId: string; serverUrl?: string }

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
}

export type DutyResult =
  | { kind: "replies"; items: { threadId: string; messageId: string; body: string }[] }
  | { kind: "document"; html: string; note: string }

export type HostAdapter = {
  readonly id: AdapterId
  canNotifyOrigin(): boolean
  ensureSession(lane: Lane, artifactId: string, seed?: SeedSpec): Promise<AgentSession>
  runDuty(session: AgentSession, input: DutyInput): Promise<DutyResult>
  discard?(session: AgentSession): Promise<void>
  notifyOrigin?(origin: OriginRef, text: string): Promise<void>
}
