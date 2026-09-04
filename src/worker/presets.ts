export type AcpPreset = {
  label: string
  argv: string[]
}

// Non-opencode argv is best-effort and may drift; any command stays
// editable via the custom preset.
export const ACP_PRESETS: Record<string, AcpPreset> = {
  opencode: { label: "OpenCode ACP", argv: ["opencode", "acp"] },
  "claude-code": { label: "Claude Code ACP", argv: ["claude-code-acp"] },
  gemini: { label: "Gemini CLI ACP", argv: ["gemini", "--experimental-acp"] },
  codex: { label: "Codex ACP", argv: ["codex", "acp"] },
}
