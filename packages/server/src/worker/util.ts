export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

// fetch failures wrap the underlying cause (ECONNREFUSED etc.); surface it
// so a dead or misconfigured server reads clearly in error lines.
export const errorDetail = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error)
  const cause = (error as Error & { cause?: unknown }).cause
  return cause instanceof Error ? error.message + ": " + cause.message : error.message
}
