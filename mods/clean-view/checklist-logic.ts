// The checklist's pure steps: plans, progress, to-do lists and task updates. No engine calls, so tests import it directly.
import type { CleanViewChecklist, CleanViewTask } from '../../types'
import { cells, cutCells } from '../shared/look'

const PLACEHOLDER = 'placeholder-'
const MAX_NAME = 40

const CODE_FILE =
  /\b[\w.-]+\.(?:[cm]?[jt]sx?|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|php|json|ya?ml|toml|md|css|scss|less|html?|sh|zsh|bash|ps1|sql|vue|svelte|lock|env|ini|xml|gradle|dart|lua)\b/gi

/** The one cleaner every name passes through. */
export function cleanName(raw: unknown): string {
  let name = String(raw ?? '')
    .replace(/`[^`]*`?/g, ' ')
    .split(/\s+/)
    .filter(word => !/[\\/]/.test(word))
    .join(' ')
    .replace(CODE_FILE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (name === '') return 'Working on it'
  name = name.charAt(0).toUpperCase() + name.slice(1)
  if (cells(name) <= MAX_NAME) return name
  const cut = cutCells(name, MAX_NAME - 1)
  const space = cut.lastIndexOf(' ')

  return (space > 0 ? cut.slice(0, space) : cut).replace(/[\s,.;:-]+$/, '') + '…'
}

export function hasPlan(list: CleanViewChecklist | null): boolean {
  return list !== null && list.tasks.some(task => !task.id.startsWith(PLACEHOLDER))
}

export function startNext(tasks: CleanViewTask[]): CleanViewTask[] {
  if (tasks.some(task => task.status === 'active')) return tasks
  const next = tasks.findIndex(task => task.status === 'upcoming')

  return next < 0 ? tasks : tasks.map((task, i) => (i === next ? { ...task, status: 'active' } : task))
}

export function newJob(title: string, now: number): CleanViewChecklist {
  return {
    title,
    phase: 'working',
    tasks: [
      { id: `${PLACEHOLDER}0`, name: 'Understand your request', status: 'active', percent: 0, hasReported: false, addedAt: now },
      { id: `${PLACEHOLDER}1`, name: 'Plan the steps', status: 'upcoming', percent: 0, hasReported: false, addedAt: now },
    ],
    needsYouReason: null,
    stuckReason: null,
    startedAt: now,
    finishedAt: null,
    isCollapsed: false,
  }
}

export function realTasks(list: CleanViewChecklist): CleanViewTask[] {
  return list.tasks.filter(task => !task.id.startsWith(PLACEHOLDER))
}

export function applyPlan(list: CleanViewChecklist, steps: readonly string[], now: number): CleanViewChecklist {
  const old = realTasks(list)
  const tasks = steps.map((step, i): CleanViewTask => {
    const name = cleanName(step)
    const before = old.find(task => task.name === name)

    return {
      id: `step-${i}`,
      name,
      status: before?.status === 'done' ? 'done' : 'upcoming',
      percent: before?.percent ?? 0,
      hasReported: before?.hasReported ?? false,
      addedAt: before?.addedAt ?? now,
    }
  })

  return { ...list, tasks: startNext(tasks) }
}

export function applyProgress(list: CleanViewChecklist, rawName: string, rawPercent: number, now: number): CleanViewChecklist {
  const name = cleanName(rawName)
  const percent = Math.min(100, Math.max(0, Math.round(Number.isFinite(rawPercent) ? rawPercent : 0)))
  let tasks = realTasks(list)
  const same = (task: CleanViewTask) => task.name.toLowerCase() === name.toLowerCase()
  let at = tasks.findIndex(task => same(task) && task.status !== 'done')
  if (at < 0) at = tasks.findIndex(same)
  // A reworded report lands on the active step, which keeps its planned name.
  if (at < 0) at = tasks.findIndex(task => task.status !== 'done')
  if (at < 0) {
    const firstOpen = tasks.findIndex(task => task.status !== 'done')
    at = firstOpen < 0 ? tasks.length : firstOpen
    const added: CleanViewTask = { id: `extra-${list.tasks.length}-${at}`, name, status: 'upcoming', percent: 0, hasReported: false, addedAt: now }
    tasks = [...tasks.slice(0, at), added, ...tasks.slice(at)]
  }
  tasks = tasks.map((task, i): CleanViewTask => {
    if (i < at) return { ...task, status: 'done', percent: 100 }
    if (i === at) return { ...task, status: percent >= 100 ? 'done' : 'active', percent, hasReported: true }

    return task.status === 'active' ? { ...task, status: 'upcoming' } : task
  })

  return { ...list, tasks: startNext(tasks) }
}

export type Todo = { content: string; status: 'pending' | 'in_progress' | 'completed' }

export function fromTodos(list: CleanViewChecklist, todos: readonly Todo[], now: number): CleanViewChecklist {
  const old = realTasks(list)
  const tasks = todos.map((todo, i): CleanViewTask => {
    const name = cleanName(todo.content)
    const before = old.find(task => task.name === name)
    const status = todo.status === 'completed' ? 'done' : todo.status === 'in_progress' ? 'active' : 'upcoming'

    return {
      id: `todo-${i}`,
      name,
      status,
      percent: status === 'done' ? 100 : before?.percent ?? 0,
      hasReported: before?.hasReported ?? false,
      addedAt: before?.addedAt ?? now,
    }
  })

  return { ...list, tasks: startNext(tasks) }
}

export function withTaskUpdate(
  list: CleanViewChecklist,
  update: { taskId: string; subject?: string; status?: string },
): CleanViewChecklist {
  const id = `task-${update.taskId}`
  let tasks = realTasks(list)
  if (update.status === 'deleted') return { ...list, tasks: startNext(tasks.filter(task => task.id !== id)) }
  tasks = tasks.map((task): CleanViewTask => {
    if (task.id !== id) return task
    const name = update.subject ? cleanName(update.subject) : task.name
    if (update.status === 'completed') return { ...task, name, status: 'done', percent: 100 }
    if (update.status === 'in_progress') return { ...task, name, status: 'active' }
    if (update.status === 'pending') return { ...task, name, status: 'upcoming' }

    return { ...task, name }
  })

  return { ...list, tasks: startNext(tasks) }
}

/** One row of the conversation record, as `$.session.messages()` gives it (only the fields the replay reads). */
export type TranscriptRow = {
  role: 'user' | 'assistant'
  text: string
  toolUses: readonly { tool_use_id: string; tool: string; input: Record<string, unknown>; result?: unknown; text?: string; isError?: true }[]
}

/** The steps a plan_steps call names: 1 to 8 non-blank strings. */
export function planSteps(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((step): step is string => typeof step === 'string' && step.trim() !== '').slice(0, 8) : []
}

/**
 * The job's steps rebuilt from the main conversation's record, from the prompt that started the job: the plans, progress
 * and to-do lists Claude sent, answered calls only. A forked helper's calls live in its own record, so they never land
 * here. Null when the job has no recorded prompt or the record no longer reaches it; then the live steps stand.
 */
export function replayTasks(list: CleanViewChecklist, messages: readonly TranscriptRow[], now: number): CleanViewTask[] | null {
  const prompt = list.prompt?.trim()
  if (!prompt) return null
  let from = -1
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const row = messages[i]
    if (row?.role === 'user' && (row.text.trim() === prompt || row.text.includes(prompt))) {
      from = i
      break
    }
  }
  if (from < 0) return null
  let job: CleanViewChecklist = { ...list, tasks: newJob(list.title, list.startedAt).tasks }
  for (const row of messages.slice(from + 1)) {
    if (row.role !== 'assistant') continue
    for (const use of row.toolUses) {
      if (use.text === undefined || use.isError) continue
      const input = use.input
      if (use.tool === 'mcp__carapace__plan_steps') {
        const steps = planSteps(input.steps)
        if (steps.length > 0) job = applyPlan(job, steps, now)
      } else if (use.tool === 'mcp__carapace__report_progress') {
        job = applyProgress(job, String(input.task ?? ''), Number(input.percent) || 0, now)
      } else if (use.tool === 'TodoWrite' && Array.isArray(input.todos)) {
        job = fromTodos(job, input.todos as Todo[], now)
      } else if (use.tool === 'TaskCreate') {
        const id = (use.result as { task?: { id?: unknown } } | undefined)?.task?.id
        if (typeof id === 'string') {
          const task: CleanViewTask = { id: `task-${id}`, name: cleanName(input.subject), status: 'upcoming', percent: 0, hasReported: false, addedAt: now }
          job = { ...job, tasks: startNext([...realTasks(job), task]) }
        }
      } else if (use.tool === 'TaskUpdate') {
        if (typeof input.taskId === 'string') {
          job = withTaskUpdate(job, {
            taskId: input.taskId,
            subject: typeof input.subject === 'string' ? input.subject : undefined,
            status: typeof input.status === 'string' ? input.status : undefined,
          })
        }
      }
    }
  }
  // Rows the bar already shows keep their draw-in time, so a correction never replays the wipe.
  const shown = new Map(list.tasks.map(task => [`${task.id}\u0000${task.name}`, task.addedAt]))

  return job.tasks.map(task => {
    const addedAt = shown.get(`${task.id}\u0000${task.name}`)

    return addedAt === undefined ? task : { ...task, addedAt }
  })
}

/** Whether two step lists say the same thing (draw-in times aside). */
export function sameTasks(a: readonly CleanViewTask[], b: readonly CleanViewTask[]): boolean {
  const key = (tasks: readonly CleanViewTask[]) => JSON.stringify(tasks.map(t => [t.id, t.name, t.status, t.percent, t.hasReported]))

  return key(a) === key(b)
}
