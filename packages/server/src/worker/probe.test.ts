import { describe, expect, it } from "bun:test"
import { join } from "node:path"

import { probeAcpHandshake } from "./probe"

const execPath = process.execPath
const fixturePath = join(import.meta.dir, "fake-acp-agent.ts")

describe("probeAcpHandshake", () => {
  it("passes when the agent answers initialize", async () => {
    const probe = await probeAcpHandshake([execPath, fixturePath], 8)
    expect(probe).toEqual({ ok: true })
  })

  it("fails with command not found for a missing binary", async () => {
    const probe = await probeAcpHandshake(["redline-no-such-binary-probe-4t"], 8)
    expect(probe).toEqual({
      ok: false,
      detail: "command not found: redline-no-such-binary-probe-4t",
    })
  })

  it("fails with detail when the command never speaks JSON-RPC", async () => {
    const probe = await probeAcpHandshake([execPath, "-e", "console.log('boop')"], 8)
    expect(probe.ok).toBe(false)
    if (!probe.ok) expect(probe.detail).toContain("no initialize response")
  })

  it("fails on timeout when the agent stays silent", async () => {
    const probe = await probeAcpHandshake([execPath, fixturePath, "--silent-init"], 1)
    expect(probe).toEqual({ ok: false, detail: "handshake timed out after 1s" })
  })
})
