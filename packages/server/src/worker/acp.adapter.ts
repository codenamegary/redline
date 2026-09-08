import { spawn } from "node:child_process"

import { hasErrorCode } from "../store/errors"
import { LaneConfig } from "@redline/http-contracts/settings.models"
import { buildLanePrompt, buildSeedContext, parseLaneResult } from "./duty.prompt"
import { AgentSession, DutyInput, DutyResult, HostAdapter, Lane, SeedSpec } from "./host.adapter"
import { isRecord } from "./util"

// (#23) Workers can run long: a big iteration (whole-page rework, asset-heavy
// publish) easily exceeds five minutes. 15 minutes is the ceiling before the
// lane is failed and the user can re-Iterate.
export const defaultTimeoutSeconds = 900
// Handshakes (initialize + session/new) are fast ops; a fixed deadline keeps
// a wedged agent from holding a spawn forever regardless of duty timeout.
const handshakeTimeoutSeconds = 15
const killGraceMs = 1000
const stderrLimit = 4000
// ACP has no portable model selector; custom presets bake model into argv.
const acpProtocolVersion = 1

export type AcpAdapterOptions = {
  getLaneConfig: (lane: Lane) => LaneConfig | Promise<LaneConfig>
  timeoutSeconds?: number
}

type Pending = { method: string; resolve: (value: unknown) => void; reject: (error: Error) => void }

type Connection = {  request: (method: string, params: unknown) => Promise<unknown>
  resetChunks: () => void
  takeChunks: () => string
  kill: () => void
  terminate: () => Promise<void>
}

const withTimeout = async <T>(
  promise: Promise<T>,
  ms: number,
  message: string,
  onTimeout: () => void,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          onTimeout()
          reject(new Error(message))
        }, ms)
        timer.unref()
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

// Agent message chunks arrive as session/update notifications with a single
// text content block; older revisions sent an array of blocks. Both read.
const chunkText = (update: Record<string, unknown>): string => {
  const content: unknown = update.content
  if (Array.isArray(content)) {
    return content
      .map((block) => (isRecord(block) && typeof block.text === "string" ? block.text : ""))
      .join("")
  }
  if (isRecord(content) && content.type === "text" && typeof content.text === "string") {
    return content.text
  }
  return ""
}

// Permission requests are auto-denied: pick a reject option when the agent
// offers one, else cancel the request. Anything else a server asks of the
// client is refused so an agent can never park a turn waiting on redline.
const denyPermission = (params: Record<string, unknown>): unknown => {
  const options = Array.isArray(params.options) ? params.options : []
  const rejectOption = options.find(
    (option) =>
      isRecord(option) && (option.kind === "reject_once" || option.kind === "reject_always"),
  )
  if (isRecord(rejectOption) && typeof rejectOption.optionId === "string") {
    return { outcome: { outcome: "selected", optionId: rejectOption.optionId } }
  }
  return { outcome: { outcome: "cancelled" } }
}

const openConnection = (argv: string[]): Connection => {
  const command = argv[0] ?? ""
  const proc = spawn(command, argv.slice(1), { stdio: ["pipe", "pipe", "pipe"] })
  const pending = new Map<number, Pending>()
  let nextId = 1
  let chunks = ""
  let stderrText = ""
  let exitDetail: string | undefined

  const rejectAll = (detail: string): void => {
    exitDetail = detail
    for (const entry of pending.values()) entry.reject(new Error(detail))
    pending.clear()
  }

  proc.on("error", (error) => {
    rejectAll(hasErrorCode(error, "ENOENT") ? "command not found: " + command : error.message)
  })

  proc.on("exit", (code, signal) => {
    const reason =
      code !== null ? "exited with code " + String(code) : "killed by signal " + String(signal)
    const stderr = stderrText.trim()
    rejectAll("acp agent " + reason + (stderr.length > 0 ? ": " + stderr : ""))
  })

  proc.stderr?.on("data", (chunk: Buffer) => {
    if (stderrText.length < stderrLimit) stderrText += chunk.toString()
  })
  proc.stderr?.on("error", () => undefined)
  proc.stdin?.on("error", () => undefined)

  const send = (message: unknown): void => {
    if (exitDetail !== undefined || proc.stdin === null) return
    proc.stdin.write(JSON.stringify(message) + "\n")
  }

  const request = (method: string, params: unknown): Promise<unknown> =>
    new Promise((resolve, reject) => {
      if (exitDetail !== undefined) {
        reject(new Error(exitDetail))
        return
      }
      const id = nextId++
      pending.set(id, { method, resolve, reject })
      send({ jsonrpc: "2.0", id, method, params })
    })

  const handleLine = (line: string): void => {
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (!isRecord(message)) return
    const id = typeof message.id === "number" ? message.id : undefined
    const method = typeof message.method === "string" ? message.method : undefined

    if (method !== undefined && id !== undefined) {
      if (method === "session/request_permission" && isRecord(message.params)) {
        send({ jsonrpc: "2.0", id, result: denyPermission(message.params) })
      } else {
        send({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: "redline client does not support " + method },
        })
      }
      return
    }
    if (method !== undefined) {
      if (method === "session/update" && isRecord(message.params)) {
        const update = message.params.update
        if (isRecord(update) && update.sessionUpdate === "agent_message_chunk") {
          chunks += chunkText(update)
        }
      }
      return
    }
    if (id === undefined) return
    const entry = pending.get(id)
    if (entry === undefined) return
    pending.delete(id)
    if (isRecord(message.error) && typeof message.error.message === "string") {
      entry.reject(new Error("acp " + entry.method + " failed: " + message.error.message))
      return
    }
    entry.resolve(message.result)
  }

  let buffer = ""
  const stdout = proc.stdout
  if (stdout !== null) {
    void (async () => {
      for await (const chunk of stdout) {
        buffer += String(chunk)
        for (;;) {
          const index = buffer.indexOf("\n")
          if (index < 0) break
          const line = buffer.slice(0, index).trim()
          buffer = buffer.slice(index + 1)
          if (line.length > 0) handleLine(line)
        }
      }
    })().catch(() => undefined)
  }

  return {
    request,
    resetChunks: () => {
      chunks = ""
    },
    takeChunks: () => chunks,
    kill: () => {
      proc.kill("SIGTERM")
      const timer = setTimeout(() => proc.kill("SIGKILL"), killGraceMs)
      timer.unref()
    },
    terminate: () =>
      new Promise((resolve) => {
        if (proc.exitCode !== null || proc.signalCode !== null) {
          resolve()
          return
        }
        let done = false
        const finish = (): void => {
          if (done) return
          done = true
          clearTimeout(timer)
          clearTimeout(backstop)
          resolve()
        }
        const timer = setTimeout(() => proc.kill("SIGKILL"), killGraceMs)
        timer.unref()
        const backstop = setTimeout(finish, killGraceMs * 2)
        backstop.unref()
        proc.once("exit", finish)
        proc.kill("SIGTERM")
      }),
  }
}

type InternalSession = {
  connection: Connection
  sessionId: string
  lane: Lane
  artifactId: string
  seed?: SeedSpec
  seeded: boolean
}

// The adapter always ships discard, so the concrete type requires it while
// staying assignable to HostAdapter.
export type AcpAdapter = HostAdapter & { discard: (session: AgentSession) => Promise<void> }

export const createAcpAdapter = (options: AcpAdapterOptions): AcpAdapter => {
  const timeoutSeconds = options.timeoutSeconds ?? defaultTimeoutSeconds
  const dutyTimeoutMs = timeoutSeconds * 1000
  const handshakeTimeoutMs = handshakeTimeoutSeconds * 1000
  const sessions = new Map<string, InternalSession>()
  let sessionCounter = 0

  const dropSession = (hostSessionId: string): void => {
    const state = sessions.get(hostSessionId)
    if (state === undefined) return
    sessions.delete(hostSessionId)
    state.connection.kill()
  }

  const handshake = async (connection: Connection, cwd?: string): Promise<string> => {
    const initResult = await withTimeout(
      connection.request("initialize", {
        protocolVersion: acpProtocolVersion,
        clientCapabilities: {},
        clientInfo: { name: "redline", title: "redline", version: "0.1.0" },
      }),
      handshakeTimeoutMs,
      "acp agent did not answer initialize within " + String(handshakeTimeoutSeconds) + "s",
      connection.kill,
    )
    const version = isRecord(initResult) ? initResult.protocolVersion : undefined
    if (version !== acpProtocolVersion) {
      throw new Error("acp agent speaks unsupported protocol version " + String(version))
    }
    // The artifact's project cwd when known, else wherever the daemon runs.
    const newResult = await withTimeout(
      connection.request("session/new", { cwd: cwd ?? process.cwd(), mcpServers: [] }),
      handshakeTimeoutMs,
      "acp agent did not answer session/new within " + String(handshakeTimeoutSeconds) + "s",
      connection.kill,
    )
    const sessionId =
      isRecord(newResult) && typeof newResult.sessionId === "string" ? newResult.sessionId : undefined
    if (sessionId === undefined) throw new Error("acp agent returned no sessionId")
    return sessionId
  }

  // First duty on a worker session carries the document. The seed-context
  // wording lives in duty.prompt.ts (shared with the opencode-sdk adapter);
  // this wrapper only owns the once-per-session tracking.
  const seedContext = async (hostSessionId: string, input: DutyInput): Promise<string> => {
    const state = sessions.get(hostSessionId)
    if (state === undefined || input.lane !== "worker" || state.seeded) return ""
    state.seeded = true
    return buildSeedContext(input, state.seed)
  }

  const ensureSession = async (
    lane: Lane,
    artifactId: string,
    seed?: SeedSpec,
    cwd?: string,
  ): Promise<AgentSession> => {
    const config = await options.getLaneConfig(lane)
    const argv = config.acpCommand
    if (argv.length === 0 || (argv[0] ?? "").length === 0) throw new Error("acp command is empty")
    const connection = openConnection(argv)
    sessionCounter += 1
    const hostSessionId = "acp-" + artifactId + "-" + String(sessionCounter)
    try {
      const sessionId = await handshake(connection, cwd)
      sessions.set(hostSessionId, { connection, sessionId, lane, artifactId, seed, seeded: false })
    } catch (error) {
      connection.kill()
      throw error
    }
    return { artifactId, lane, hostSessionId }
  }

  const runDuty = async (session: AgentSession, input: DutyInput): Promise<DutyResult> => {
    const state = sessions.get(session.hostSessionId)
    if (state === undefined) throw new Error("acp session is gone")
    const seedPrefix = await seedContext(session.hostSessionId, input)
    const base = buildLanePrompt(input)
    const prompt = seedPrefix.length > 0 ? seedPrefix + "\n\n" + base : base
    state.connection.resetChunks()
    await withTimeout(
      state.connection.request("session/prompt", {
        sessionId: state.sessionId,
        prompt: [{ type: "text", text: prompt }],
      }),
      dutyTimeoutMs,
      "duty timed out after " + String(timeoutSeconds) + "s",
      () => dropSession(session.hostSessionId),
    )
    const raw = state.connection.takeChunks()
    return parseLaneResult(input.lane, raw)
  }

  return {
    id: "acp",
    canNotifyOrigin: () => false,
    ensureSession,
    runDuty,
    discard: async (session) => {
      const state = sessions.get(session.hostSessionId)
      if (state === undefined) return
      sessions.delete(session.hostSessionId)
      await state.connection.terminate()
    },
  }
}
