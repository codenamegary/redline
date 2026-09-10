export const queryKeys = {
  health: ["health"] as const,
  artifacts: { all: ["artifacts"] as const },
  artifact: (id: string) => ["artifacts", id] as const,
  feedback: (id: string) => ["artifacts", id, "feedback"] as const,
  worker: (id: string) => ["artifacts", id, "worker"] as const,
  iterationLog: (id: string) => ["artifacts", id, "iteration-log"] as const,
  settings: { all: ["settings"] as const },
  defaults: ["settings", "defaults"] as const,
}
