import { describe, expect, it } from "vitest"
import { splitCommand } from "./SettingsPage"

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
