// Sidebar preferences for the review page: width and collapsed state.
// Persisted to localStorage so the layout survives reloads.

export const SIDEBAR_DEFAULT_WIDTH = 360
export const SIDEBAR_MIN_WIDTH = 280
export const SIDEBAR_MAX_WIDTH = 720

export type SidebarPrefs = {
  collapsed: boolean
  width: number
}

const widthKey = "redline.sidebar.width"
const collapsedKey = "redline.sidebar.collapsed"

export const clampSidebarWidth = (width: number): number => {
  if (!Number.isFinite(width)) return SIDEBAR_DEFAULT_WIDTH
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)))
}

// Width the sidebar should take if the user drags to `clientX` in a viewport
// of `viewportWidth` (the sidebar hugs the right edge).
export const sidebarWidthFromDrag = (clientX: number, viewportWidth: number): number =>
  clampSidebarWidth(viewportWidth - clientX)

const readNumber = (key: string): number | undefined => {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return undefined
    return clampSidebarWidth(Number(raw))
  } catch {
    return undefined
  }
}

const readBool = (key: string): boolean | undefined => {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return undefined
    return raw === "true"
  } catch {
    return undefined
  }
}

export const loadSidebarPrefs = (): SidebarPrefs => ({
  collapsed: readBool(collapsedKey) ?? false,
  width: readNumber(widthKey) ?? SIDEBAR_DEFAULT_WIDTH,
})

export const saveSidebarPrefs = (prefs: SidebarPrefs): void => {
  try {
    localStorage.setItem(widthKey, String(clampSidebarWidth(prefs.width)))
    localStorage.setItem(collapsedKey, prefs.collapsed ? "true" : "false")
  } catch {
    return
  }
}
