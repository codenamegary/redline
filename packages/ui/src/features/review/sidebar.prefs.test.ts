import { beforeEach, describe, expect, it } from "vitest"
import {
  clampSidebarWidth,
  loadSidebarPrefs,
  saveSidebarPrefs,
  sidebarWidthFromDrag,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from "./sidebar.prefs"

describe("clampSidebarWidth", () => {
  it("keeps in-range widths as-is", () => {
    expect(clampSidebarWidth(500)).toBe(500)
  })

  it("clamps below the minimum", () => {
    expect(clampSidebarWidth(20)).toBe(SIDEBAR_MIN_WIDTH)
  })

  it("clamps above the maximum", () => {
    expect(clampSidebarWidth(5000)).toBe(SIDEBAR_MAX_WIDTH)
  })

  it("falls back to the default for non-finite values", () => {
    expect(clampSidebarWidth(Number.NaN)).toBe(SIDEBAR_DEFAULT_WIDTH)
  })
})

describe("sidebarWidthFromDrag", () => {
  it("measures from the right viewport edge", () => {
    expect(sidebarWidthFromDrag(640, 1000)).toBe(360)
  })

  it("clamps to the minimum when dragged far right", () => {
    expect(sidebarWidthFromDrag(980, 1000)).toBe(SIDEBAR_MIN_WIDTH)
  })
})

describe("loadSidebarPrefs / saveSidebarPrefs", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it("defaults when nothing is stored", () => {
    expect(loadSidebarPrefs()).toEqual({ collapsed: false, width: SIDEBAR_DEFAULT_WIDTH })
  })

  it("round-trips width and collapsed state", () => {
    saveSidebarPrefs({ collapsed: true, width: 480 })
    expect(loadSidebarPrefs()).toEqual({ collapsed: true, width: 480 })
  })

  it("clamps an out-of-range stored width on load", () => {
    localStorage.setItem("redline.sidebar.width", "99999")
    expect(loadSidebarPrefs().width).toBe(SIDEBAR_MAX_WIDTH)
  })

  it("falls back to defaults for corrupt values", () => {
    localStorage.setItem("redline.sidebar.width", "wide")
    localStorage.setItem("redline.sidebar.collapsed", "maybe")
    expect(loadSidebarPrefs()).toEqual({ collapsed: false, width: SIDEBAR_DEFAULT_WIDTH })
  })
})
