import { homedir } from "node:os"
import { join } from "node:path"

export type AcpPreset = {
  label: string
  argv: string[]
}

// The cursor agent lives outside PATH for some installs, so its preset
// pins the absolute path. Non-opencode argv is best-effort and may drift;
// any command stays editable via the custom preset.
export const ACP_PRESETS: Record<string, AcpPreset> = {
  opencode: { label: "OpenCode ACP", argv: ["opencode", "acp"] },
  cursor: { label: "Cursor Agent ACP", argv: [join(homedir(), ".local", "bin", "agent"), "acp"] },
  "claude-code": { label: "Claude Code ACP", argv: ["claude-code-acp"] },
  gemini: { label: "Gemini CLI ACP", argv: ["gemini", "--experimental-acp"] },
  codex: { label: "Codex ACP", argv: ["codex", "acp"] },
}
