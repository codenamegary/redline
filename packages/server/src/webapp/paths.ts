import { existsSync } from "node:fs"
import { dirname, join } from "node:path"

// Resolves the directory holding the built web app, or undefined when no
// build exists. REDLINE_WEB_DIR is authoritative when set: an override that
// holds no build yields undefined so the fallback serves the hint page.
// Undefined is a valid state: the API keeps working and the fallback serves
// a hint page instead of killing the daemon.
export const webDir = (): string | undefined => {
  const env = process.env.REDLINE_WEB_DIR
  if (env !== undefined && env !== "") {
    return existsSync(join(env, "index.html")) ? env : undefined
  }
  const moduleDir = import.meta.dirname
  const candidates = [
    join(dirname(process.execPath), "web"),
    ...(moduleDir === undefined ? [] : [join(moduleDir, "..", "..", "..", "..", "dist", "web")]),
    join(process.cwd(), "dist", "web"),
  ]
  return candidates.find((dir) => existsSync(join(dir, "index.html")))
}
