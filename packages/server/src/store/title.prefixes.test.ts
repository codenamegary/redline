import { describe, expect, it } from "bun:test"
import { stripTitlePrefixes, titleStripPatterns } from "./title.prefixes"

describe("stripTitlePrefixes", () => {
  it("strips 'redline' session-name prefixes from the start of a title", () => {
    expect(stripTitlePrefixes("redline - Fix nav overlap")).toBe("Fix nav overlap")
    expect(stripTitlePrefixes("redline: Fix nav overlap")).toBe("Fix nav overlap")
    expect(stripTitlePrefixes("redline — Fix nav overlap")).toBe("Fix nav overlap")
    expect(stripTitlePrefixes("Redline - Fix nav overlap")).toBe("Fix nav overlap")
    expect(stripTitlePrefixes("redline-Fix nav overlap")).toBe("Fix nav overlap")
  })

  it("leaves titles that do not start with a redline prefix alone", () => {
    expect(stripTitlePrefixes("Dashboard redesign")).toBe("Dashboard redesign")
    expect(stripTitlePrefixes("redlined edits for the nav")).toBe("redlined edits for the nav")
    expect(stripTitlePrefixes("Auth flow — decision record")).toBe("Auth flow — decision record")
  })

  it("keeps the original title when stripping would leave it empty", () => {
    expect(stripTitlePrefixes("redline - ")).toBe("redline - ")
    expect(stripTitlePrefixes("redline:")).toBe("redline:")
  })

  it("exposes an expandable pattern list driving the strip", () => {
    expect(Array.isArray(titleStripPatterns)).toBe(true)
    expect(titleStripPatterns.length).toBeGreaterThan(0)
  })
})
