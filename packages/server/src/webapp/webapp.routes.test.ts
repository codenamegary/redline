import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import Fastify from "fastify"

import { registerWebappRoutes } from "./routes"

const makeWebDir = (withIndex: boolean): string => {
  const dir = mkdtempSync(join(tmpdir(), "redline-web-"))
  if (withIndex) {
    mkdirSync(join(dir, "assets"), { recursive: true })
    writeFileSync(join(dir, "index.html"), "<!doctype html><html><body>spa</body></html>")
    writeFileSync(join(dir, "assets", "app.test123.js"), "console.log(1)")
    writeFileSync(join(dir, "favicon.svg"), "<svg xmlns='http://www.w3.org/2000/svg'></svg>")
    writeFileSync(join(dir, "favicon.ico"), "ico-bytes")
    writeFileSync(join(dir, "apple-touch-icon.png"), "png-bytes")
  }
  return dir
}

const build = (): ReturnType<typeof Fastify> => {
  const app = Fastify({ logger: false })
  registerWebappRoutes(app)
  return app
}

describe("webapp routes", () => {
  const dir = makeWebDir(true)
  const previous = process.env.REDLINE_WEB_DIR

  beforeAll(() => {
    process.env.REDLINE_WEB_DIR = dir
  })

  afterAll(() => {
    if (previous === undefined) delete process.env.REDLINE_WEB_DIR
    else process.env.REDLINE_WEB_DIR = previous
    rmSync(dir, { recursive: true, force: true })
  })

  it("serves hashed assets with immutable caching", async () => {
    const app = build()
    const response = await app.inject({ method: "GET", url: "/assets/app.test123.js" })
    expect(response.statusCode).toBe(200)
    expect(response.headers["cache-control"]).toContain("immutable")
    expect(response.headers["content-type"]).toContain("text/javascript")
    expect(response.body).toBe("console.log(1)")
    await app.close()
  })

  it("404s as problem+json for missing assets", async () => {
    const app = build()
    const response = await app.inject({ method: "GET", url: "/assets/nope.js" })
    expect(response.statusCode).toBe(404)
    expect(response.headers["content-type"]).toContain("application/problem+json")
    await app.close()
  })

  it("serves the SPA shell for HTML navigations", async () => {
    const app = build()
    const response = await app.inject({ method: "GET", url: "/a/some-artifact", headers: { accept: "text/html" } })
    expect(response.statusCode).toBe(200)
    expect(response.headers["content-type"]).toContain("text/html")
    expect(response.headers["cache-control"]).toBe("no-store")
    expect(response.body).toContain("spa")
    await app.close()
  })

  it("serves the SPA shell for the root path", async () => {
    const app = build()
    const response = await app.inject({ method: "GET", url: "/", headers: { accept: "text/html" } })
    expect(response.statusCode).toBe(200)
    expect(response.body).toContain("spa")
    await app.close()
  })

  it("keeps problem+json 404s for API paths even with an HTML accept header", async () => {
    const app = build()
    const response = await app.inject({ method: "GET", url: "/api/v1/nope", headers: { accept: "text/html" } })
    expect(response.statusCode).toBe(404)
    expect(response.headers["content-type"]).toContain("application/problem+json")
    expect(response.body).toContain("route not found")
    await app.close()
  })

  it("keeps problem+json 404s for non-GET navigations", async () => {
    const app = build()
    const response = await app.inject({ method: "POST", url: "/nowhere", headers: { accept: "text/html" } })
    expect(response.statusCode).toBe(404)
    expect(response.headers["content-type"]).toContain("application/problem+json")
    await app.close()
  })

  it("keeps problem+json 404s for JSON clients", async () => {
    const app = build()
    const response = await app.inject({ method: "GET", url: "/nowhere" })
    expect(response.statusCode).toBe(404)
    expect(response.headers["content-type"]).toContain("application/problem+json")
    await app.close()
  })

  it("serves root static files like favicons for non-HTML clients", async () => {
    const app = build()
    const svg = await app.inject({ method: "GET", url: "/favicon.svg" })
    expect(svg.statusCode).toBe(200)
    expect(svg.headers["content-type"]).toContain("image/svg+xml")
    expect(svg.headers["cache-control"]).toContain("public")
    expect(svg.body).toContain("<svg")
    const ico = await app.inject({ method: "GET", url: "/favicon.ico" })
    expect(ico.statusCode).toBe(200)
    expect(ico.headers["content-type"]).toContain("image/x-icon")
    expect(ico.body).toBe("ico-bytes")
    const png = await app.inject({ method: "GET", url: "/apple-touch-icon.png?v=2" })
    expect(png.statusCode).toBe(200)
    expect(png.headers["content-type"]).toContain("image/png")
    await app.close()
  })

  it("keeps the SPA shell for HTML navigations that name a root file", async () => {
    const app = build()
    const response = await app.inject({ method: "GET", url: "/favicon.svg", headers: { accept: "text/html" } })
    expect(response.statusCode).toBe(200)
    expect(response.headers["content-type"]).toContain("image/svg+xml")
    await app.close()
  })

  it("404s as problem+json for missing root files", async () => {
    const app = build()
    const response = await app.inject({ method: "GET", url: "/nope.png" })
    expect(response.statusCode).toBe(404)
    expect(response.headers["content-type"]).toContain("application/problem+json")
    await app.close()
  })

  it("refuses traversal, hidden, nested, and html root file requests", async () => {
    const app = build()
    for (const url of ["/..%2Ffavicon.svg", "/favicon.svg%2F..", "/.env", "/sub/favicon.svg", "/index.html"]) {
      const response = await app.inject({ method: "GET", url })
      expect(response.statusCode).toBe(404)
      expect(response.headers["content-type"]).toContain("application/problem+json")
    }
    await app.close()
  })

  it("degrades to a hint page when no build exists", async () => {
    const empty = makeWebDir(false)
    process.env.REDLINE_WEB_DIR = empty
    const app = build()
    const page = await app.inject({ method: "GET", url: "/", headers: { accept: "text/html" } })
    expect(page.statusCode).toBe(200)
    expect(page.headers["content-type"]).toContain("text/html")
    expect(page.body).toContain("build:web")
    const asset = await app.inject({ method: "GET", url: "/assets/app.test123.js" })
    expect(asset.statusCode).toBe(404)
    expect(asset.headers["content-type"]).toContain("application/problem+json")
    await app.close()
    rmSync(empty, { recursive: true, force: true })
  })
})
