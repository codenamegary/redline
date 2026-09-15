import { spawn } from "node:child_process"
import { readFile, realpath, stat } from "node:fs/promises"
import { dirname, isAbsolute, relative } from "node:path"

import { hasErrorCode } from "../store/errors"
import { LaneConfig } from "@redline/http-contracts/settings.models"
import { buildLanePrompt, buildSeedContext, documentComplete, parseLaneResult } from "./duty.prompt"
import { AgentSession, DutyInput, DutyResult, HostAdapter, Lane, SeedSpec } from "./host.adapter"
import { isRecord } from "./util"

// Workers can run long: a big iteration (whole-page rework, asset-heavy
// publish) easily exceeds five minutes. Duties have no time limit — the
// session log shows progress and the user can stop a round explicitly.
// Handshakes (initialize + session/new) are still bounded: a fixed deadline
// keeps a wedged agent from holding a spawn forever.
const handshakeTimeoutSeconds = 15
const killGraceMs = 1000
const stderrLimit = 4000
// Session log ring: keep the tail so a long duty cannot grow memory.
const logLimit = 100_000
// ACP has no portable model selector; custom presets bake model into argv.
const acpProtocolVersion = 1
// Ceiling for one client-side fs/read_text_file response. The seed file can
// be big but never unbounded.
const defaultMaxReadBytes = 10_000_000
// A worker document is an output stream: this many continuation prompts are
// allowed before the duty fails. Bounded so a stuck model cannot hold the
// lane forever.
const workContinuationLimit = 6
const continuationPrompt =
  "Your previous output was cut off mid-document. Continue at the exact character where it " +
  "stopped. Do not repeat anything already emitted. Do not restart. No preamble."

export type AcpAdapterOptions = {
  getLaneConfig: (lane: Lane) => LaneConfig | Promise<LaneConfig>
  // Test seam / deployment cap for a single read served to the agent.
  maxReadBytes?: number
}

type Pending = { method: string; resolve: (value: unknown) => void; reject: (error: Error) => void }

type Connection = {
  request: (method: string, params: unknown) => Promise<unknown>
  resetChunks: () => void
  takeChunks: () => string
  readLog: () => string
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
// Tool lines read best with a stable label; some agents omit the title.
const toolTitle = (update: Record<string, unknown>): string =>
  typeof update.title === "string" && update.title.length > 0 ? update.title : "tool"

// Pick the first offered option whose kind is in the allowed set.
const selectPermission = (params: Record<string, unknown>, kinds: string[]): unknown => {
  const options = Array.isArray(params.options) ? params.options : []
  for (const kind of kinds) {
    const option = options.find((entry) => isRecord(entry) && entry.kind === kind)
    if (isRecord(option) && typeof option.optionId === "string") {
      return { outcome: { outcome: "selected", optionId: option.optionId } }
    }
  }
  return { outcome: { outcome: "cancelled" } }
}

// True when target sits inside root (or is root itself). Both are canonical
// absolute paths, so a relative segment that climbs out fails the check.
const isWithinRoot = (root: string, target: string): boolean => {
  const rel = relative(root, target)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

// Read-only tool calls are allowed when every location resolves inside the
// session's read roots. Writes, execution, and anything we cannot verify
// stay denied.
const permissionResponse = async (
  params: Record<string, unknown>,
  roots: Promise<string[]>,
): Promise<unknown> => {
  const toolCall = isRecord(params.toolCall) ? params.toolCall : undefined
  const locations =
    toolCall !== undefined && Array.isArray(toolCall.locations) ? toolCall.locations : []
  if (toolCall?.kind === "read" && locations.length > 0) {
    const paths = locations.map((location) =>
      isRecord(location) && typeof location.path === "string" ? location.path : undefined,
    )
    if (paths.every((path): path is string => path !== undefined)) {
      const canonical = await Promise.all(paths.map((path) => realpath(path).catch(() => undefined)))
      const allowedRoots = await roots
      if (
        allowedRoots.length > 0 &&
        canonical.every(
          (path) => path !== undefined && allowedRoots.some((root) => isWithinRoot(root, path)),
        )
      ) {
        return selectPermission(params, ["allow_once", "allow_always"])
      }
    }
  }
  return selectPermission(params, ["reject_once", "reject_always"])
}

const openConnection = (
  argv: string[],
  options?: { readRoots?: string[]; maxReadBytes?: number },
): Connection => {
  const command = argv[0] ?? ""
  const proc = spawn(command, argv.slice(1), { stdio: ["pipe", "pipe", "pipe"] })
  const pending = new Map<number, Pending>()
  let nextId = 1
  let chunks = ""
  let log = ""
  let stderrText = ""
  let exitDetail: string | undefined
  const maxReadBytes = options?.maxReadBytes ?? defaultMaxReadBytes
  // Canonicalize once: symlinked roots (macOS /tmp, /var) must line up with
  // the canonicalized request path. Roots that cannot be resolved never match.
  const readRoots = Promise.all(
    (options?.readRoots ?? []).map((root) => realpath(root).catch(() => undefined)),
  ).then((roots) => roots.filter((root): root is string => root !== undefined))

  // Human-readable session transcript: agent text as-is, tool activity as
  // one line each. Tail-capped.
  const appendLog = (text: string): void => {
    log = (log + text).slice(-logLimit)
  }

  const rejectAll = (detail: string): void => {
    exitDetail = detail
    for (const entry of pending.values()) entry.reject(new Error(detail))
    pending.clear()
  }

  // The agent asks the client to read a file (ACP client method). Serve only
  // canonical paths under the session's read roots, cap the payload, and
  // honor the protocol's line/limit window.
  const serveRead = async (params: Record<string, unknown>): Promise<{ content: string }> => {
    const requested = typeof params.path === "string" ? params.path : undefined
    if (requested === undefined || requested.length === 0) {
      throw new Error("fs/read_text_file requires a path")
    }
    const resolved = await realpath(requested)
    const roots = await readRoots
    if (!roots.some((root) => isWithinRoot(root, resolved))) {
      throw new Error("path is outside the allowed read roots: " + requested)
    }
    const info = await stat(resolved)
    if (!info.isFile()) throw new Error("not a regular file: " + requested)
    if (info.size > maxReadBytes) {
      throw new Error("file exceeds the " + String(maxReadBytes) + " byte read limit: " + requested)
    }
    let content = await readFile(resolved, "utf8")
    const line = typeof params.line === "number" ? params.line : undefined
    const limit = typeof params.limit === "number" ? params.limit : undefined
    if (line !== undefined || limit !== undefined) {
      const lines = content.split("\n")
      const start = Math.max((line ?? 1) - 1, 0)
      content = lines.slice(start, limit === undefined ? undefined : start + limit).join("\n")
    }
    return { content: content }
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
        void permissionResponse(message.params, readRoots).then(
          (result) => send({ jsonrpc: "2.0", id, result }),
          () => send({ jsonrpc: "2.0", id, result: { outcome: { outcome: "cancelled" } } }),
        )
      } else if (method === "fs/read_text_file" && isRecord(message.params)) {
        void serveRead(message.params).then(
          (result) => send({ jsonrpc: "2.0", id, result }),
          (error: unknown) => {
            const detail = error instanceof Error ? error.message : String(error)
            send({ jsonrpc: "2.0", id, error: { code: -32000, message: detail } })
          },
        )
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
        if (isRecord(update)) {
          const kind = update.sessionUpdate
          if (kind === "agent_message_chunk") {
            const text = chunkText(update)
            chunks += text
            appendLog(text)
          } else if (kind === "agent_thought_chunk") {
            // The agent's working narration — most of what a long duty
            // emits before the final document.
            appendLog(chunkText(update))
          } else if (kind === "tool_call") {
            appendLog("\n[tool] " + toolTitle(update) + "\n")
          } else if (kind === "tool_call_update") {
            // Tool output streams in as content; completed/failed get a
            // marker line so runs read as a transcript.
            const text = chunkText(update)
            if (text.length > 0) appendLog(text)
            if (update.status === "completed" || update.status === "failed") {
              appendLog("\n[" + (update.status === "failed" ? "failed" : "done") + "] " + toolTitle(update) + "\n")
            }
          }
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
    readLog: () => log,
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
  // wording lives in duty.prompt.ts; this wrapper only owns the
  // once-per-session tracking.
  const seedContext = async (hostSessionId: string, input: DutyInput): Promise<string> => {
    const state = sessions.get(hostSessionId)
    if (state === undefined || input.lane !== "worker" || state.seeded) return ""
    state.seeded = true
    return buildSeedContext(state.seed)
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
    // Worker sessions may read the seed file (artifact dir) and the project
    // that produced it. Reviewer sessions get no read roots: their contract
    // is thread text only.
    const readRoots =
      lane === "worker"
        ? [seed === undefined ? undefined : dirname(seed.path), cwd].filter(
            (root): root is string => root !== undefined,
          )
        : []
    const connection = openConnection(argv, {
      readRoots: readRoots,
      maxReadBytes: options.maxReadBytes,
    })
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
    const promptTurn = (text: string): Promise<unknown> =>
      // No duty timeout: the turn ends when the agent ends it, the process
      // dies, or the user stops the round (interrupt kills the connection,
      // which rejects the in-flight prompt request).
      state.connection.request("session/prompt", {
        sessionId: state.sessionId,
        prompt: [{ type: "text", text: text }],
      })
    await promptTurn(prompt)
    let raw = state.connection.takeChunks()
    // A worker document is delivered as an output stream, so a turn can end
    // mid-document when the model hits its reply budget. Continue the stream
    // until it closes; a turn that adds nothing means the model is stuck, so
    // stop early rather than burning the whole cap. A complete document is
    // done even when the harness reports max_tokens.
    if (input.lane === "worker") {
      let continuations = 0
      while (!documentComplete(raw) && continuations < workContinuationLimit) {
        const before = raw.length
        continuations += 1
        await promptTurn(continuationPrompt)
        raw = state.connection.takeChunks()
        if (raw.length === before) break
      }
      if (!documentComplete(raw) && /<html|<!doctype/i.test(raw)) {
        throw new Error("worker output truncated")
      }
    }
    return parseLaneResult(input.lane, raw)
  }

  return {
    id: "acp",
    ensureSession,
    runDuty,
    interrupt: (session) => {
      dropSession(session.hostSessionId)
    },
    sessionLog: (session) => {
      const state = sessions.get(session.hostSessionId)
      return state === undefined ? "" : state.connection.readLog()
    },
    discard: async (session) => {
      const state = sessions.get(session.hostSessionId)
      if (state === undefined) return
      sessions.delete(session.hostSessionId)
      await state.connection.terminate()
    },
  }
}
