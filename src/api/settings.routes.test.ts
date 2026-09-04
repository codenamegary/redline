import { afterAll, describe, expect, it } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FastifyInstance } from "fastify"
import { z } from "zod"

import { buildServer } from "../server"
import { openStore } from "../store/artifact.store"
import { RedlineSettings, RedlineSettingsSchema } from "../store/settings.models"
import { settingsPath } from "../store/settings.store"
import { AcpProbe } from "../worker/probe"
import { DEFAULT_REVIEWER_PROMPT, DEFAULT_WORKER_PROMPT } from "../worker/prompts"

const homes: string[] = []
const apps: FastifyInstance[] = []

// ACP lanes probe with a real handshake now; inject a deterministic fake so
// argv fixtures like ["true"] keep meaning "passes".
const fakeProbeAcp: AcpProbe = async (argv) => {
  const command = argv[0] ?? ""
  if (command === "true") return { ok: true }
  if (command === "redline-no-such-binary-9x8y") {
    return { ok: false, detail: "command not found: " + command }
  }
  return { ok: false, detail: "exited with code 1" }
}

const makeApp = (): { app: FastifyInstance; home: string } => {
  const home = mkdtempSync(join(tmpdir(), "redline-settings-"))
  homes.push(home)
  const app = buildServer({ store: openStore(home), loggerLevel: "error", probeAcp: fakeProbeAcp })
  apps.push(app)
  return { app, home }
}

afterAll(async () => {
  for (const app of apps) await app.close()
  for (const home of homes) rmSync(home, { recursive: true, force: true })
})

const lane = (acpCommand: string[]) => ({
  adapter: "acp",
  preset: "opencode",
  acpCommand: acpCommand,
  model: "",
})

const readDisk = (home: string): RedlineSettings =>
  RedlineSettingsSchema.parse(JSON.parse(readFileSync(settingsPath(home), "utf8")))

describe("settings api", () => {
  it("returns shipped defaults when no settings file exists", async () => {
    const { app } = makeApp()
    const response = await app.inject({ method: "GET", url: "/api/v1/settings" })
    expect(response.statusCode).toBe(200)
    const body = RedlineSettingsSchema.parse(response.json())
    expect(body.reviewer).toEqual({
      adapter: "acp",
      preset: "opencode",
      acpCommand: ["opencode", "acp"],
      model: "",
    })
    expect(body.worker.acpCommand).toEqual(["opencode", "acp"])
    expect(body.notifyOrigin).toBe(true)
    expect(body.opencodeServerUrl).toBe("http://127.0.0.1:4096")
    expect(body.prompts.reviewer).toBe(DEFAULT_REVIEWER_PROMPT)
    expect(body.prompts.worker).toBe(DEFAULT_WORKER_PROMPT)
  })

  it("serves shipped prompts from /settings/defaults without probing or disk", async () => {
    const { app, home } = makeApp()
    const response = await app.inject({ method: "GET", url: "/api/v1/settings/defaults" })
    expect(response.statusCode).toBe(200)
    const body = z
      .object({ prompts: z.object({ reviewer: z.string(), worker: z.string() }) })
      .parse(response.json())
    expect(body).toEqual({
      prompts: { reviewer: DEFAULT_REVIEWER_PROMPT, worker: DEFAULT_WORKER_PROMPT },
    })
    expect(existsSync(settingsPath(home))).toBe(false)
  })

  it("saves on PUT, echoes saved values, and fills empty prompts on read", async () => {
    const { app, home } = makeApp()
    const response = await app.inject({
      method: "PUT",
      url: "/api/v1/settings",
      payload: {
        reviewer: lane(["true"]),
        worker: lane(["true"]),
        prompts: { reviewer: "my reviewer prompt", worker: "" },
      },
    })
    expect(response.statusCode).toBe(200)
    const saved = RedlineSettingsSchema.parse(response.json())
    expect(saved.reviewer.acpCommand).toEqual(["true"])
    expect(saved.notifyOrigin).toBe(true)
    expect(saved.opencodeServerUrl).toBe("http://127.0.0.1:4096")
    expect(saved.prompts.reviewer).toBe("my reviewer prompt")
    // Saved, not effective: the empty prompt echoes back empty.
    expect(saved.prompts.worker).toBe("")
    expect(readDisk(home).prompts.worker).toBe("")

    const read = await app.inject({ method: "GET", url: "/api/v1/settings" })
    const effective = RedlineSettingsSchema.parse(read.json())
    expect(effective.prompts.reviewer).toBe("my reviewer prompt")
    expect(effective.prompts.worker).toBe(DEFAULT_WORKER_PROMPT)
  })

  it("rejects unknown adapters with problem details", async () => {
    const { app } = makeApp()
    const response = await app.inject({
      method: "PUT",
      url: "/api/v1/settings",
      payload: {
        reviewer: { ...lane(["true"]), adapter: "carrier-pigeon" },
        worker: lane(["true"]),
      },
    })
    expect(response.statusCode).toBe(400)
    expect(response.headers["content-type"]).toContain("application/problem+json")
    expect(response.json()).toMatchObject({ type: "about:blank", status: 400 })
  })

  it("rejects a PUT when a lane probe fails and persists nothing", async () => {
    const { app, home } = makeApp()
    const response = await app.inject({
      method: "PUT",
      url: "/api/v1/settings",
      payload: {
        reviewer: lane(["false"]),
        worker: lane(["true"]),
        prompts: { reviewer: "", worker: "" },
      },
    })
    expect(response.statusCode).toBe(400)
    expect(response.headers["content-type"]).toContain("application/problem+json")
    expect(response.json()).toMatchObject({ status: 400, detail: "exited with code 1" })
    expect(existsSync(settingsPath(home))).toBe(false)
  })

  it("probes a lane command: ok, failing, and missing binary", async () => {
    const { app } = makeApp()

    const ok = await app.inject({
      method: "POST",
      url: "/api/v1/settings/probe",
      payload: { lane: "reviewer", adapter: "acp", acpCommand: ["true"] },
    })
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toMatchObject({ ok: true })

    const failing = await app.inject({
      method: "POST",
      url: "/api/v1/settings/probe",
      payload: { lane: "worker", adapter: "acp", acpCommand: ["false"] },
    })
    expect(failing.statusCode).toBe(422)
    expect(failing.headers["content-type"]).toContain("application/problem+json")
    expect(failing.json()).toMatchObject({ status: 422, detail: "exited with code 1" })

    const missing = await app.inject({
      method: "POST",
      url: "/api/v1/settings/probe",
      payload: {
        lane: "worker",
        adapter: "acp",
        acpCommand: ["redline-no-such-binary-9x8y"],
      },
    })
    expect(missing.statusCode).toBe(422)
    expect(missing.json()).toMatchObject({
      status: 422,
      detail: "command not found: redline-no-such-binary-9x8y",
    })
  })

  it("restores default prompts on reset and persists them", async () => {
    const { app, home } = makeApp()
    const saved = await app.inject({
      method: "PUT",
      url: "/api/v1/settings",
      payload: {
        reviewer: lane(["true"]),
        worker: lane(["true"]),
        prompts: { reviewer: "custom one", worker: "custom two" },
      },
    })
    expect(saved.statusCode).toBe(200)
    expect(readDisk(home).prompts.reviewer).toBe("custom one")

    const reset = await app.inject({ method: "POST", url: "/api/v1/settings/prompts/reset" })
    expect(reset.statusCode).toBe(200)
    const body = RedlineSettingsSchema.parse(reset.json())
    expect(body.prompts.reviewer).toBe(DEFAULT_REVIEWER_PROMPT)
    expect(body.prompts.worker).toBe(DEFAULT_WORKER_PROMPT)
    expect(readDisk(home).prompts.reviewer).toBe(DEFAULT_REVIEWER_PROMPT)

    const read = await app.inject({ method: "GET", url: "/api/v1/settings" })
    expect(RedlineSettingsSchema.parse(read.json()).prompts.reviewer).toBe(DEFAULT_REVIEWER_PROMPT)
  })

  it("falls back to defaults when settings.json is corrupt", async () => {
    const { app, home } = makeApp()
    writeFileSync(settingsPath(home), "{ this is not json", "utf8")
    const response = await app.inject({ method: "GET", url: "/api/v1/settings" })
    expect(response.statusCode).toBe(200)
    const body = RedlineSettingsSchema.parse(response.json())
    expect(body.prompts.reviewer).toBe(DEFAULT_REVIEWER_PROMPT)
    expect(body.notifyOrigin).toBe(true)
    expect(body.opencodeServerUrl).toBe("http://127.0.0.1:4096")
  })
})
