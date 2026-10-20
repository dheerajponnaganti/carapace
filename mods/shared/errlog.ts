// The error log and the problem report, as pure logic. No `$` here: each mod makes the engine calls.

export const LOG_KEEP = 300
export const SHOWN_LINES = 50
export const URL_MAX = 8000
export const COUNT_KEY = 'carapaceErrorCount'
export const HINT_KEY = 'carapaceReportHinted'
const REPO = 'https://github.com/dheerajponnaganti/carapace'

let chain: Promise<unknown> = Promise.resolve()

/** Runs log writes one after another, so two errors at once never lose a line. Never rejects. */
export function queueLog(task: () => Promise<void>): Promise<void> {
  const run = chain.then(task).catch(() => undefined)
  chain = run

  return run
}

function slash(home: string): string {
  return home.replace(/[\\/]+$/, '')
}

export function logPath(home: string): string {
  return `${slash(home)}/.claude/carapace/log.txt`
}

export function reportPath(home: string, ms: number): string {
  return `${slash(home)}/.claude/carapace/report-${new Date(ms).toISOString().replace(/[:.]/g, '-')}.md`
}

/** One line for the log: time, mod, what failed, the error's first line (200 characters at most), the Claude Code version. */
export function errorLine(ms: number, mod: string, what: string, err: unknown, version: string): string {
  const raw = err instanceof Error ? err.message : String(err)
  const message = (raw.split('\n')[0] ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)

  return `${new Date(ms).toISOString()} ${mod} ${what}: ${message}${version ? ` [claude ${version}]` : ''}`
}

export function tail(text: string, n: number): string[] {
  return text.split('\n').filter(l => l !== '').slice(-n)
}

/** The log with one more line, trimmed to the last LOG_KEEP lines. */
export function appendLine(old: string, line: string): string {
  return `${tail(old, LOG_KEEP - 1).concat(line).join('\n')}\n`
}

export function count(n: number): string {
  return n === 1 ? '1 error' : `${n} errors`
}

export function hintText(mod: string): string {
  return `carapace hit a problem in ${mod}. Press ⚑ to send a report.`
}

/** A rough OS name from the home folder's shape: /Users is macOS, any other / is Linux, else Windows. */
export function osName(home: string): string {
  return home.startsWith('/Users/') ? 'macOS' : home.startsWith('/') ? 'Linux' : 'Windows'
}

/** The command that opens a link in the browser. */
export function openArgv(os: string, url: string): string[] {
  return os === 'macOS' ? ['open', url] : os === 'Linux' ? ['xdg-open', url] : ['rundll32', 'url.dll,FileProtocolHandler', url]
}

export type ReportInfo = { description: string; carapace: string; claude: string; os: string; terminal: string; mods: string; lines: string[] }

/** The report as markdown: what the person wrote, then what is sent with it. Never a prompt, reply or file. */
export function reportMarkdown(i: ReportInfo): string {
  const log = i.lines.length ? `\n\n<details><summary>${count(i.lines.length)} logged</summary>\n\n\`\`\`\n${i.lines.join('\n')}\n\`\`\`\n</details>` : ''

  return `${i.description.trim() || '(no description)'}\n\n### Details\n- carapace: ${i.carapace}\n- Claude Code: ${i.claude}\n- OS: ${i.os}\n- Terminal: ${i.terminal}\n- Mods on: ${i.mods}${log}\n`
}

/** The new-issue link. Log lines are dropped from the oldest end until the whole link fits URL_MAX. */
export function issueUrl(i: ReportInfo): string {
  const title = (i.description.trim().split('\n')[0] || 'Problem report').slice(0, 80)
  const base = { ...i, description: i.description.slice(0, 1500) }
  for (let n = Math.min(i.lines.length, SHOWN_LINES); ; n--) {
    const body = reportMarkdown({ ...base, lines: n > 0 ? i.lines.slice(-n) : [] })
    const url = `${REPO}/issues/new?labels=${encodeURIComponent('bug report')}&title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`
    if (url.length <= URL_MAX || n <= 0) return url
  }
}
