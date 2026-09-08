// Fixture ACP agent for tests: speaks just enough JSON-RPC over stdio to
// initialize, open a session, and stream one prompt turn. Not shipped.
// Usage: bun fake-acp-agent.ts [--pid-file <path>] [--cwd-file <path>] [--silent-init] [--silent-prompt]

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
const silentInit = args.includes("--silent-init")
const silentPrompt = args.includes("--silent-prompt")

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
  if (prompt.includes("complete single-file HTML:")) return "note from inline prompt"
  return "fake iteration note"
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
    const payload = prompt.includes("Reply duty") ? repliesFrom(prompt) : buildDocument(noteFor(prompt))
    // Two chunks prove the client accumulates across messages.
    const half = Math.ceil(payload.length / 2)
    for (const text of [payload.slice(0, half), payload.slice(half)]) {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text },
          },
        },
      })
    }
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
    if (line.length > 0) await handle(line)
  }
}

// Module marker: top-level await needs this file to be a module.
export {}
