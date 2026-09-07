import { afterAll, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runInNewContext } from "node:vm"

import { buildServer } from "../server"
import { openStore } from "../store/artifact.store"
import { splitCommandSource } from "./settings.page"

const home = mkdtempSync(join(tmpdir(), "redline-ui-"))
const app = buildServer({ store: openStore(home), loggerLevel: "error" })

afterAll(async () => {
  await app.close()
  rmSync(home, { recursive: true, force: true })
})

describe("ui routes", () => {
  it("serves the settings page with lane tabs", async () => {
    const response = await app.inject({ method: "GET", url: "/settings" })
    expect(response.statusCode).toBe(200)
    expect(response.headers["content-type"]).toContain("text/html")
    for (const marker of ["Settings", "Reviewer", "Worker", "Notify"]) {
      expect(response.body).toContain(marker)
    }
    // First paint shows only the active pane: inactive panes must carry the
    // hidden attribute before any tab click.
    expect(response.body).toContain('<section id="pane-reviewer" role="tabpanel" aria-labelledby="tab-reviewer">')
    expect(response.body).toContain('<section id="pane-worker" role="tabpanel" aria-labelledby="tab-worker" hidden>')
    expect(response.body).toContain('<section id="pane-notify" role="tabpanel" aria-labelledby="tab-notify" hidden>')
  })

  it("links Settings from the gallery header", async () => {
    const response = await app.inject({ method: "GET", url: "/" })
    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('href="/settings"')
  })

  it("renders the ding-when-done toggle in the shell header", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/artifacts",
      payload: { title: "Ding shell", html: "<h1>Ding</h1>" },
    })
    expect(created.statusCode).toBe(201)
    const { id } = created.json() as { id: string }
    const response = await app.inject({ method: "GET", url: "/a/" + id })
    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('<input type="checkbox" id="ding">')
    expect(response.body).toContain("ding when done")
    expect(response.body).toContain('localStorage.getItem("redline.ding")')
    expect(response.body).toContain('localStorage.setItem("redline.ding"')
    expect(response.body).toContain("maybeDing(prevStatus)")
  })

  it("splits command lines into argv, honoring double quotes", () => {
    // The page embeds this exact source; evaluating it keeps test and
    // browser behavior identical.
    const splitCommand = runInNewContext("(" + splitCommandSource + ")") as (
      line: string,
    ) => string[]
    expect(splitCommand("opencode acp")).toEqual(["opencode", "acp"])
    expect(splitCommand("  my-agent   --flag \"hello world\"  ")).toEqual([
      "my-agent",
      "--flag",
      "hello world",
    ])
    expect(splitCommand("gemini --experimental-acp")).toEqual(["gemini", "--experimental-acp"])
    expect(splitCommand('say "it\'s quoted" x')).toEqual(["say", "it's quoted", "x"])
    expect(splitCommand("   ")).toEqual([])
  })
})
