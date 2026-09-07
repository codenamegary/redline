import { afterAll, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Script, runInNewContext } from "node:vm"
import { z } from "zod"

import { buildServer } from "../server"
import { openStore } from "../store/artifact.store"
import { splitCommandSource } from "./settings.page"
import { clientScript } from "./shell.page"

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

  it("renders the shell header pill from the current version's approval state", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/artifacts",
      payload: { title: "Approve pill", html: "<p>v1</p>" },
    })
    expect(created.statusCode).toBe(201)
    const artifact = z.object({ id: z.string() }).parse(created.json())

    // Issue #6: before approval the header reads "in review" as before.
    const reviewPage = await app.inject({ url: "/a/" + artifact.id })
    expect(reviewPage.statusCode).toBe(200)
    expect(reviewPage.body).toContain('<span id="status" class="pill review">in review</span>')

    const approved = await app.inject({
      method: "POST",
      url: "/api/v1/artifacts/" + artifact.id + "/versions/v1/approve",
    })
    expect(approved.statusCode).toBe(200)

    // Approval is an approvedAt stamp, not a loop status: the shell must
    // derive the pill from the current version row, not artifactStatus.
    const approvedPage = await app.inject({ url: "/a/" + artifact.id })
    expect(approvedPage.statusCode).toBe(200)
    expect(approvedPage.body).toContain('<span id="status" class="pill approved">approved</span>')
    expect(approvedPage.body).not.toContain('class="pill review">in review<')
  })

  it("shell client script parses and flips the header on approval", () => {
    // Parse-only: compiling the script never runs it, so no DOM is needed.
    expect(() => new Script(clientScript)).not.toThrow()
    // The header renderer must consult the current version's approvedAt.
    expect(clientScript).toContain("function currentApprovedAt()")
    expect(clientScript).toContain('approved ? "approved" : iterating ? "iterating" : review ? "in review" : "draft"')
    expect(clientScript).toContain("approveBtn.disabled = !review || approved")
  })
})
