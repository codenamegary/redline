export type StoreErrorKind = "not-found" | "conflict" | "unprocessable"

export type StoreError = Error & { kind: StoreErrorKind }

export const storeError = (kind: StoreErrorKind, message: string): StoreError =>
  Object.assign(new Error(message), { kind })

export const isStoreError = (error: unknown): error is StoreError =>
  error instanceof Error && "kind" in error && typeof error.kind === "string"

export const hasErrorCode = (error: unknown, code: string): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === code
