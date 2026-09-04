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
  })

  it("links Settings from the gallery header", async () => {
    const response = await app.inject({ method: "GET", url: "/" })
    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('href="/settings"')
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
