import { spawn } from "node:child_process"

import { hasErrorCode } from "../store/errors"

export type ProbeResult = { ok: true } | { ok: false; detail: string }

// A probe is a spawn smoke test, not an ACP handshake (a later phase adds
// that). The command passes if it exits 0 or is still running when the
// ready window closes; servers meant to run forever count as alive.
const readyWindowMs = 1500
const killGraceMs = 1000

export const probeLaneCommand = (argv: string[], timeoutSeconds = 8): Promise<ProbeResult> =>
  new Promise((resolve) => {
    const command = argv[0] ?? ""
    let settled = false
    let stderrText = ""
    const timers: ReturnType<typeof setTimeout>[] = []

    const child = spawn(command, argv.slice(1), { stdio: ["ignore", "ignore", "pipe"] })

    const finish = (result: ProbeResult): void => {
      if (settled) return
      settled = true
      for (const timer of timers) clearTimeout(timer)
      resolve(result)
    }

    child.stderr?.on("data", (chunk: Buffer) => {
      stderrText += chunk.toString()
    })

    child.on("error", (error) => {
      if (hasErrorCode(error, "ENOENT")) {
        finish({ ok: false, detail: "command not found: " + command })
        return
      }
      finish({ ok: false, detail: error.message })
    })

    child.on("exit", (code) => {
      if (code === 0) {
        finish({ ok: true })
        return
      }
      const detail = stderrText.trim()
      finish({
        ok: false,
        detail: detail.length > 0 ? detail : "exited with code " + String(code),
      })
    })

    // Still alive when the window closes: a pass. Tear the process down —
    // SIGTERM first, SIGKILL if it ignores the polite ask.
    timers.push(
      setTimeout(() => {
        finish({ ok: true })
        child.kill("SIGTERM")
        timers.push(setTimeout(() => child.kill("SIGKILL"), killGraceMs))
      }, readyWindowMs),
    )

    // Hard deadline so an unkillable child can never hang the probe.
    timers.push(
      setTimeout(() => {
        finish({ ok: true })
        child.kill("SIGKILL")
      }, timeoutSeconds * 1000),
    )
  })
