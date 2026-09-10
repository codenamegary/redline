import { spawn } from "node:child_process"

import { hasErrorCode } from "../store/errors"

export type ProbeResult = { ok: true } | { ok: false; detail: string }

// Injectable seam for tests: any function with the handshake probe shape.
export type AcpProbe = (argv: string[], timeoutSeconds?: number) => Promise<ProbeResult>

const killGraceMs = 1000

const stderrLimit = 4000

// A real ACP handshake probe: spawn, send initialize, and require a JSON-RPC
// response before the deadline. An "acp" lane must actually speak the
// protocol, not merely spawn.
export const probeAcpHandshake = (argv: string[], timeoutSeconds = 8): Promise<ProbeResult> =>
  new Promise((resolve) => {
    const command = argv[0] ?? ""
    let settled = false
    let stderrText = ""
    const timers: ReturnType<typeof setTimeout>[] = []

    const child = spawn(command, argv.slice(1), { stdio: ["pipe", "pipe", "pipe"] })

    const finish = (result: ProbeResult): void => {
      if (settled) return
      settled = true
      for (const timer of timers) clearTimeout(timer)
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM")
        const killTimer = setTimeout(() => child.kill("SIGKILL"), killGraceMs)
        killTimer.unref()
      }
      resolve(result)
    }

    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrText.length < stderrLimit) stderrText += chunk.toString()
    })
    child.stderr?.on("error", () => undefined)
    child.stdin?.on("error", () => undefined)

    child.on("error", (error) => {
      if (hasErrorCode(error, "ENOENT")) {
        finish({ ok: false, detail: "command not found: " + command })
        return
      }
      finish({ ok: false, detail: error.message })
    })

    child.on("exit", (code) => {
      const stderr = stderrText.trim()
      finish({
        ok: false,
        detail:
          "no initialize response: exited with code " +
          String(code) +
          (stderr.length > 0 ? ": " + stderr : ""),
      })
    })

    child.stdout?.on("data", (chunk: Buffer) => {
      const lines = chunk.toString().split("\n")
      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed.length === 0) continue
        let message: unknown
        try {
          message = JSON.parse(trimmed)
        } catch {
          continue
        }
        if (typeof message !== "object" || message === null) continue
        const record = message as Record<string, unknown>
        if (record.id !== 1) continue
        if (typeof record.error === "object" && record.error !== null) {
          const detail = (record.error as Record<string, unknown>).message
          finish({
            ok: false,
            detail: "initialize failed: " + (typeof detail === "string" ? detail : "unknown error"),
          })
          return
        }
        finish({ ok: true })
        return
      }
    })

    // Keep stdin open: agents idle reading it, and closing it could end
    // them before they answer.
    child.stdin?.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: "redline-probe", version: "0.0.0" },
        },
      }) + "\n",
    )

    // Hard deadline so a silent child can never hang the probe.
    timers.push(
      setTimeout(() => {
        finish({ ok: false, detail: "handshake timed out after " + String(timeoutSeconds) + "s" })
      }, timeoutSeconds * 1000),
    )
  })
