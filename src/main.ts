import { writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { parseArgs } from "node:util"

import { openStore } from "./store/artifact.store"
import { buildServer } from "./server"

const usage = "usage: redline serve [--port <n>] [--host <addr>] [--home <dir>]"

const parsePort = (raw: string): number => {
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("invalid port: " + raw)
  return port
}

const main = async (): Promise<void> => {
  const parsed = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: "string", short: "p" },
      host: { type: "string", short: "H" },
      home: { type: "string" },
    },
  })

  const command = parsed.positionals[0] ?? "serve"
  if (command !== "serve") throw new Error(usage)

  const port = parsePort(parsed.values.port ?? process.env.REDLINE_PORT ?? "4739")
  const host = parsed.values.host ?? process.env.REDLINE_HOST ?? "127.0.0.1"
  const home = parsed.values.home ?? process.env.REDLINE_HOME ?? join(homedir(), ".redline")

  const store = openStore(home)
  const app = buildServer({ store })
  await app.listen({ port: port, host: host })

  const address = app.server.address()
  const boundPort = typeof address === "object" && address !== null ? address.port : port
  const boundHost = typeof address === "object" && address !== null ? address.address : host

  await writeFile(
    join(home, "server.json"),
    JSON.stringify(
      { pid: process.pid, port: boundPort, host: boundHost, startedAt: new Date().toISOString() },
      null,
      2,
    ) + "\n",
  )

  console.log("redline ready: http://" + boundHost + ":" + String(boundPort) + " (home: " + home + ")")

  const shutdown = (): void => {
    void app.close().finally(() => process.exit(0))
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}

try {
  await main()
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
}
