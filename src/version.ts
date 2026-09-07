declare const REDLINE_VERSION: string | undefined

export const appVersion = (): string =>
  typeof REDLINE_VERSION === "string" ? REDLINE_VERSION : "dev"
