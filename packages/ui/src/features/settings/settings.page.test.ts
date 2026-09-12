import { describe, expect, it } from "vitest"
import { laneConfigFrom, splitCommand } from "./SettingsPage"

describe("splitCommand", () => {
  it("splits on whitespace and honors double quotes", () => {
    expect(splitCommand('opencode acp --model "big model"')).toEqual([
      "opencode",
      "acp",
      "--model",
      "big model",
    ])
    expect(splitCommand("  spaced \t out  ")).toEqual(["spaced", "out"])
    expect(splitCommand("")).toEqual([])
  })
})

describe("laneConfigFrom", () => {
  it("always saves the acp adapter", () => {
    const config = laneConfigFrom({ preset: "custom", command: "opencode acp" })
    expect(config.adapter).toBe("acp")
    expect(config.acpCommand).toEqual(["opencode", "acp"])
  })
})
