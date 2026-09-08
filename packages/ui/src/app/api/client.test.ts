import { afterEach, describe, expect, it, vi } from "vitest"

import { ApiError } from "./client"
import { request } from "./client"

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(body === undefined ? "" : JSON.stringify(body), {
    status: status,
    headers: { "content-type": status >= 400 ? "application/problem+json" : "application/json" },
  })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("request", () => {
  it("returns parsed JSON on success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { ok: true })))
    await expect(request("/x")).resolves.toEqual({ ok: true })
  })

  it("throws ApiError with the problem detail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(409, { type: "about:blank", title: "Conflict", status: 409, detail: "worker busy" }),
      ),
    )
    const error = await request("/x").catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).message).toBe("worker busy")
    expect((error as ApiError).status).toBe(409)
    expect((error as ApiError).problem?.title).toBe("Conflict")
  })

  it("falls back to the title when no detail is present", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(404, { title: "Not found", status: 404 })))
    const error = await request("/x").catch((caught: unknown) => caught)
    expect((error as ApiError).message).toBe("Not found")
  })
})
