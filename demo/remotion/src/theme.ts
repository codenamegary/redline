// Color and font tokens lifted from the artifact itself
// (~/.redline/artifacts/.../v1-index.html) so the video matches what it demos.
export const theme = {
  ash: '#1c1410',
  soot: '#2a1d16',
  brick: '#8b3a2a',
  copper: '#c4783a',
  amber: '#e8a04a',
  ticket: '#f3e6d4',
  muted: '#a8947e',
  line: 'rgba(243, 230, 212, 0.14)',
  display:
    '"Iowan Old Style", Palatino, "Palatino Linotype", "Book Antiqua", Georgia, serif',
  body: '"Avenir Next", "Segoe UI", "Helvetica Neue", system-ui, sans-serif',
  mono: 'ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace',
} as const

export const emberBackground = `radial-gradient(1200px 500px at 10% -10%, rgba(196, 120, 58, 0.22), transparent 55%),
  radial-gradient(900px 400px at 100% 0%, rgba(139, 58, 42, 0.26), transparent 50%),
  ${theme.ash}`
