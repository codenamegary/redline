// Agents often name artifacts after their own session ("redline - Fix nav").
// The word already anchors every redline header, so a leading "redline…"
// prefix reads as a stutter in the UI. Incoming titles are stripped of these
// patterns at creation; add a pattern here when a new variant shows up.
export const titleStripPatterns: RegExp[] = [/^redline\s*[-–—:]\s*/i]

export const stripTitlePrefixes = (title: string): string => {
  const stripped = titleStripPatterns.reduce(
    (current, pattern) => current.replace(pattern, ""),
    title.trimStart(),
  )
  return stripped.trim().length > 0 ? stripped : title
}
