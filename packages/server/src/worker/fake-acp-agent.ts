// Fixture ACP agent for tests: speaks just enough JSON-RPC over stdio to
// initialize, open a session, and stream one prompt turn. Not shipped.
// Usage: bun fake-acp-agent.ts [--pid-file <path>] [--cwd-file <path>] [--silent-init] [--silent-prompt] [--tool-call]

type UnknownRecord = Record<string, unknown>

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null

const args = process.argv.slice(2)
const flagValue = (name: string): string | undefined => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
const pidFile = flagValue("--pid-file")
const cwdFile = flagValue("--cwd-file")
const readPath = flagValue("--read")
const permissionReadPath = flagValue("--permission-read")
const permissionWritePath = flagValue("--permission-write")
const promptFile = flagValue("--prompt-file")
const silentInit = args.includes("--silent-init")
const silentPrompt = args.includes("--silent-prompt")
const toolCall = args.includes("--tool-call")
const truncateOnce = args.includes("--truncate-once")
const truncateAlways = args.includes("--truncate-always")
const truncateStall = args.includes("--truncate-stall")

// Prompt turns this fixture has served. Also written to --prompt-file so
// tests can assert how many continuation prompts the adapter sent.
let promptCount = 0
let pendingTail = ""

// Outgoing requests from the fake agent to the client (fs/read_text_file and
// friends). The response arrives as a JSON-RPC message with the same id.
const pending = new Map<number, (response: UnknownRecord) => void>()
let nextOutgoingId = 5000

const requestClient = (method: string, params: Record<string, unknown>): Promise<UnknownRecord> =>
  new Promise((resolve) => {
    nextOutgoingId += 1
    pending.set(nextOutgoingId, resolve)
    send({ jsonrpc: "2.0", id: nextOutgoingId, method: method, params: params })
  })

// Ask the client for tool permission and encode the outcome in the note.
const permissionMarker = async (sessionId: unknown): Promise<string> => {
  const ask =
    permissionReadPath !== undefined
      ? { path: permissionReadPath, kind: "read" }
      : permissionWritePath !== undefined
        ? { path: permissionWritePath, kind: "edit" }
        : undefined
  if (ask === undefined) return ""
  const response = await requestClient("session/request_permission", {
    sessionId: sessionId,
    toolCall: {
      toolCallId: "perm-1",
      title: "Touch " + ask.path,
      kind: ask.kind,
      status: "pending",
      locations: [{ path: ask.path }],
    },
    options: [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "allow-always", name: "Allow always", kind: "allow_always" },
      { optionId: "reject-once", name: "Reject", kind: "reject_once" },
    ],
  })
  const outcome =
    isRecord(response.result) && isRecord(response.result.outcome) ? response.result.outcome : {}
  return outcome.outcome === "selected" &&
    typeof outcome.optionId === "string" &&
    outcome.optionId.startsWith("allow")
    ? "perm-allow"
    : "perm-deny"
}

// Fold the client's answer into the note so tests can assert on the read
// through the parsed document.
const readMarker = async (sessionId: unknown): Promise<string> => {
  if (readPath === undefined) return ""
  const response = await requestClient("fs/read_text_file", { sessionId: sessionId, path: readPath })
  if (isRecord(response.error)) {
    const message = response.error.message
    return "read-error: " + (typeof message === "string" ? message : "unknown")
  }
  const content = isRecord(response.result) && typeof response.result.content === "string"
    ? response.result.content
    : ""
  return "read-ok content=" + content.slice(0, 64)
}

if (pidFile !== undefined) await Bun.write(pidFile, String(process.pid))

const send = (message: unknown): void => {
  process.stdout.write(JSON.stringify(message) + "\n")
}

const repliesFrom = (prompt: string): string => {
  const items: { threadId: string; messageId: string; body: string }[] = []
  for (const match of prompt.matchAll(/threadId ([^,\s)]+), messageId ([^,\s)]+)/g)) {
    const threadId = match[1] ?? ""
    const messageId = match[2] ?? ""
    items.push({ threadId, messageId, body: "reply to " + messageId })
  }
  return JSON.stringify(items)
}

// The note encodes which seed mode the adapter used, so tests can assert on
// prompt shape through the parsed document.
const noteFor = (prompt: string): string => {
  if (prompt.includes("is on disk as one complete single-file HTML document")) return "note from pointer prompt"
  return "fake iteration note"
}

// Two chunks prove the client accumulates across messages.
const emitText = (sessionId: unknown, text: string): void => {
  const half = Math.ceil(text.length / 2)
  for (const part of [text.slice(0, half), text.slice(half)]) {
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: part },
        },
      },
    })
  }
}

const handle = async (line: string): Promise<void> => {
  let message: unknown
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  if (!isRecord(message)) return
  const id = typeof message.id === "number" ? message.id : undefined
  const method = typeof message.method === "string" ? message.method : undefined

  // Response to one of our outgoing client requests.
  if (method === undefined && id !== undefined) {
    const resolve = pending.get(id)
    if (resolve === undefined) return
    pending.delete(id)
    resolve(message)
    return
  }

  if (method === "initialize" && id !== undefined) {
    if (silentInit) return
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {},
        agentInfo: { name: "fake-acp", version: "0.0.0" },
      },
    })
    return
  }
  if (method === "session/new" && id !== undefined) {
    const params = isRecord(message.params) ? message.params : {}
    if (cwdFile !== undefined && typeof params.cwd === "string") {
      await Bun.write(cwdFile, params.cwd)
    }
    send({ jsonrpc: "2.0", id, result: { sessionId: "sess-fake-" + String(id) } })
    return
  }
  if (method === "session/prompt" && id !== undefined) {
    if (silentPrompt) return
    const params = isRecord(message.params) ? message.params : {}
    const blocks = Array.isArray(params.prompt) ? params.prompt : []
    const prompt = blocks
      .map((block) => (isRecord(block) && typeof block.text === "string" ? block.text : ""))
      .join("\n")
    promptCount += 1
    if (promptFile !== undefined) await Bun.write(promptFile, String(promptCount))

    const markers = [await readMarker(params.sessionId), await permissionMarker(params.sessionId)]
      .filter((marker) => marker.length > 0)
      .join(" ")
    const payload = prompt.includes("Reply duty")
      ? repliesFrom(prompt)
      : buildDocument(noteFor(prompt) + (markers.length > 0 ? " " + markers : ""))
    if (toolCall) {
      const emit = (update: Record<string, unknown>): void => {
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: { sessionId: params.sessionId, update: update },
        })
      }
      emit({ sessionUpdate: "tool_call", title: "Read file" })
      emit({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Checking the layout first." } })
      emit({ sessionUpdate: "tool_call_update", title: "Read file", status: "completed" })
    }
    if (truncateAlways) {
      emitText(params.sessionId, payload.slice(0, Math.ceil(payload.length / 2)))
      send({ jsonrpc: "2.0", id, result: { stopReason: "max_tokens" } })
      return
    }
    if ((truncateOnce || truncateStall) && promptCount === 1) {
      const half = Math.ceil(payload.length / 2)
      emitText(params.sessionId, payload.slice(0, half))
      pendingTail = payload.slice(half)
      send({ jsonrpc: "2.0", id, result: { stopReason: "max_tokens" } })
      return
    }
    if (truncateStall && promptCount > 1) {
      // A continuation that adds nothing: the client must stop retrying.
      send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } })
      return
    }
    if (pendingTail.length > 0) {
      const tail = pendingTail
      pendingTail = ""
      emitText(params.sessionId, tail)
      send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } })
      return
    }
    emitText(params.sessionId, payload)
    send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } })
  }
}

const buildDocument = (note: string): string =>
  "<!doctype html>\n<!-- redline-note: " +
  note +
  " -->\n<html><body><p>fake v-next</p></body></html>"

let buffer = ""
for await (const chunk of process.stdin) {
  buffer += String(chunk)
  for (;;) {
    const index = buffer.indexOf("\n")
    if (index < 0) break
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    // Do not await: a handler may itself be waiting on a client response,
    // and the stdin loop must keep pumping lines to deliver it.
    if (line.length > 0) void handle(line).catch(() => undefined)
  }
}

// Module marker: top-level await needs this file to be a module.
export {}
