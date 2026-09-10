import { LaneConfig } from "@redline/http-contracts/settings.models"
import { buildLanePrompt, buildSeedContext, parseLaneResult } from "./duty.prompt"
import {
  AgentSession,
  DutyInput,
  DutyResult,
  HostAdapter,
  Lane,
  OriginRef,
  SeedSpec,
} from "./host.adapter"
import { errorDetail, isRecord } from "./util"

export type OpenCodeSdkAdapterOptions = {
  getLaneConfig: (lane: Lane) => LaneConfig | Promise<LaneConfig>
  getServerUrl: () => Promise<string>
}

type SessionState = { lane: Lane; artifactId: string; seed?: SeedSpec; seeded: boolean }

const requestJson = async (url: string, init: RequestInit): Promise<unknown> => {
  let response: Response
  try {
    response = await fetch(url, init)
  } catch (error) {
    throw new Error("opencode server unreachable at " + url + ": " + errorDetail(error))
  }
  const text = await response.text()
  if (!response.ok) {
    throw new Error("opencode server request failed (" + String(response.status) + "): " + text.slice(0, 300))
  }
  return text.length > 0 ? (JSON.parse(text) as unknown) : undefined
}

// A duty turn is synchronous and can take minutes: no client-side timeout
// beyond fetch defaults (mirrors the ACP path's absence of dispatcher-level
// timeouts; the dispatcher queues and reports, it does not cancel).
const messageInit = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
})

// OpenCode's API types the message body's model as { providerID, modelID };
// a lane model of "provider/model" splits, anything else passes through raw.
const modelBody = (model: string): unknown => {
  const slash = model.indexOf("/")
  if (slash <= 0 || slash === model.length - 1) return model
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) }
}

// The synchronous message response is { info, parts }; the assistant text
// lives in the parts typed "text" (Part.text per the server docs).
const responseText = (response: unknown): string => {
  if (!isRecord(response) || !Array.isArray(response.parts)) return ""
  return response.parts
    .filter(isRecord)
    .filter((part) => part.type === "text")
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("")
}

// The message list endpoint returns one entry per turn; entries carry
// { info: { role }, parts }. Rendered as a plain transcript — best effort,
// shape drift reads as an empty log.
const transcript = (entries: unknown): string => {
  if (!Array.isArray(entries)) return ""
  const lines: string[] = []
  for (const entry of entries) {
    if (!isRecord(entry) || !isRecord(entry.info)) continue
    const role = typeof entry.info.role === "string" ? entry.info.role : "message"
    const parts = Array.isArray(entry.parts) ? entry.parts : []
    const text = parts
      .filter(isRecord)
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("")
    if (text.length > 0) lines.push("[" + role + "] " + text)
  }
  return lines.join("\n\n")
}

export const createOpenCodeSdkAdapter = (options: OpenCodeSdkAdapterOptions): HostAdapter => {
  const sessions = new Map<string, SessionState>()

  const ensureSession = async (
    lane: Lane,
    artifactId: string,
    seed?: SeedSpec,
    cwd?: string,
  ): Promise<AgentSession> => {
    const serverUrl = await options.getServerUrl()
    // opencode takes the project directory as a query param on /session;
    // sessions spawn there, so duties run inside the originating repo.
    const directory = cwd === undefined ? "" : "?directory=" + encodeURIComponent(cwd)
    const body = await requestJson(
      serverUrl + "/session" + directory,
      messageInit({ title: "redline " + artifactId + " " + lane }),
    )
    const sessionId = isRecord(body) && typeof body.id === "string" ? body.id : undefined
    if (sessionId === undefined) throw new Error("opencode server returned no session id")
    sessions.set(sessionId, { lane, artifactId, seed, seeded: false })
    return { artifactId, lane, hostSessionId: sessionId }
  }

  const runDuty = async (session: AgentSession, input: DutyInput): Promise<DutyResult> => {
    const state = sessions.get(session.hostSessionId)
    if (state === undefined) throw new Error("opencode session is gone")
    // Same first-worker-duty seed rule as ACP: the seed ships once per
    // session, reviewer lanes never see it.
    const alreadySeeded = state.seeded
    state.seeded = true
    const seedPrefix = alreadySeeded ? "" : buildSeedContext(input, state.seed)
    const base = buildLanePrompt(input)
    const prompt = seedPrefix.length > 0 ? seedPrefix + "\n\n" + base : base
    const [config, serverUrl] = await Promise.all([
      options.getLaneConfig(input.lane),
      options.getServerUrl(),
    ])
    const body: Record<string, unknown> = { parts: [{ type: "text", text: prompt }] }
    if (config.model.length > 0) body.model = modelBody(config.model)
    const response = await requestJson(
      serverUrl + "/session/" + encodeURIComponent(session.hostSessionId) + "/message",
      messageInit(body),
    )
    const raw = responseText(response)
    return parseLaneResult(input.lane, raw)
  }

  return {
    id: "opencode-sdk",
    canNotifyOrigin: () => true,
    ensureSession,
    runDuty,
    discard: async (session) => {
      const state = sessions.get(session.hostSessionId)
      if (state === undefined) return
      sessions.delete(session.hostSessionId)
      // Best-effort cleanup: a gone session or dead server is not an error.
      try {
        const serverUrl = await options.getServerUrl()
        await fetch(serverUrl + "/session/" + encodeURIComponent(session.hostSessionId), {
          method: "DELETE",
        })
      } catch {
        // Ignored on purpose.
      }
    },
    // Courtesy fire-and-forget ping to the agent session that created the
    // artifact: never surfaces failures to the caller.
    notifyOrigin: async (origin: OriginRef, text: string) => {
      try {
        const base = origin.serverUrl ?? (await options.getServerUrl())
        await fetch(base + "/session/" + encodeURIComponent(origin.sessionId) + "/prompt_async", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ parts: [{ type: "text", text: text }] }),
        })
      } catch {
        // Ignored on purpose.
      }
    },
    // Stop = delete the session: the server tears the turn down and the
    // in-flight message request settles (usually with an error).
    interrupt: async (session) => {
      try {
        const serverUrl = await options.getServerUrl()
        await fetch(serverUrl + "/session/" + encodeURIComponent(session.hostSessionId), {
          method: "DELETE",
        })
      } catch {
        // Ignored on purpose.
      }
    },
    // Read-only transcript of the session so far; the server keeps it even
    // while a turn is in flight. Empty string when unreachable.
    sessionLog: async (session) => {
      try {
        const serverUrl = await options.getServerUrl()
        const response = await requestJson(
          serverUrl + "/session/" + encodeURIComponent(session.hostSessionId) + "/message",
          { method: "GET" },
        )
        return transcript(response)
      } catch {
        return ""
      }
    },
  }
}
