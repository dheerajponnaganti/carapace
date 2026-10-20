export type CleanViewTaskStatus = 'done' | 'active' | 'upcoming'

/** The setup answers while the setup pane is open; saved into each mod's own settings on Save. */
export type SetupDraft = {
  rate: number
  work: ('coding' | 'writing' | 'emails' | 'research' | 'media')[]
  pay: 'sub' | 'api' | 'budget'
  budget: { amount: number; period: 'day' | 'week' | 'month' }
  helpers: 'cost' | 'balanced' | 'quality'
  /** Steps shows every tool call (Clean View off); checklist shows the plain checklist (Clean View on). */
  view: 'steps' | 'checklist'
  memory: boolean
}

export type CleanViewTask = {
  id: string
  name: string
  status: CleanViewTaskStatus
  percent: number
  hasReported: boolean
  /** When the step first appeared, for the wipe that draws it in. */
  addedAt?: number
}

export type CleanViewPhase = 'working' | 'needsYou' | 'stuck' | 'stopped' | 'done'

export type CleanViewChecklist = {
  title: string
  phase: CleanViewPhase
  tasks: CleanViewTask[]
  needsYouReason: string | null
  stuckReason: string | null
  startedAt: number
  /** When a follow-up turn revived a finished job; timers measure from here. */
  resumedAt?: number
  finishedAt: number | null
  isCollapsed: boolean
  /** The person's prompt that started the job, where the transcript replay begins. */
  prompt?: string
}

export type PromptUpgradeStep =
  | 'compose'
  | 'reading'
  | 'asking'
  | 'questions'
  | 'rewriting'
  | 'review'
  | 'error'
  | 'history'

export type PromptUpgradeQuestion = { question: string; options: string[] }

export type PromptUpgradeAnswer = { state: 'open' | 'answered' | 'skipped'; value: string }

export type PromptUpgradeFlow = {
  id: string
  step: PromptUpgradeStep
  original: string
  questions: PromptUpgradeQuestion[]
  answers: PromptUpgradeAnswer[]
  otherFor: number | null
  rewrite: string
  added: string[]
  error: string | null
  failedStep: 'asking' | 'rewriting' | null
  isEditing: boolean
  isFilling: boolean
  isCopied: boolean
}

export type PromptUpgradeEntry = { id: string; at: number; original: string; rewrite: string; added: string[] }

export type AgentDockCardStatus = 'queued' | 'working' | 'done' | 'stuck'

export type AgentDockCard = {
  id: string
  task: string
  status: AgentDockCardStatus
  percent: number
  hasReported: boolean
  startedAt: number | null
  endedAt: number | null
  agentId: string | null
  seat: number
  /** The model family the helper runs on (haiku, sonnet, opus, fable); absent on cards saved before Auto. */
  model?: string | null
  /** The kind of piece (lookup, extract, check, write, code, research, design, debug); absent before categories. */
  category?: string
}

/** One thing a helper did, as the Crew's Watch shows it. */
export type AgentDockAction = { line: string; at: number }

/** One file a helper touched. */
export type AgentDockTouch = { path: string; kind: 'read' | 'write'; at: number }

/** A helper's done gate: retrying while checks fail, then passed, or failed after the retries. */
export type AgentDockGate = { status: 'retrying' | 'passed' | 'failed'; tries: number }

export type AgentDockMission = {
  id: string
  job: string
  size: number
  startedAt: number
  finishedAt: number | null
  cards: AgentDockCard[]
  launched: number
  nudged: boolean
  isStopped: boolean
}

export type AgentDockHelperModel = 'auto' | 'fast' | 'same'

export type WorkReportKind = 'code' | 'emails' | 'media' | 'documents' | 'research' | 'other'
export type WorkReportTab = 'today' | 'week' | 'month' | 'year'
export type WorkReportDay = { kinds: Partial<Record<WorkReportKind, number>>; models: Record<string, number> }
export type WorkReportSettings = { rate: number; minutes: Record<WorkReportKind, number> }

/** What a problem report sends with the person's words: versions, setup and the recent log lines. */
export type ReportDetails = { carapace: string; claude: string; os: string; terminal: string; mods: string; lines: string[] }

/** One edit time machine snapshot: a commit in the hidden store. `check` is the result of a test or build run while this was the latest snapshot. */
export type TimeSnap = {
  sha: string
  at: number
  tool: string
  label: string
  prompt: number
  promptText: string
  check?: 'pass' | 'fail'
  /** The command whose result `check` is. */
  checkCommand?: string
  /** The same command gave both results on this snapshot's files: a flaky check. */
  flaky?: boolean
}

export type CleanViewSurfacing = { until: number; line: string }

/** Logbook's state for the bar and its pane: the vault this folder uses (null before setup) and where a new one can live. */
export type LogbookStatus = {
  vault: string | null
  isOn: boolean
  notes: number
  open: number
  lastLine: string
  places: { id: string; label: string; dir: string }[]
  cwd: string
  note: string
  isAsking: boolean
}

// Every mod's state lives under the one plugin key, carapace. Prefix new keys with the mod's name.
declare module 'claude-code' {
  interface PluginState {
    carapace: {
      cleanViewEnabled: boolean
      checklist: CleanViewChecklist | null
      tick: number
      promptUpgradeAuto: boolean
      promptUpgradeFlow: PromptUpgradeFlow | null
      promptUpgradeHistory: PromptUpgradeEntry[]
      agentDockSize: number
      agentDockPending: number | null
      agentDockCustom: boolean
      agentDockHelperModel: AgentDockHelperModel
      agentDockFolded: boolean
      agentDockIsOpen: boolean
      agentDockLimit: number
      agentDockMission: AgentDockMission | null
      agentDockFrame: number
      /** The helper card the person is watching in the Crew pane, by card id. */
      agentDockWatching: string | null
      /** Whether the Note box under the watched helper is open. */
      agentDockNoteOpen: boolean
      /** The watched helper's conversation, shown in the Crew pane by Open: its lines, or why it could not be read. */
      agentDockTranscript: { agentId: string; lines: string[]; reason: string | null } | null
      /** Each helper's last few actions, by agent id, as one line each. */
      agentDockActivity: Record<string, AgentDockAction[]>
      workReportTab: WorkReportTab
      workReportDays: Record<string, WorkReportDay>
      workReportSettings: WorkReportSettings
      cleanViewContext: number
      cleanViewSurfacing: CleanViewSurfacing | null
      cleanViewOxygen: number | null
      /** When the window refills (ISO time), if the plan reports it. */
      cleanViewOxygenResets: string | null
      /** The gauge's last change: it eases from `from` to the new value starting at `at`. */
      cleanViewContextEase: { from: number; at: number } | null
      cleanViewPing: number | null
      cleanViewBubbles: boolean
      cleanViewNotify: boolean
      cleanViewTurnRunning: boolean
      cleanViewWatched: boolean
      crewRules: Partial<Record<'lookup' | 'extract' | 'check' | 'write' | 'code' | 'research' | 'design' | 'debug', 'haiku' | 'sonnet' | 'opus' | 'fable'>>
      crewTips: string[]
      /** The last prompt a person sent (typed, or Run it in Refine). A turn carrying it is a new request; any other turn (a helper's result, a nudge) is not. */
      personPrompt: { text: string; at: number } | null
      /** New commits on GitHub that this clone does not have yet; null when up to date or not checked. */
      deckUpdate: { behind: number; subject: string; checkedAt: number } | null
      deckPonytail: { kind: 'none' | 'ours' | 'yours'; version: string; latest: string }
      deckGstack: { kind: 'none' | 'ours' | 'yours'; version: string; latest: string }
      deckRea: { kind: 'none' | 'ours' | 'yours'; version: string; latest: string }
      /** Ids of the tools pinned to the bar, in bar order (kept in the store too). */
      deckPins: string[]
      /** Whether other mods' bands above the prompt show under the bar (folded behind More by default). */
      deckOthersShown: boolean
      deckOthersOn: boolean
      /** The setup answers being edited in the setup pane. */
      deckSetupDraft: SetupDraft | null
      /** Whether setup was saved or put off: until then the bar shows Set up. */
      deckSetupDone: boolean
      /** Whether drawings use plain one-cell symbols (/mods glyphs, or the old Windows console). */
      glyphsSafe: boolean
      footerModel: { model: string; effort: string | number | null; asked: string | null } | null
      footerGit: { branch: string; ahead: number; behind: number; changed: number; isDetached: boolean; flashUntil: number } | null
      promptUpgradeBlanks: Record<string, string>
      /** Errors logged since the last report or dismissal; above 0 the bar offers the report button. */
      reportErrors: number
      /** What the person has typed in the report panel. */
      reportText: string
      /** The line under the report panel's buttons. */
      reportNote: string
      /** Whether the report panel shows the log lines. */
      reportShowLog: boolean
      reportDetails: ReportDetails | null
      secretGuardBlocked: number
      secretGuardMasked: number
      /** A retry loop found in the running turn (shown as the bar's stuck row); null when none. */
      loopStuck: { kind: 'command' | 'error' | 'edit'; tries: number; line: string; isDismissed: boolean } | null
      /** Files each helper touched, by agent id, newest first. */
      agentDockFiles: Record<string, AgentDockTouch[]>
      /** Each helper's done gate result, by agent id. */
      agentDockGate: Record<string, AgentDockGate>
      /** The session's badge: glyph and palette token. */
      sessionBadge: { glyph: string; color: 'accent' | 'good' | 'warn' | 'highlight' | 'accentDeep' } | null
      /** Helpers running in another worktree: agent id to that worktree's badge. */
      agentDockBadges: Record<string, { glyph: string; color: 'accent' | 'good' | 'warn' | 'highlight' | 'accentDeep' }>
      logbookStatus: LogbookStatus
      timeMachineSnaps: TimeSnap[]
      /** The hidden store's size in KB, or null when there is none yet. */
      timeMachineSize: number | null
      /** The snapshot whose Restore awaits a confirm in the pane. */
      timeMachineConfirm: string | null
      timeMachineNote: string
      /** The footer's cache countdown from the status line file; null shows nothing. */
      footerCache: { text: string; isAmber: boolean; isCold: boolean } | null
      /** Recent readings of the five-hour window, for the footer's forecast. */
      footerReadings: { readings: { at: number; pct: number }[]; resetsAt: number | null }
      deckHookify: { kind: 'none' | 'ours' | 'yours'; version: string; latest: string }
      deckSecurityGuidance: { kind: 'none' | 'ours' | 'yours'; version: string; latest: string }
      /** The most repeated prompts in the person's history, biggest first (at most three). */
      deckRepeats: { text: string; count: number }[]
      /** The repeated prompt whose Make /command was pressed once and waits for the second press; null when none. */
      deckRepeatsPending: number | null
      /** When ↑ Update was pressed once and waits for the second press; null when not armed. */
      deckUpdateArmed: number | null
      /** Setup pane extras: the account kind carapace detected, the amount boxes holding a bad entry, and the answers as the pane opened. */
      deckSetupMeta: { detected: 'sub' | 'api' | null; bad: ('rate' | 'budget')[]; start?: SetupDraft | null }
      /** The account type the footer worked out from the rate-limit windows; a company spend_limit carries its percent and reset. */
      budgetAccount: { kind: 'unknown' | 'subscriber' | 'api'; gateway: { percentUsed: number; resetsAt: number | null } | null }
      /** The budget the person set with /clean budget; null when none. */
      budgetConfig: { unit: 'usd' | 'tokens'; amount: number; period: 'day' | 'week' | 'month' | 'session' } | null
      /** Spend by local day and per session, for budgets (kept in the store too). */
      budgetLedger: { days: Record<string, { usd: number; tokens: number }>; sess: Record<string, { usd: number; tokens: number; baseUsd: number; baseTokens: number; at: number }> }
      /** The id of the session the ledger counts now. */
      budgetSessionId: string
      /** Recent readings of the budget's percent used, for the footer's forecast. */
      budgetReadings: { readings: { at: number; pct: number }[]; resetsAt: number | null }
      /** Tokens the test output trimmer saved this session, and how many runs it trimmed. */
      trimmerSaved: { tokens: number; runs: number }
    }
  }
}
