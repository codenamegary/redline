export type ProblemDetails = {
  type: string
  title: string
  status: number
  detail?: string
}

export class ApiError extends Error {
  readonly status: number
  readonly problem: ProblemDetails | undefined

  constructor(message: string, status: number, problem?: ProblemDetails) {
    super(message)
    this.name = "ApiError"
    this.status = status
    this.problem = problem
  }
}

const isProblemDetails = (value: unknown): value is ProblemDetails =>
  typeof value === "object" && value !== null && "title" in value && "status" in value

const parseBody = async (response: Response): Promise<unknown> => {
  const text = await response.text()
  if (text.length === 0) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export const request = async (path: string, init?: RequestInit): Promise<unknown> => {
  const response = await fetch(path, init)
  const body = await parseBody(response)
  if (!response.ok) {
    const problem = isProblemDetails(body) ? body : undefined
    const message = problem?.detail ?? problem?.title ?? "request failed (" + String(response.status) + ")"
    throw new ApiError(message, response.status, problem)
  }
  return body
}

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method: method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
})

export const httpGet = (path: string): Promise<unknown> => request(path)

export const httpPost = (path: string, body: unknown): Promise<unknown> =>
  request(path, jsonInit("POST", body))

export const httpPatch = (path: string, body: unknown): Promise<unknown> =>
  request(path, jsonInit("PATCH", body))

export const httpPut = (path: string, body: unknown): Promise<unknown> =>
  request(path, jsonInit("PUT", body))
