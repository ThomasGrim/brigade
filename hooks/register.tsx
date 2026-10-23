import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit, Timer, TurnStepChunk } from 'claude-code'

import type {
  AdvisorCall,
  AdvisorRecord,
  AdvisorState,
  AgentCard,
  AgentRecord,
  Checkpoint,
  Decision,
  DecisionRecord,
  History,
  EffortLevel,
  ForkCall,
  ForkState,
  Lead,
  LogLine,
  Mode,
  Phase,
  Quota,
  Route,
  Router,
  Spend,
  Tier,
  TurnCost,
  Verdict,
  View,
} from '../types'
import { JEV_PROMPT } from './jev'

const PANE = 'brigade'
const TITLE = 'Brigade'
const MAX_LOG = 50
// what the history keeps across sessions, newest last
const KEEP = { decisions: 500, advisor: 300, agents: 300 } as const
const DAY_MS = 24 * 60 * 60_000
const MAX_AGENTS = 30
const WIDE = 84
// what the pane asks for when it opens: the diagram needs ~100 columns and ~50 rows
const PANE_COLUMNS = 110
const PANE_ROWS = 52
// below this many body rows the diagram drops its spacers and captions so it is not clipped
const TALL = 49
// how often the pane redraws while something runs: elapsed times and the lead's phase move
const TICK_MS = 500
// the API pauses the lead's stream while it runs the advisor, right after the server tool's
// own (opaque) stream items: a silence this long after one of them is read as a consult
const PAUSE_MS = 2500
// a checkpoint that just fired stays highlighted this long
const FLASH_MS = 10_000
// jev's confidence below this counts as unsure: the router does not trust the answer alone
const SHARP = 0.6
// passive jev consults per session, so a failing loop cannot drain the quota
const MAX_AUTO = 20
const QUOTA_LABEL: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: '$' }

// subagent lines shown at once in the pane
const MAX_SUB_LINES = 4
// these agents are deciders: they feed the fork layer, not the subagent cards
const FORK_TYPES = new Set(['jev'])
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const EFFORTS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']
const SPIN = ['◐', '◓', '◑', '◒']

// ── the request router: jev picks effort, model and way of working for each request ──
/** The values of the manifest's `userConfig` fields, defaults filled in. */
export type Config = {
  /** Model that answers jev's questions: an alias (`haiku`) or a full model id. */
  jevModel: string
  /** `on`: jev picks model, effort and working mode for each request. `off`: the pane only observes. */
  routing: 'on' | 'off'
  /** `auto` opens the pane when a session starts, `command` only on `/brigade`. */
  panel: 'auto' | 'command'
  /** Ask jev "retry or stop?" when a command fails twice in a row (shown in the pane only). */
  retryConsult: boolean
}
export const DEFAULT_CONFIG: Config = { jevModel: 'haiku', routing: 'on', panel: 'auto', retryConsult: false }

export const readConfig = (options: Readonly<Record<string, unknown>>): Config => ({
  jevModel:
    typeof options.jevModel === 'string' && options.jevModel.trim() !== '' ? options.jevModel.trim() : DEFAULT_CONFIG.jevModel,
  routing: options.routing === 'off' ? 'off' : 'on',
  panel: options.panel === 'command' ? 'command' : 'auto',
  retryConsult: options.retryConsult === true,
})

// set once when the module loads: the helpers below read it
let config: Config = DEFAULT_CONFIG
const jevAgent = (): { model: string; system: string } => ({ model: config.jevModel, system: JEV_PROMPT })

const TIER_MODEL: Record<Tier, string> = { sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' }
// the router steers these two only: a model picked with /model, or a fallback, is left alone
const ROUTED = new Set(Object.values(TIER_MODEL))
// quality first: going up takes little certainty, staying low takes more
const OPUS_AT = 0.3
const SONNET_AT = 0.6
const EFFORT_AT = 0.6
// a team costs several contexts: it takes a confident call, a lone subagent a fair one
const TEAM_AT = 0.7
const DELEGATE_AT = 0.5
// how long each of jev's answers may take before the turn goes ahead without it
const DECIDE_MS = 3000
// past this idle gap the main conversation's cache (one hour on a subscription) is cold, so a
// switch costs no more than a fresh start and the tier may come down again
const COLD_MS = 55 * 60_000
const OVERRIDES = new Set(['#max', '#fast', '#opus', '#sonnet'])
// the person's own requests (terminal, remote control, SDK); not notifications, triggers or peers
const ROUTED_ORIGINS = new Set(['composer', 'bridge', 'sdk'])

const EFFORT_QUESTION = {
  question: 'How much reasoning effort does this request need?',
  options: {
    low: 'a quick answer, a lookup or a trivial one-line change',
    medium: 'a small, well-defined change or explanation',
    high: 'ordinary multi-step coding work',
    xhigh: 'hard debugging, design work, or a change across many files',
    max: 'very hard or high-stakes work where a mistake is costly',
  } satisfies Record<EffortLevel, string>,
}
const MODEL_QUESTION = {
  question: 'Which model should handle this request?',
  options: {
    sonnet: 'routine work: questions, explanations, ordinary features and fixes',
    opus: 'deep reasoning: architecture, subtle or long-standing bugs, risky work on production, security, data or billing, long ambiguous tasks',
  } satisfies Record<Tier, string>,
}
const MODE_QUESTION = {
  question: 'How should the work be organised?',
  options: {
    solo: 'the main agent does it directly',
    delegate: 'one part is better done by a subagent: a wide read-only search of the codebase, or an isolated edit',
    team: 'a large task that splits into several independent parts to run in parallel, then a review',
  } satisfies Record<Mode, string>,
}

const ORANGE = '#e8956b'
const PURPLE = '#b69cf0'
const BLUE = '#6cb0f6'
const GREEN = '#6fd08c'
const RED = '#f07178'
const FLASH = '#3b3355'

const CHECKPOINT_LABEL: Record<Checkpoint, string> = {
  plan: 'before a plan',
  error: 'same error x2',
  done: 'before done',
  mid: 'mid-task',
}

const INITIAL_LEAD: Lead = {
  model: '',
  effort: '',
  steps: 0,
  isTurnActive: false,
  phase: 'idle',
  phaseSec: 0,
  outChars: 0,
  edits: 0,
}
const INITIAL_ADVISOR: AdvisorState = {
  calls: 0,
  tokensRead: 0,
  model: '',
  marks: { plan: 0, error: 0, done: 0, mid: 0 },
  recent: [],
}
const INITIAL_FORKS: ForkState = { count: 0, recent: [] }
const INITIAL_SPEND: Spend = { usd: 0, windows: {}, turns: [] }
const INITIAL_ROUTER: Router = { tier: 'sonnet' }
const INITIAL_HISTORY: History = { decisions: [], advisor: [], agents: [] }

const lead = atom({ plugin: 'brigade', key: 'lead' } as const, INITIAL_LEAD)
const agents = atom({ plugin: 'brigade', key: 'agents' } as const, [] as AgentCard[])
const advisor = atom({ plugin: 'brigade', key: 'advisorCalls' } as const, INITIAL_ADVISOR)
const forks = atom({ plugin: 'brigade', key: 'forks' } as const, INITIAL_FORKS)
const quota = atom({ plugin: 'brigade', key: 'quota' } as const, [] as Quota[])
const spend = atom({ plugin: 'brigade', key: 'spend' } as const, INITIAL_SPEND)
const router = atom({ plugin: 'brigade', key: 'router' } as const, INITIAL_ROUTER)
const history = atom({ plugin: 'brigade', key: 'history' } as const, INITIAL_HISTORY)
const view = atom({ plugin: 'brigade', key: 'view' } as const, 'live' as View)
const log = atom({ plugin: 'brigade', key: 'log' } as const, [] as LogLine[])
const now = atom({ plugin: 'brigade', key: 'now' } as const, 0)

/** `claude-sonnet-5-5` -> `sonnet 5.5`, `opus` -> `opus`; anything unfamiliar is shown as given. */
export const shortModel = (model: string): string => {
  const m = /(opus|sonnet|haiku|fable|mythos)-?(\d+)?-?(\d+)?/.exec(model)
  if (!m) return model || '?'
  const version = m[2] === undefined ? '' : m[3] === undefined ? ` ${m[2]}` : ` ${m[2]}.${m[3]}`
  return `${m[1]}${version}`
}

const colorOf = (model: string): string =>
  model.includes('haiku') ? BLUE : model.includes('opus') ? PURPLE : model.includes('sonnet') ? ORANGE : GREEN

const clock = (at: number): string => new Date(at).toTimeString().slice(0, 8)

const elapsed = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}

const tokens = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))

const bar = (steps: number, width: number): string => {
  const full = Math.min(width, Math.round((Math.min(steps, 20) / 20) * width))
  return '█'.repeat(full) + '░'.repeat(width - full)
}

const meter = (ratio: number, width: number): [string, string] => {
  const full = Math.round(Math.min(1, Math.max(0, ratio)) * width)
  return ['█'.repeat(full), '░'.repeat(width - full)]
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

const toQuota = (limits: SessionRateLimit[]): Quota[] =>
  limits.map(limit => ({ kind: limit.kind, percentUsed: limit.percentUsed, resetsAt: limit.resetsAt }))

/**
 * Adds each window's new reading to what this session used of it; a reading below the last
 * one is a window that reset, whose whole reading is new use.
 */
export const trackWindows = (
  windows: Spend['windows'],
  limits: readonly { kind: string; percentUsed: number }[],
): Spend['windows'] => {
  const tracked = { ...windows }
  for (const limit of limits) {
    const known = tracked[limit.kind]
    const used =
      known === undefined ? 0 : limit.percentUsed >= known.last ? limit.percentUsed - known.last : limit.percentUsed
    tracked[limit.kind] = { last: limit.percentUsed, spent: (known?.spent ?? 0) + used }
  }

  return tracked
}

const LEVELS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']

/** One bar per value, scaled to the largest. */
export const sparkline = (values: readonly number[]): string[] => {
  const max = Math.max(0, ...values)
  return values.map(value => LEVELS[max <= 0 ? 0 : Math.min(7, Math.round((value / max) * 7))] ?? '▁')
}

/** The share of the turns' cost spent in turns where the advisor ran. */
export const advisorShare = (turns: readonly TurnCost[]): { total: number; withAdvisor: number; count: number } =>
  turns.reduce(
    (sum, turn) => ({
      total: sum.total + turn.usd,
      withAdvisor: sum.withAdvisor + (turn.advisorCalls > 0 ? turn.usd : 0),
      count: sum.count + (turn.advisorCalls > 0 ? 1 : 0),
    }),
    { total: 0, withAdvisor: 0, count: 0 },
  )

const dollars = (usd: number): string => (usd > 0 && usd < 0.01 ? '<0.01' : usd.toFixed(2))

const points = (spent: number): string => {
  const value = Math.round(spent * 10) / 10
  return `${value} pt${value >= 2 ? 's' : ''}`
}

/** `reset 2h05` / `reset 3d`; empty when the host gave no reset time. */
const resetIn = (iso: string | undefined, at: number): string => {
  const mins = iso === undefined ? Number.NaN : Math.max(0, Math.round((Date.parse(iso) - at) / 60000))
  if (Number.isNaN(mins)) return ''
  if (mins < 60) return `reset ${mins}m`
  const hours = Math.floor(mins / 60)

  return hours < 48 ? `reset ${hours}h${String(mins % 60).padStart(2, '0')}` : `reset ${Math.round(hours / 24)}d`
}

/** `jev` answers one line of JSON: `{"choice": "...", "confidence": 0.7}`. */
export const parseVerdict = (answer: string): { choice: string; confidence: number } | undefined => {
  const match = /\{[^{}]*"choice"[^{}]*\}/.exec(answer)
  if (!match) return undefined
  try {
    const value = JSON.parse(match[0]) as { choice?: unknown; confidence?: unknown }
    const confidence = Number(value.confidence)
    if (typeof value.choice !== 'string' || Number.isNaN(confidence)) return undefined

    return { choice: value.choice, confidence: Math.min(1, Math.max(0, confidence)) }
  } catch {
    return undefined
  }
}

/** Which of the three moments an advisor call answers. */
export const classify = (step: { isRepeatOpen: boolean; stopReason: string | null; edits: number }): Checkpoint =>
  step.isRepeatOpen ? 'error' : step.stopReason === 'end_turn' ? 'done' : step.edits === 0 ? 'plan' : 'mid'

/** What an `advisor_tool_result` block says: the advice, an encrypted review, or the failure. */
export const advisorStatus = (block: {
  type: string
  [field: string]: unknown
}): { id: string; status: NonNullable<AdvisorCall['status']>; detail?: string } | undefined => {
  if (block.type !== 'advisor_tool_result' || typeof block.tool_use_id !== 'string') return undefined
  const id = block.tool_use_id
  const content = (typeof block.content === 'object' && block.content !== null ? block.content : {}) as Record<
    string,
    unknown
  >
  if (content.type === 'advisor_result') {
    return { id, status: 'reviewed', detail: typeof content.text === 'string' ? content.text : undefined }
  }
  if (content.type === 'advisor_redacted_result') return { id, status: 'encrypted' }
  if (content.type === 'advisor_tool_result_error') {
    return { id, status: 'unavailable', detail: String(content.error_code ?? 'unknown') }
  }

  return { id, status: 'reviewed' }
}

const detailOf = (input: Record<string, unknown>): string => {
  const value =
    input.command ?? input.file_path ?? input.pattern ?? input.description ?? input.url ?? input.query ?? ''
  return String(value).replace(/\s+/g, ' ').trim()
}

/** Two failures with the same key are "the same error twice". */
export const failKey = (tool: string, detail: string, error: string): string =>
  `${tool}:${detail || (error.split('\n')[0] ?? '').slice(0, 80)}`

const note = async (
  $: EngineInterface,
  kind: LogLine['kind'],
  text: string,
  agentId?: string,
  id?: string,
): Promise<void> => {
  const at = await $.clock.now()
  await update($, log, list => [...list, { at, kind, agentId, id, text }].slice(-MAX_LOG))
}

const finishNote = (
  $: EngineInterface,
  id: string,
  suffix: string,
  isFailed: boolean,
): Promise<unknown> =>
  update($, log, list => list.map(line => (line.id === id ? { ...line, suffix, isFailed } : line)))

const patchAgent = (
  $: EngineInterface,
  id: string | undefined,
  patch: (card: AgentCard) => Partial<AgentCard>,
): Promise<unknown> =>
  update($, agents, list => list.map(card => (card.id === id ? { ...card, ...patch(card) } : card)))

/** Adds a fork to the layer and keeps the running total across sessions. */
const recordFork = async ($: EngineInterface, call: ForkCall): Promise<void> => {
  const state = await update($, forks, one => ({ count: one.count + 1, recent: [...one.recent, call].slice(-6) }))
  await $.store.set('forks', state.count)
}

/**
 * Asks jev "retry or stop" about a failure seen twice, straight from the model: nothing of it
 * reaches the lead's conversation, only this pane.
 */
const consultJev = async ($: EngineInterface, what: string, error: string): Promise<void> => {
  const { model, system } = jevAgent()
  const prompt = [
    `State: \`${what.slice(0, 300)}\` failed twice in a row with the same error.`,
    `Last error: ${error.slice(0, 600)}`,
    'Question: retry or stop?',
    'Options: "retry", "change-approach", "stop".',
  ].join('\n')
  const reply = await $.model.complete({ model, system, prompt, maxTokens: 100 })
  if (!reply.isAnswered) return
  const verdict = parseVerdict(reply.text)
  if (verdict === undefined) return
  const at = await $.clock.now()
  await recordFork($, { id: `auto-${at}`, description: 'retry or stop', ...verdict, isAuto: true })
  await note(
    $,
    'fork',
    `auto · retry or stop → ${verdict.choice} p=${verdict.confidence.toFixed(2)} ${verdict.confidence >= SHARP ? 'sharp' : 'split'}`,
  )
}

/** A new reading of the subscription windows and the session cost: the quota bars and the spend. */
const applyUsage = async ($: EngineInterface, limits: SessionRateLimit[], usd: number | undefined): Promise<void> => {
  // an empty reading is "no figure yet", not "no quota": keep what the bars showed
  if (limits.length > 0) await update($, quota, () => toQuota(limits))
  await update($, spend, one => ({ ...one, usd: usd ?? one.usd, windows: trackWindows(one.windows, limits) }))
}

/** `#max`, `#fast`, `#opus` or `#sonnet` as the request's first or last word. */
export const parseOverride = (text: string): string | undefined => {
  const words = text.trim().toLowerCase().split(/\s+/)
  return [words[0], words.at(-1)].find(word => word !== undefined && OVERRIDES.has(word))
}

const bump = (effort: EffortLevel): EffortLevel => EFFORTS[Math.min(EFFORTS.length - 1, EFFORTS.indexOf(effort) + 1)] ?? effort

/**
 * Turns jev's answers into what the request runs with. Quality first: when jev is unsure the
 * request gets one more step of effort and an advisor consult, never less; the tier only goes up.
 * A question jev did not answer changes nothing.
 */
export const route = (input: {
  effort?: Verdict<EffortLevel>
  model?: Verdict<Tier>
  mode?: Verdict<Mode>
  tier: Tier
  effortNow?: EffortLevel
  override?: string
}): Route => {
  const { effort, model, mode, override } = input
  const workMode: Mode =
    mode === undefined
      ? 'solo'
      : mode.choice === 'team' && mode.confidence >= TEAM_AT
        ? 'team'
        : mode.choice !== 'solo' && mode.confidence >= DELEGATE_AT
          ? 'delegate'
          : 'solo'
  if (override === '#max') return { tier: 'opus', effort: 'max', mode: workMode, advisorFirst: false, isUnsure: false, override }
  if (override === '#fast') return { tier: 'sonnet', effort: 'low', mode: 'solo', advisorFirst: false, isUnsure: false, override }
  const wantsOpus = model !== undefined && model.choice === 'opus' && model.confidence >= OPUS_AT
  const isModelUnsure = model !== undefined && !wantsOpus && (model.choice === 'opus' || model.confidence < SONNET_AT)
  const isUnsure = isModelUnsure || (effort !== undefined && effort.confidence < EFFORT_AT)
  const tier: Tier =
    override === '#opus' ? 'opus' : override === '#sonnet' ? 'sonnet' : input.tier === 'opus' || wantsOpus ? 'opus' : 'sonnet'
  const chosen = effort?.choice ?? input.effortNow

  return {
    tier,
    effort: chosen !== undefined && isUnsure ? bump(chosen) : chosen,
    mode: workMode,
    advisorFirst: isUnsure,
    isUnsure,
    override,
  }
}

/** What the lead is told about the request, as a note it reads before it starts; none when solo and sure. */
export const hintFor = (decided: Route): string | undefined => {
  const lines: string[] = []
  if (decided.advisorFirst) {
    lines.push('The request router was unsure how hard this request is: before you start, consult the advisor about the approach.')
  }
  if (decided.mode === 'delegate') {
    lines.push(
      'Part of this request is better done by a subagent than in the main conversation: one for a wide read-only search, one for an isolated edit. Use the subagent types available in this session.',
    )
  }
  if (decided.mode === 'team') {
    lines.push(
      'This looks like a large task that splits into independent parts. Act as the architect: plan it, consult the advisor on the plan, split the work into parallel subtasks for subagents (read-only subagents for scans, one subagent per edit, ideally in its own worktree, using the subagent types available in this session), then review and verify the results yourself.',
    )
  }

  return lines.length === 0 ? undefined : `[request router] ${lines.join(' ')}`
}

const describeRoute = (decision: Decision): string => {
  const { route: decided } = decision
  if (decision.effort === undefined && decision.model === undefined && decision.mode === undefined && decided.override === undefined) {
    return `route · no answer from jev · nothing changed · ${decision.ms}ms`
  }

  return [
    `route → ${shortModel(TIER_MODEL[decided.tier])}`,
    decided.effort ?? 'effort =',
    decided.mode,
    ...(decided.advisorFirst ? ['advisor first'] : []),
    ...(decided.override === undefined ? [] : [decided.override]),
    ...(decided.isUnsure ? ['unsure'] : []),
    `${decision.ms}ms`,
  ].join(' · ')
}

/** One of jev's questions, answered the way jev always answers: one choice and its confidence, or nothing. */
const ask = async <T extends string>(
  $: EngineInterface,
  agent: { model: string; system: string },
  asked: { question: string; options: Record<T, string> },
  request: string,
  state: string,
): Promise<Verdict<T> | undefined> => {
  const names = Object.keys(asked.options) as T[]
  const prompt = [
    `State: ${state}`,
    `Request: """${request.slice(0, 1500)}"""`,
    `Question: ${asked.question}`,
    `Options: ${names.map(name => `"${name}" (${asked.options[name]})`).join(', ')}.`,
  ].join('\n')
  const reply = await $.model.complete({ model: agent.model, system: agent.system, prompt, maxTokens: 60, timeoutMs: DECIDE_MS })
  if (!reply.isAnswered) return undefined
  const verdict = parseVerdict(reply.text)
  const choice = names.find(name => name === verdict?.choice)

  return verdict === undefined || choice === undefined ? undefined : { choice, confidence: verdict.confidence }
}

/** Asks jev its three questions about a request, side by side, and routes from the answers. */
const decide = async ($: EngineInterface, request: string, state: Router): Promise<Decision> => {
  const startedAt = await $.clock.now()
  const agent = jevAgent()
  const context = await $.session
    .usage()
    .then(usage => usage.context.tokens)
    .catch(() => undefined)
  const situation = `a person just sent this request to a coding agent (Claude Code). The session runs on ${state.tier}${context === undefined ? '' : `; its conversation holds about ${tokens(context)} tokens`}.`
  const [effort, model, mode] = await Promise.all([
    ask($, agent, EFFORT_QUESTION, request, situation).catch(() => undefined),
    ask($, agent, MODEL_QUESTION, request, situation).catch(() => undefined),
    ask($, agent, MODE_QUESTION, request, situation).catch(() => undefined),
  ])
  const decided = route({ effort, model, mode, tier: state.tier, effortNow: state.effort, override: parseOverride(request) })

  return { at: startedAt, ms: (await $.clock.now()) - startedAt, effort, model, mode, route: decided }
}

/** Applies a change to the history, caps it, and keeps it for the next sessions. */
const keepHistory = async ($: EngineInterface, change: (kept: History) => History): Promise<void> => {
  const kept = await update($, history, one => {
    const next = change(one)
    return {
      decisions: next.decisions.slice(-KEEP.decisions),
      advisor: next.advisor.slice(-KEEP.advisor),
      agents: next.agents.slice(-KEEP.agents),
    }
  })
  await $.store.set('history', kept)
}

const tally = <T,>(list: readonly T[], key: (item: T) => string): Record<string, number> =>
  list.reduce<Record<string, number>>((counts, item) => {
    const name = key(item)
    counts[name] = (counts[name] ?? 0) + 1
    return counts
  }, {})

const mean = (values: readonly number[]): number | undefined =>
  values.length === 0 ? undefined : values.reduce((sum, value) => sum + value, 0) / values.length

/** The history since a moment, counted for the pane: how jev decides, how the advisor and subagents run. */
export const summarize = (kept: History, since: number) => {
  const decisions = kept.decisions.filter(item => item.at >= since)
  const consults = kept.advisor.filter(item => item.at >= since)
  const runs = kept.agents.filter(item => item.at >= since)
  const confidence = (pick: (item: DecisionRecord) => Verdict<string> | undefined) =>
    mean(decisions.flatMap(item => {
      const verdict = pick(item)
      return verdict === undefined ? [] : [verdict.confidence]
    }))

  return {
    decisions: decisions.length,
    tiers: tally(decisions, item => item.route.tier),
    efforts: tally(decisions, item => item.route.effort ?? '='),
    modes: tally(decisions, item => item.route.mode),
    unsure: decisions.filter(item => item.route.isUnsure).length,
    overrides: decisions.filter(item => item.route.override !== undefined).length,
    unanswered: decisions.filter(item => item.effort === undefined && item.model === undefined && item.mode === undefined).length,
    confidence: {
      effort: confidence(item => item.effort),
      model: confidence(item => item.model),
      mode: confidence(item => item.mode),
    },
    decideMs: mean(decisions.map(item => item.ms)),
    consults: consults.length,
    checkpoints: tally(consults, item => item.checkpoint),
    statuses: tally(consults, item => item.status ?? 'received'),
    consultMs: mean(consults.flatMap(item => (item.ms === undefined ? [] : [item.ms]))),
    runs: runs.length,
    types: tally(runs, item => item.type),
    models: tally(runs, item => shortModel(item.model)),
    runMs: mean(runs.map(item => item.ms)),
    stopped: runs.filter(item => item.status === 'stopped').length,
  }
}

/** A tally as `a 3 · b 1`, largest first. */
const counts = (tallied: Record<string, number>, order?: readonly string[]): string =>
  Object.entries(tallied)
    .sort(([a, x], [b, y]) => (order === undefined ? y - x : order.indexOf(a) - order.indexOf(b)))
    .map(([name, count]) => `${name} ${count}`)
    .join(' · ') || '—'

/** A hook only observes: a failure here must never reach the session. */
const safely = async (work: () => Promise<unknown>): Promise<void> => {
  try {
    await work()
  } catch {
    // the pane is a mirror; losing one update is better than breaking a turn
  }
}

export const register: Register = (on, options) => {
  config = readConfig(options)
  // subagents whose loop is running (they keep the ticker going) and jev runs awaiting a verdict
  const live = new Set<string>()
  const forkIds = new Set<string>()
  // failures per key in the current turn, and advisor results that arrived before their step ended
  const fails = new Map<string, number>()
  const statusById = new Map<string, { status: NonNullable<AdvisorCall['status']>; detail?: string }>()
  // the lead's response as it streams, in wall-clock milliseconds; the ticker publishes it
  const stream = {
    isActive: false,
    hasStarted: false,
    lastAt: 0,
    lastKind: '',
    engineItems: 0,
    phase: 'waiting' as Phase,
    phaseAt: 0,
    chars: 0,
  }
  let isLeadActive = false
  let autoCount = 0
  // the session cost when the lead's turn began, and the advisor calls made during it
  let turnCostAt: number | undefined
  let turnAdvisorCalls = 0
  let tick: Timer | undefined

  const observe = (chunk: TurnStepChunk): void => {
    const wall = Date.now()
    const phase: Phase | undefined =
      chunk.kind === 'text'
        ? 'writing'
        : chunk.kind === 'thinking'
          ? 'thinking'
          : chunk.kind === 'tool' || chunk.kind === 'input'
            ? 'tool-input'
            : undefined
    if (chunk.kind === 'text') stream.chars += chunk.text.length
    if (chunk.kind === 'engine') stream.engineItems += 1
    if (phase !== undefined) {
      stream.hasStarted = true
      if (phase !== stream.phase) {
        stream.phase = phase
        stream.phaseAt = wall
      }
    }
    stream.lastAt = wall
    stream.lastKind = chunk.kind
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'brigade', description: 'Open the Brigade pane: live diagram and history' })
    if (config.panel === 'auto') void $.ui.open({ id: PANE, title: TITLE, columns: PANE_COLUMNS, rows: PANE_ROWS })
    tick?.cancel()
    tick = $.clock.every(TICK_MS, () => {
      if (!isLeadActive && live.size === 0) return
      void (async () => {
        const at = await $.clock.now()
        await update($, now, () => at)
        if (!stream.isActive) return
        const wall = Date.now()
        const gap = wall - stream.lastAt
        const isPaused =
          gap > PAUSE_MS && stream.lastKind === 'engine' && (stream.hasStarted || stream.engineItems >= 2)
        const phase: Phase = isPaused ? 'paused' : stream.hasStarted ? stream.phase : 'waiting'
        const phaseSec = Math.round((wall - (isPaused ? stream.lastAt : stream.phaseAt)) / 1000)
        await update($, lead, one =>
          one.phase === phase && one.phaseSec === phaseSec && one.outChars === stream.chars
            ? one
            : { ...one, phase, phaseSec, outChars: stream.chars },
        )
        if (isPaused) {
          await update($, advisor, one => (one.pendingSince === undefined ? { ...one, pendingSince: at - gap } : one))
        }
      })().catch(() => undefined)
    })
    // a new conversation starts from the session's own model
    await safely(() => update($, router, () => INITIAL_ROUTER))
    // what earlier sessions kept: jev's decisions, advisor consults, subagent runs
    await safely(async () => {
      const stored = (await $.store.get('history')) as Partial<History> | undefined
      if (stored === undefined) return
      await update($, history, one =>
        one.decisions.length + one.advisor.length + one.agents.length > 0
          ? one
          : { decisions: stored.decisions ?? [], advisor: stored.advisor ?? [], agents: stored.agents ?? [] },
      )
    })
    await safely(async () => {
      const stored = Number((await $.store.get('forks')) ?? 0)
      if (stored > 0) await update($, forks, one => ({ ...one, count: Math.max(one.count, stored) }))
    })
    await safely(async () => {
      const settings = await $.settings.read()
      const model = typeof settings.advisorModel === 'string' ? settings.advisorModel : ''
      await update($, advisor, one => ({ ...one, model }))
    })
    await safely(async () => {
      const usage = await $.session.usage()
      await applyUsage($, usage.rateLimits, usage.cost?.usd)
    })

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await safely(async () => {
      if (e.changed.includes('rateLimits') || e.changed.includes('cost')) {
        await applyUsage($, e.rateLimits, e.cost?.usd)
      }
    })

    return next(e)
  })

  on('command.run', { command: 'brigade' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE, columns: PANE_COLUMNS, rows: PANE_ROWS })

    return { text: 'Brigade pane opened: s service · w 7 days · a all history.' }
  })

  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    await safely(async () => {
      if (spawned.deny !== undefined || spawned.agentId === undefined) return
      const id = spawned.agentId
      if (FORK_TYPES.has(e.subagentType)) {
        forkIds.add(id)
        await recordFork($, { id, description: e.description })
        await note($, 'fork', `${e.description} …`, id)
        return
      }
      const startedAt = await $.clock.now()
      live.add(id)
      await update($, agents, list =>
        [
          ...list,
          {
            id,
            type: e.subagentType,
            description: e.description,
            model: spawned.model,
            status: 'running' as const,
            startedAt,
            steps: 0,
          },
        ].slice(-MAX_AGENTS),
      )
      await update($, now, () => startedAt)
      await note($, 'spawn', `${e.subagentType} · ${e.description}`, id)
    })

    return spawned
  })

  // this host raises turn.start for the lead's turns alone; a subagent is marked running at spawn
  on('turn.start', async ($, e, next) => {
    const started = await next(e)
    await safely(async () => {
      const at = await $.clock.now()
      isLeadActive = true
      stream.chars = 0
      fails.clear()
      turnAdvisorCalls = 0
      turnCostAt = undefined
      await update($, lead, (one): Lead => ({
        ...one,
        isTurnActive: true,
        turnStartedAt: at,
        phase: 'waiting',
        phaseSec: 0,
        outChars: 0,
        edits: 0,
        tool: undefined,
      }))
      await update($, now, () => at)
    })
    await safely(async () => {
      // a reading before the turn: the baseline its cost and quota points are counted from
      const usage = await $.session.usage()
      turnCostAt = usage.cost?.usd
      await applyUsage($, usage.rateLimits, usage.cost?.usd)
    })
    // the router: the decision made when the request was submitted takes effect with its turn;
    // a turn without one (a continuation, a delivery) keeps the last decision
    await safely(() =>
      update($, router, one =>
        one.pending === undefined
          ? one
          : { ...one, tier: one.pending.route.tier, effort: one.pending.route.effort, last: one.pending, pending: undefined },
      ),
    )

    return started
  })

  // jev decides when the person submits a request: its note to the lead travels as context beside
  // the prompt (read by the model, never shown), and model and effort wait for the turn to start
  on('prompt.submit', async ($, e, next) => {
    let hint: string | undefined
    await safely(async () => {
      const request = e.text.trim()
      if (config.routing !== 'on' || request === '' || request.startsWith('/') || !ROUTED_ORIGINS.has(e.origin.kind)) return
      const at = await $.clock.now()
      // the pane's clock follows the host's, so the history window is measured on the same clock as its records
      await update($, now, () => at)
      const before = await read($, router)
      const isCold = before.lastActiveAt !== undefined && at - before.lastActiveAt > COLD_MS
      const decision = await decide($, request, isCold ? { ...before, tier: 'sonnet' } : before)
      await update($, router, one => ({ ...one, pending: decision }))
      const answers = [
        ['effort', decision.effort],
        ['model', decision.model],
        ['mode', decision.mode],
      ] as const
      for (const [question, verdict] of answers) {
        if (verdict !== undefined) {
          await recordFork($, { id: `${question}-${at}`, description: question, choice: verdict.choice, confidence: verdict.confidence })
        }
      }
      hint = hintFor(decision.route)
      await note($, 'fork', describeRoute(decision))
      const record: DecisionRecord = {
        at,
        request: clip(request.replace(/\s+/g, ' '), 70),
        effort: decision.effort,
        model: decision.model,
        mode: decision.mode,
        route: decision.route,
        ms: decision.ms,
      }
      await safely(() => keepHistory($, kept => ({ ...kept, decisions: [...kept.decisions, record] })))
      // the same decision in `claude --debug`, with jev's raw answers
      await safely(async () =>
        $.ui.log(
          `jev: effort ${decision.effort?.choice ?? '?'} ${decision.effort?.confidence ?? ''} · model ${decision.model?.choice ?? '?'} ${decision.model?.confidence ?? ''} · mode ${decision.mode?.choice ?? '?'} ${decision.mode?.confidence ?? ''} → ${describeRoute(decision)}`,
          { to: 'debug' },
        ),
      )
    })

    return next(hint === undefined ? e : { ...e, context: [...(e.context ?? []), hint] })
  })

  // compaction rebuilds the cache anyway: the tier may start over from the session's own model
  on('session.compact', async ($, e, next) => {
    const compacted = await next(e)
    if (e.agentId === undefined) await safely(() => update($, router, (one): Router => ({ ...one, tier: 'sonnet' })))

    return compacted
  })

  on('turn.step', async function* ($, e, next) {
    const isMain = e.agentId === undefined
    // the lead's requests run on the routed model and effort; never below the session's own model
    let routed = e
    if (isMain && config.routing === 'on' && ROUTED.has(e.model)) {
      try {
        const state = await read($, router)
        const tier: Tier = e.model === TIER_MODEL.opus || state.tier === 'opus' ? 'opus' : 'sonnet'
        routed = { ...e, model: TIER_MODEL[tier], effort: state.effort ?? e.effort }
      } catch {
        routed = e
      }
    }
    await safely(async () => {
      if (isMain) {
        await update($, lead, (one): Lead => ({
          ...one,
          model: routed.model,
          effort: routed.effort === undefined ? '' : String(routed.effort),
          steps: one.steps + 1,
        }))
      } else {
        await patchAgent($, e.agentId, card => ({ steps: card.steps + 1, model: e.model }))
      }
    })

    if (isMain) {
      const wall = Date.now()
      Object.assign(stream, {
        isActive: true,
        hasStarted: false,
        lastAt: wall,
        lastKind: '',
        engineItems: 0,
        phase: 'waiting',
        phaseAt: wall,
      })
    }
    const source = next(routed)
    try {
      for await (const chunk of source) {
        if (isMain) observe(chunk)
        yield chunk
      }
    } finally {
      if (isMain) stream.isActive = false
    }
    const step = await source.result

    await safely(async () => {
      const uses = (step.serverToolUses ?? []).filter(use => use.name === 'advisor')
      if (isMain) {
        await update($, lead, (one): Lead => ({ ...one, outChars: stream.chars, phase: 'waiting', phaseSec: 0 }))
      }
      if (uses.length === 0) {
        if (isMain) await update($, advisor, one => ({ ...one, pendingSince: undefined }))
        return
      }
      if (isLeadActive) turnAdvisorCalls += uses.length
      const usage = step.usage
      // the step's input is summed over the executor's passes around each consult: split it
      const context = usage
        ? Math.round(
            (usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens) /
              (uses.length + 1),
          )
        : undefined
      const edits = (await read($, lead)).edits
      const where = isMain
        ? 'lead'
        : ((await read($, agents)).find(card => card.id === e.agentId)?.type ?? 'agent')
      for (const use of uses) {
        const state = await read($, advisor)
        const isRepeatOpen = state.repeat !== undefined && !state.repeat.consulted
        const checkpoint = classify({ isRepeatOpen, stopReason: step.stopReason, edits: isMain ? edits : 1 })
        const ms = use.endedAt === undefined ? undefined : use.endedAt - use.startedAt
        const known = statusById.get(use.id)
        const call: AdvisorCall = {
          id: use.id,
          at: use.startedAt,
          ms,
          contextTokens: context,
          checkpoint,
          where,
          status: known?.status,
          detail: known?.detail,
        }
        await update($, advisor, one => ({
          ...one,
          calls: one.calls + 1,
          tokensRead: one.tokensRead + (context ?? 0),
          marks: { ...one.marks, [checkpoint]: one.marks[checkpoint] + 1 },
          recent: [...one.recent, call].slice(-8),
          pendingSince: undefined,
          repeat: checkpoint === 'error' && one.repeat !== undefined ? { ...one.repeat, consulted: true } : one.repeat,
        }))
        await note(
          $,
          'advisor',
          `◆ ${CHECKPOINT_LABEL[checkpoint]} · ${ms === undefined ? 'no result' : elapsed(ms)}${context === undefined ? '' : ` · read ≈ ${tokens(context)}`}${isMain ? '' : ` · ${where}`}`,
          e.agentId,
        )
        const record: AdvisorRecord = { id: use.id, at: use.startedAt, checkpoint, ms, status: known?.status, where }
        await safely(() => keepHistory($, kept => ({ ...kept, advisor: [...kept.advisor, record] })))
      }
    })

    return step
  })

  on('session.append', async ($, e, next) => {
    const kept = await next(e)
    await safely(async () => {
      for (const block of e.message.content) {
        const found = advisorStatus(block)
        if (found === undefined) continue
        statusById.set(found.id, found)
        await update($, advisor, one => ({
          ...one,
          recent: one.recent.map(call =>
            call.id === found.id ? { ...call, status: found.status, detail: found.detail } : call,
          ),
        }))
        if ((await read($, history)).advisor.some(item => item.id === found.id)) {
          await keepHistory($, kept => ({
            ...kept,
            advisor: kept.advisor.map(item => (item.id === found.id ? { ...item, status: found.status } : item)),
          }))
        }
      }
    })

    return kept
  })

  on('tool.call', async ($, e, next) => {
    const isMain = e.agentId === undefined
    const detail = detailOf(e as unknown as Record<string, unknown>)
    const startedAt = await $.clock.now()
    const lineId = e.tool_use_id ?? `${e.tool}-${startedAt}`
    await safely(async () => {
      if (isMain) {
        await update($, lead, (one): Lead => ({
          ...one,
          tool: e.tool,
          toolDetail: detail,
          toolStartedAt: startedAt,
          phase: 'tool',
          edits: one.edits + (EDIT_TOOLS.has(e.tool) ? 1 : 0),
        }))
      } else {
        await patchAgent($, e.agentId, () => ({ tool: e.tool }))
      }
      await note($, isMain ? 'lead' : 'agent', detail ? `${e.tool} ${detail}` : e.tool, e.agentId, lineId)
    })
    const ran = await next(e)
    await safely(async () => {
      const endedAt = await $.clock.now()
      const isFailed = ran.deny !== undefined || ran.isError === true
      if (isMain) {
        await update($, lead, (one): Lead => ({
          ...one,
          tool: undefined,
          toolDetail: undefined,
          toolStartedAt: undefined,
          phase: one.isTurnActive ? 'waiting' : 'idle',
        }))
      } else {
        await patchAgent($, e.agentId, () => ({ tool: undefined }))
      }
      await finishNote($, lineId, `${isFailed ? '✗' : '✓'} ${elapsed(endedAt - startedAt)}`, isFailed)
      // a refusal is no error to retry
      if (ran.deny !== undefined) return
      const key = failKey(e.tool, detail, ran.text ?? '')
      if (!isFailed) {
        fails.delete(key)
        return
      }
      const count = (fails.get(key) ?? 0) + 1
      fails.set(key, count)
      if (count !== 2) return
      const what = detail ? `${e.tool} ${clip(detail, 40)}` : e.tool
      await update($, advisor, one => ({ ...one, repeat: { at: endedAt, text: what, consulted: false } }))
      await note($, 'error', `same error x2 · ${what}`, e.agentId)
      if (config.retryConsult && autoCount < MAX_AUTO) {
        autoCount += 1
        void consultJev($, what, ran.text ?? '').catch(() => undefined)
      }
    })

    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    await safely(async () => {
      if (e.agentId === undefined) {
        isLeadActive = false
        stream.isActive = false
        const endedAt = await $.clock.now()
        await update($, router, one => ({ ...one, lastActiveAt: endedAt }))
        await update($, lead, (one): Lead => ({ ...one, isTurnActive: false, tool: undefined, phase: 'idle', phaseSec: 0 }))
        await update($, advisor, one => ({ ...one, pendingSince: undefined }))
        const usage = await $.session.usage()
        await applyUsage($, usage.rateLimits, usage.cost?.usd)
        const usd = usage.cost?.usd
        if (usd !== undefined && turnCostAt !== undefined) {
          const turn: TurnCost = {
            at: await $.clock.now(),
            usd: Math.max(0, usd - turnCostAt),
            advisorCalls: turnAdvisorCalls,
          }
          await update($, spend, one => ({ ...one, turns: [...one.turns, turn].slice(-80) }))
        }
        turnCostAt = undefined
        return
      }
      const id = e.agentId
      if (forkIds.has(id)) {
        forkIds.delete(id)
        const verdict = parseVerdict(e.answer)
        if (verdict === undefined) return
        const state = await update($, forks, one => ({
          ...one,
          recent: one.recent.map(call => (call.id === id ? { ...call, ...verdict } : call)),
        }))
        const asked = state.recent.find(call => call.id === id)?.description ?? 'fork'
        await note(
          $,
          'fork',
          `${asked} → ${verdict.choice} p=${verdict.confidence.toFixed(2)} ${verdict.confidence >= SHARP ? 'sharp' : 'split'}`,
          id,
        )
        return
      }
      const endedAt = await $.clock.now()
      live.delete(id)
      const status = e.reason === 'answer' ? 'done' : 'stopped'
      await patchAgent($, id, () => ({ status, endedAt, tool: undefined }))
      const card = (await read($, agents)).find(one => one.id === id)
      if (card !== undefined) {
        const record: AgentRecord = {
          at: card.startedAt,
          type: card.type,
          model: card.model,
          ms: Math.max(0, endedAt - card.startedAt),
          status,
        }
        await safely(() => keepHistory($, kept => ({ ...kept, agents: [...kept.agents, record] })))
      }
      await update($, now, () => endedAt)
      await note($, 'agent', status === 'done' ? '✓ done' : '■ stopped', id)
    })

    return done
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const [one, cards, adv, lines, at, fk, limits, sp, rt, kept, shown] = await Promise.all([
      read($, lead),
      read($, agents),
      read($, advisor),
      read($, log),
      read($, now),
      read($, forks),
      read($, quota),
      read($, spend),
      read($, router),
      read($, history),
      read($, view),
    ])
    const W = Math.max(40, e.props.bodyColumns)
    const isWide = W >= WIDE
    const isCompact = e.props.scroll.bodyRows < TALL
    const spacer = isCompact ? 0 : 1
    const running = cards.filter(card => card.status === 'running')
    // before the first request no model has been seen: name the role rather than a '?'
    const leadName = one.model === '' ? 'lead' : shortModel(one.model)
    const advisorName = adv.model === '' ? '' : shortModel(adv.model)
    const spin = SPIN[Math.floor(at / TICK_MS) % SPIN.length] ?? '◐'
    const level = (EFFORTS as readonly string[]).indexOf(one.effort)
    const effortBar =
      level < 0 ? '' : `${'▮'.repeat(level + 1)}${'▯'.repeat(EFFORTS.length - level - 1)} `

    // Geometry of the wide diagram: [advisor | link | right column]; the right column's
    // boxes share one width, and the connectors between them sit on its centre.
    const LEFT = Math.min(30, Math.max(24, Math.floor(W * 0.27)))
    const LINK = 5
    const R = W - LEFT - LINK
    const RW = R - 2
    const c2 = Math.floor(RW / 2)
    const LW = isWide ? Math.min(RW, Math.max(26, Math.floor(RW * 0.6))) : W
    const leadMargin = isWide ? Math.max(0, c2 - Math.floor(LW / 2)) : 0
    const FULL = isWide ? RW : W

    // a connector lights up in the subagents' blue while any of them runs
    const isDelegating = running.length > 0
    const stem = (ch: string, isLit = false) => (
      <Text color={isLit ? BLUE : undefined} dimColor={!isLit}>{`${' '.repeat(c2)}${ch}`}</Text>
    )

    // ── subagents: one compact box, one line per agent; the box lights up while any runs ──
    // columns: mark · type · model · steps bar · what it is doing · status (the last two are
    // dropped when the pane is too narrow to hold them)
    const innerW = Math.max(20, FULL - 4)
    const STATUS_W = 22
    const hasDesc = innerW >= 70
    const descW = hasDesc ? innerW - 2 - 9 - 11 - 13 - STATUS_W : 0
    const subLine = (key: string, type: string, role: string, card?: AgentCard) => {
      const isRunning = card?.status === 'running'
      const color = card ? colorOf(card.model) : BLUE
      const age = card ? Math.max(card.endedAt ?? at, card.startedAt) - card.startedAt : 0
      const mark = card === undefined ? '○' : isRunning ? spin : card.status === 'done' ? '✓' : '■'
      const status =
        card === undefined
          ? 'idle'
          : isRunning
            ? `running ${elapsed(age)}${card.tool === undefined ? '' : ` · ${card.tool}`}`
            : `${card.status === 'done' ? 'done' : 'stopped'} ${elapsed(age)}`
      const statusColor = isRunning ? color : card?.status === 'done' ? GREEN : undefined

      return (
        <Text key={key} wrap="truncate-end">
          <Text bold={isRunning} color={isRunning ? color : card?.status === 'done' ? GREEN : undefined} dimColor={card === undefined || card.status === 'stopped'}>
            {`${mark} `}
          </Text>
          <Text bold={isRunning} color={BLUE} dimColor={card === undefined}>
            {clip(type, 8).padEnd(9)}
          </Text>
          <Text color={card ? color : undefined} dimColor={card === undefined}>
            {(card ? shortModel(card.model) : '—').padEnd(11)}
          </Text>
          {hasDesc && (
            <Text color={card ? color : undefined} dimColor={card === undefined}>
              {`${bar(card?.steps ?? 0, 8)} ${String(card?.steps ?? 0).padStart(2)}  `}
            </Text>
          )}
          {hasDesc && <Text dimColor>{clip(card ? card.description : role, descW - 2).padEnd(descW)}</Text>}
          <Text bold={isRunning} color={statusColor} dimColor={card === undefined || card.status === 'stopped'}>
            {status}
          </Text>
        </Text>
      )
    }

    // the latest subagents, whatever their type, the running ones first; one idle line before any ran
    const recent = cards
      .slice(-8)
      .reverse()
      .sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running'))
      .slice(0, MAX_SUB_LINES)
    const subLines =
      recent.length === 0
        ? [subLine('none', 'none yet', 'subagents the lead launches show here', undefined)]
        : recent.map(card => subLine(card.id, card.type, '', card))
    const planned = rt.last?.route.mode
    const runningModels = [...new Set(running.map(card => shortModel(card.model)))].join(' + ')
    const subBox = (
      <Box
        flexDirection="column"
        width={FULL}
        borderStyle={isDelegating ? 'double' : 'round'}
        borderColor={isDelegating ? BLUE : undefined}
        paddingX={1}
      >
        <Box justifyContent="space-between">
          <Text bold color={BLUE}>
            commis · delegated work
          </Text>
          <Text wrap="truncate-end">
            {planned !== undefined && planned !== 'solo' && <Text color={PURPLE}>{`router → ${planned}   `}</Text>}
            {isDelegating ? (
              <Text bold color={BLUE}>{`${spin} ${running.length} running`}</Text>
            ) : (
              <Text dimColor>{`idle · ${cards.length} run${cards.length === 1 ? '' : 's'}`}</Text>
            )}
            {isDelegating && runningModels !== '' && <Text dimColor>{` · ${runningModels}`}</Text>}
          </Text>
        </Box>
        {subLines}
      </Box>
    )

    // ── advisor column: the three moments an advisor consult usually answers (before a plan, a repeated error, before done), lit as they happen ──
    const lastCall = adv.recent.at(-1)
    const lastOf = (checkpoint: Checkpoint) => [...adv.recent].reverse().find(call => call.checkpoint === checkpoint)
    const isFresh = (call: AdvisorCall | undefined) => call !== undefined && at - call.at < FLASH_MS
    const isConsulting = adv.pendingSince !== undefined
    const repeatOpen = adv.repeat !== undefined && !adv.repeat.consulted ? adv.repeat : undefined
    const statusText = (call: AdvisorCall): string =>
      call.status === 'encrypted'
        ? 'reviewed · encrypted'
        : call.status === 'unavailable'
          ? `unavailable (${call.detail ?? '?'})`
          : call.status === 'reviewed'
            ? 'reviewed'
            : 'received'

    const mark = (checkpoint: Checkpoint) => {
      const call = lastOf(checkpoint)
      const count = adv.marks[checkpoint]
      const isLit = count > 0 || (checkpoint === 'error' && repeatOpen !== undefined)
      const flash = isFresh(call) || (checkpoint === 'error' && repeatOpen !== undefined)

      return (
        <Box flexDirection="column">
          <Box justifyContent="space-between">
            <Text
              bold={isLit}
              color={isLit ? (checkpoint === 'error' && repeatOpen ? ORANGE : PURPLE) : undefined}
              dimColor={!isLit}
              backgroundColor={flash ? FLASH : undefined}
              wrap="truncate-end"
            >
              {isLit ? '◆' : '◇'} {CHECKPOINT_LABEL[checkpoint]}
            </Text>
            {count > 0 && <Text color={PURPLE}>×{count}</Text>}
          </Box>
          {call !== undefined && (
            <Text dimColor wrap="truncate-end">
              │ {clock(call.at).slice(0, 5)}
              {call.ms === undefined ? '' : ` · ${elapsed(call.ms)}`}
            </Text>
          )}
          {checkpoint === 'error' && repeatOpen !== undefined && (
            <Text color={ORANGE} wrap="truncate-end">
              │ ⚠ {repeatOpen.text}
            </Text>
          )}
        </Box>
      )
    }

    const describe = (text: string) =>
      !isCompact && (
        <Text dimColor wrap="truncate-end">
          │ {text}
        </Text>
      )

    const advisorBox = (
      <Box
        flexDirection="column"
        flexGrow={1}
        borderStyle="round"
        borderColor={isConsulting ? ORANGE : PURPLE}
        paddingX={1}
      >
        <Box justifyContent="center">
          <Text bold color={PURPLE}>
            {advisorName === '' ? 'HEAD CHEF' : `HEAD CHEF · ${advisorName.toUpperCase()}`}
          </Text>
        </Box>
        <Box justifyContent="center">
          {isConsulting ? (
            <Text bold color={ORANGE} backgroundColor={FLASH}>
              {spin} consulting? {elapsed(Math.max(0, at - (adv.pendingSince ?? at)))}
            </Text>
          ) : (
            <Text color={PURPLE}>advisor · on call</Text>
          )}
        </Box>
        {!isCompact && <Text> </Text>}
        {mark('plan')}
        {describe('reads the whole')}
        {describe('session, every tool')}
        {describe('call and result')}
        <Text dimColor>│</Text>
        <Text dimColor>│ last advice:</Text>
        {lastCall === undefined ? (
          <Text dimColor>│ » silent so far</Text>
        ) : lastCall.status === 'reviewed' && lastCall.detail !== undefined ? (
          <Text color={PURPLE} wrap="wrap">
            » {clip(lastCall.detail.replace(/\s+/g, ' '), 140)}
          </Text>
        ) : (
          <Text color={lastCall.status === 'unavailable' ? RED : PURPLE} wrap="truncate-end">
            │ » {statusText(lastCall)}
          </Text>
        )}
        <Text dimColor>│</Text>
        <Text wrap="truncate-end">
          <Text dimColor>│ </Text>calls <Text bold color={PURPLE}>{adv.calls}</Text>
        </Text>
        {adv.tokensRead > 0 && (
          <Text dimColor wrap="truncate-end">
            │ tokens read ≈ {tokens(adv.tokensRead)}
          </Text>
        )}
        {describe('silent on every')}
        {describe('routine turn')}
        <Text dimColor>│</Text>
        {mark('error')}
        {describe('never writes code;')}
        {describe(`${leadName} applies it`)}
        <Text dimColor>│</Text>
        {mark('done')}
      </Box>
    )

    // ── lead: what the main session is doing this second ──
    const phaseLine = (): { text: string; color?: string; isDim?: boolean } => {
      if (!one.isTurnActive) return { text: 'idle', isDim: true }
      switch (one.phase) {
        case 'tool':
          return {
            text: `» ${one.tool ?? 'tool'}${one.toolDetail ? ` ${clip(one.toolDetail, 24)}` : ''} ${elapsed(Math.max(0, at - (one.toolStartedAt ?? at)))}`,
            color: ORANGE,
          }
        case 'thinking':
          return { text: `${spin} thinking ${one.phaseSec}s`, color: ORANGE }
        case 'writing':
          return { text: `✎ writing · ${tokens(one.outChars)} chars`, color: ORANGE }
        case 'tool-input':
          return { text: '» preparing a tool call', color: ORANGE }
        case 'paused':
          return { text: `⏸ paused ${one.phaseSec}s · advisor?`, color: PURPLE }
        default:
          return { text: `${spin} waiting for the model`, isDim: true }
      }
    }
    const phase = phaseLine()

    const leadBox = (
      <Box
        flexDirection="column"
        width={LW}
        marginLeft={leadMargin}
        borderStyle="round"
        borderColor={ORANGE}
        paddingX={1}
      >
        <Box justifyContent="center">
          <Text bold color={ORANGE} wrap="truncate-end">
            {leadName.toUpperCase()} · the line
          </Text>
        </Box>
        <Box justifyContent="center">
          <Text color={phase.color} dimColor={phase.isDim === true} wrap="truncate-end">
            {phase.text}
          </Text>
        </Box>
        <Box justifyContent="center">
          <Text color={ORANGE}>
            effort {effortBar}
            {one.effort === '' ? '?' : one.effort}
          </Text>
        </Box>
        <Box justifyContent="center">
          <Text dimColor wrap="truncate-end">
            {one.isTurnActive && one.turnStartedAt !== undefined
              ? `turn ${elapsed(Math.max(0, at - one.turnStartedAt))} · `
              : ''}
            {one.steps} model {one.steps === 1 ? 'step' : 'steps'}
            {one.outChars > 0 ? ` · ${tokens(one.outChars)} chars` : ''}
          </Text>
        </Box>
      </Box>
    )

    // ── fork layer: jev's decisions, as bars of confidence, and what the router applied ──
    const LABEL_W = 22
    const forkBar = Math.max(4, FULL - 4 - LABEL_W - 12)
    const applied = rt.last?.route
    const routeLine =
      applied === undefined ? undefined : (
        <Text wrap="truncate-end">
          <Text bold color={GREEN}>
            {`→ ${shortModel(TIER_MODEL[applied.tier]).toUpperCase()} · effort ${applied.effort ?? '='} · ${applied.mode}`}
          </Text>
          {applied.advisorFirst && <Text color={PURPLE}> · advisor first</Text>}
          {applied.override !== undefined && <Text color={ORANGE}>{` · ${applied.override}`}</Text>}
          {applied.isUnsure && <Text color={ORANGE}> · unsure</Text>}
          <Text dimColor>{` · ${rt.last?.ms ?? 0}ms`}</Text>
        </Text>
      )
    const forkBox = (
      <Box flexDirection="column" width={FULL} borderStyle="round" borderColor={GREEN} paddingX={1}>
        <Box justifyContent="space-between">
          <Text bold color={GREEN}>
            JEV · the pass
          </Text>
          <Text dimColor>
            forks <Text bold color={GREEN}>{fk.count.toLocaleString('en-US')}</Text>
          </Text>
        </Box>
        {fk.recent.length === 0 ? (
          <Text dimColor>no forks yet</Text>
        ) : (
          fk.recent.slice(-3).map(call => {
            const asked = call.choice === undefined ? call.description : `${call.description} → ${call.choice}`
            const label = clip(asked, LABEL_W - 1).padEnd(LABEL_W)
            if (call.confidence === undefined) {
              return (
                <Text key={call.id} wrap="truncate-end">
                  {label}
                  <Text dimColor>{spin} asking jev…</Text>
                </Text>
              )
            }
            const isSharp = call.confidence >= SHARP
            const tint = isSharp ? GREEN : ORANGE
            const [full, empty] = meter(call.confidence, forkBar)

            return (
              <Text key={call.id} wrap="truncate-end">
                {label}
                <Text color={tint}>{full}</Text>
                <Text dimColor>{empty}</Text>
                <Text color={tint} bold={!isSharp}>
                  {` ${call.confidence.toFixed(2)} ${isSharp ? 'sharp' : 'split'}`}
                </Text>
              </Text>
            )
          })
        )}
        {routeLine ?? (
          <Text wrap="truncate-end">
            <Text color={GREEN}>sharp → runs in code</Text>
            <Text dimColor>{`   split → ${leadName}`}</Text>
          </Text>
        )}
      </Box>
    )

    const isBack = cards.length > 0 && running.length === 0 && one.isTurnActive
    const backWidth = isWide ? Math.min(RW, Math.max(LW, 38)) : W
    const backBox = (
      <Box
        width={backWidth}
        marginLeft={isWide ? Math.max(0, c2 - Math.floor(backWidth / 2)) : 0}
        justifyContent="center"
        borderStyle="round"
        borderColor={isBack ? ORANGE : undefined}
        paddingX={1}
      >
        <Text bold={isBack} color={isBack ? ORANGE : undefined} dimColor={!isBack} wrap="truncate-end">
          back to the pass · taste + verify
        </Text>
      </Box>
    )

    // ── quota and spend: what is left, and what this session used of it, turn by turn ──
    const shownTurns = sp.turns.slice(-Math.max(8, W - 4 - 10 - 52))
    const bars = sparkline(shownTurns.map(turn => turn.usd))
    const runs: { isAdvisor: boolean; text: string }[] = []
    shownTurns.forEach((turn, index) => {
      const isAdvisor = turn.advisorCalls > 0
      const last = runs.at(-1)
      if (last !== undefined && last.isAdvisor === isAdvisor) last.text += bars[index] ?? ''
      else runs.push({ isAdvisor, text: bars[index] ?? '' })
    })
    const share = advisorShare(sp.turns)

    const quotaBox = (
      <Box flexDirection="column" width={W} borderStyle="round" borderColor={PURPLE} paddingX={1}>
        <Text bold color={PURPLE}>
          quota & usage · subscription
        </Text>
        {limits.length === 0 && <Text dimColor>no reading yet (after the first reply)</Text>}
        {limits.map(limit => {
          const left = Math.max(0, Math.min(100, 100 - limit.percentUsed))
          const tint = left > 50 ? BLUE : left > 20 ? ORANGE : RED
          const [full, empty] = meter(left / 100, 12)
          const used = sp.windows[limit.kind]?.spent

          return (
            <Text key={limit.kind} wrap="truncate-end">
              <Text dimColor>{(QUOTA_LABEL[limit.kind] ?? limit.kind).padEnd(4)}</Text>
              <Text color={tint}>{full}</Text>
              <Text dimColor>{empty}</Text>
              <Text bold color={tint}>{` ${Math.round(left)}%`}</Text>
              <Text dimColor>{`  ${resetIn(limit.resetsAt, at || Date.now())}`.padEnd(14)}</Text>
              {used !== undefined && <Text>{`  this session ${points(used)}`}</Text>}
            </Text>
          )
        })}
        <Text wrap="truncate-end">
          <Text dimColor>{'per turn  '}</Text>
          {runs.length === 0 ? (
            <Text dimColor>— (after the first turn)</Text>
          ) : (
            runs.map((run, index) => (
              <Text key={`run-${index}`} color={run.isAdvisor ? PURPLE : BLUE}>
                {run.text}
              </Text>
            ))
          )}
          <Text dimColor>{`   session ≈ $${dollars(sp.usd)}`}</Text>
          {share.count > 0 && share.total > 0 ? (
            <Text color={PURPLE}>
              {` · turns with advisor: ${share.count}, ${Math.round((share.withAdvisor / share.total) * 100)}% of the cost`}
            </Text>
          ) : (
            <Text dimColor>{sp.turns.length > 0 ? ' · no advisor calls' : ''}</Text>
          )}
        </Text>
        {!isCompact && (
          <Text dimColor wrap="truncate-end">
            {'          '}purple = a turn where the advisor was consulted · cost at API prices (as in /cost)
          </Text>
        )}
      </Box>
    )

    const who = (line: LogLine): string =>
      line.kind === 'advisor'
        ? 'advisor'
        : line.kind === 'fork'
          ? 'jev'
          : line.kind === 'error'
            ? 'error'
            : line.agentId === undefined
              ? 'lead'
              : (cards.find(card => card.id === line.agentId)?.type ?? 'agent')
    const whoColor = (line: LogLine): string =>
      line.kind === 'advisor'
        ? PURPLE
        : line.kind === 'fork'
          ? GREEN
          : line.kind === 'error'
            ? RED
            : line.agentId === undefined
              ? ORANGE
              : BLUE

    const logBox = (
      <Box flexDirection="column" width={W} borderStyle="round" paddingX={1}>
        <Text dimColor>service log</Text>
        {lines.length === 0 && <Text dimColor>waiting for activity…</Text>}
        {lines.slice(isCompact ? -3 : -6).map(line => (
          <Text key={`${line.at}-${line.id ?? line.text}`} wrap="truncate-end">
            <Text dimColor>{clock(line.at)} </Text>
            <Text bold color={whoColor(line)}>
              {who(line).padEnd(9)}
            </Text>
            {line.text}
            {line.suffix === undefined ? (
              line.id === undefined ? (
                ''
              ) : (
                <Text dimColor> {spin}</Text>
              )
            ) : (
              <Text color={line.isFailed ? RED : GREEN}> {line.suffix}</Text>
            )}
          </Text>
        ))}
      </Box>
    )

    const header = (
      <Box flexDirection="column">
        <Box justifyContent="center">
          <Text bold>BRIGADE</Text>
          <Text dimColor> · </Text>
          <Text bold color={ORANGE}>
            {leadName.toUpperCase()} COOKS
          </Text>
          <Text dimColor> · </Text>
          <Text bold color={PURPLE}>
            {advisorName === '' ? 'ADVISOR' : advisorName.toUpperCase()} ON CALL
          </Text>
        </Box>
        <Text dimColor>{'─'.repeat(W)}</Text>
        <Box flexDirection="row" flexWrap="wrap" columnGap={2} justifyContent="center">
          <Text>
            <Text color={ORANGE}>■</Text> the line
          </Text>
          <Text>
            <Text color={BLUE}>■</Text> commis
          </Text>
          <Text>
            <Text color={GREEN}>■</Text> the pass
          </Text>
          <Text>
            <Text color={PURPLE}>■</Text> head chef
          </Text>
        </Box>
      </Box>
    )

    const footer = (
      <Text wrap="truncate-end">
        <Text color={BLUE}>subagents </Text>
        <Text dimColor>
          [{running.length}/{cards.length}] {running.length > 0 ? 'swarming' : 'idle'}
        </Text>
        <Text dimColor> · </Text>
        <Text color={PURPLE}>advisor </Text>
        <Text dimColor>
          [{adv.calls} call{adv.calls === 1 ? '' : 's'}] {isConsulting ? 'advising' : 'on call'}
        </Text>
        <Text dimColor> · </Text>
        <Text color={GREEN}>jev </Text>
        <Text dimColor>[{fk.count.toLocaleString('en-US')} forks]</Text>
        <Text dimColor> · </Text>
        <Text color={ORANGE}>lead </Text>
        <Text dimColor>[{one.isTurnActive ? one.phase : 'idle'}]</Text>
      </Text>
    )

    // ── the faces of the pane: l live · w 7 days · a everything kept ──
    const FACES: readonly { face: View; label: string; hotkey: string }[] = [
      { face: 'live', label: 'service', hotkey: 's' },
      { face: 'week', label: '7 days', hotkey: 'w' },
      { face: 'all', label: 'all', hotkey: 'a' },
    ]
    const tabs = (
      <Box flexDirection="row" columnGap={1}>
        {FACES.map(({ face, label, hotkey }) => (
          <Button
            key={`view-${face}`}
            label={label}
            hotkey={hotkey}
            variant={face === shown ? 'primary' : 'secondary'}
            onPress={() => update($, view, () => face)}
          />
        ))}
      </Box>
    )

    if (shown !== 'live') {
      const today = at || Date.now()
      const since = shown === 'week' ? today - 7 * DAY_MS : 0
      const sum = summarize(kept, since)
      const first = Math.min(
        ...[kept.decisions[0]?.at, kept.advisor[0]?.at, kept.agents[0]?.at].filter((x): x is number => x !== undefined),
      )
      const period =
        shown === 'week'
          ? 'last 7 days'
          : Number.isFinite(first)
            ? `since ${new Date(first).toLocaleDateString('en-GB')}`
            : 'all time'
      const share = (count: number, total: number) => (total === 0 ? 0 : Math.round((count / total) * 100))
      const seconds1 = (ms: number | undefined) => (ms === undefined ? '—' : `${(ms / 1000).toFixed(1)}s`)
      const conf = (value: number | undefined) => (value === undefined ? '—' : value.toFixed(2))
      const day = (stamp: number) =>
        shown === 'week' && today - stamp < DAY_MS ? clock(stamp).slice(0, 5) : new Date(stamp).toLocaleDateString('en-GB').slice(0, 5)
      const tierRow = (tier: Tier) => {
        const count = sum.tiers[tier] ?? 0
        const [full, empty] = meter(sum.decisions === 0 ? 0 : count / sum.decisions, 16)
        const tint = tier === 'opus' ? PURPLE : ORANGE

        return (
          <Text key={`tier-${tier}`} wrap="truncate-end">
            <Text dimColor>{`  ${shortModel(TIER_MODEL[tier]).padEnd(11)}`}</Text>
            <Text color={tint}>{full}</Text>
            <Text dimColor>{empty}</Text>
            <Text bold color={tint}>{` ${share(count, sum.decisions)}%`}</Text>
            <Text dimColor>{` (${count})`}</Text>
          </Text>
        )
      }
      const decisions = kept.decisions.filter(item => item.at >= since).slice(isCompact ? -3 : -6).reverse()
      const consults = kept.advisor.filter(item => item.at >= since).slice(-3).reverse()
      const runs = kept.agents.filter(item => item.at >= since).slice(-3).reverse()
      const labelled = Object.fromEntries(
        Object.entries(sum.checkpoints).map(([name, count]) => [CHECKPOINT_LABEL[name as Checkpoint] ?? name, count]),
      )

      return (
        <Box flexDirection="column" gap={spacer}>
          {tabs}
          <Box justifyContent="center">
            <Text bold>
              BRIGADE · history
              <Text bold={false} dimColor>{` · ${period}`}</Text>
            </Text>
          </Box>

          <Box flexDirection="column" width={W} borderStyle="round" borderColor={GREEN} paddingX={1}>
            <Text bold color={GREEN}>
              JEV · the pass · decisions
            </Text>
            <Text wrap="truncate-end">
              requests <Text bold color={GREEN}>{sum.decisions}</Text>
              <Text dimColor>{` · unsure ${share(sum.unsure, sum.decisions)}% · forced ${sum.overrides} · no answer ${sum.unanswered} · decision ≈ ${seconds1(sum.decideMs)}`}</Text>
            </Text>
            <Text dimColor>model</Text>
            {tierRow('sonnet')}
            {tierRow('opus')}
            <Text wrap="truncate-end">
              <Text dimColor>{'effort    '}</Text>
              {counts(sum.efforts, [...EFFORTS, '='])}
            </Text>
            <Text wrap="truncate-end">
              <Text dimColor>{'mode      '}</Text>
              {counts(sum.modes, ['solo', 'delegate', 'team'])}
            </Text>
            <Text wrap="truncate-end">
              <Text dimColor>{'confidence '}</Text>
              {`effort ${conf(sum.confidence.effort)} · model ${conf(sum.confidence.model)} · mode ${conf(sum.confidence.mode)}`}
            </Text>
            {decisions.length > 0 && <Text dimColor>latest:</Text>}
            {decisions.map(item => (
              <Text key={`d-${item.at}`} wrap="truncate-end">
                <Text dimColor>{`${day(item.at)}  `}</Text>
                <Text color={item.route.tier === 'opus' ? PURPLE : ORANGE}>{shortModel(TIER_MODEL[item.route.tier])}</Text>
                <Text>{` · ${item.route.effort ?? '='} · ${item.route.mode}`}</Text>
                {item.route.isUnsure && <Text color={ORANGE}> · unsure</Text>}
                {item.route.override !== undefined && <Text color={ORANGE}>{` · ${item.route.override}`}</Text>}
                <Text dimColor>{`  “${item.request}”`}</Text>
              </Text>
            ))}
          </Box>

          <Box flexDirection="column" width={W} borderStyle="round" borderColor={PURPLE} paddingX={1}>
            <Text bold color={PURPLE}>
              HEAD CHEF · advisor consults
            </Text>
            <Text wrap="truncate-end">
              consults <Text bold color={PURPLE}>{sum.consults}</Text>
              <Text dimColor>{` · average ${seconds1(sum.consultMs)}`}</Text>
            </Text>
            <Text wrap="truncate-end">
              <Text dimColor>{'when      '}</Text>
              {counts(labelled)}
            </Text>
            <Text wrap="truncate-end">
              <Text dimColor>{'status    '}</Text>
              {counts(sum.statuses)}
            </Text>
            {consults.map(item => (
              <Text key={`a-${item.id}`} wrap="truncate-end">
                <Text dimColor>{`${day(item.at)}  `}</Text>
                <Text color={PURPLE}>{CHECKPOINT_LABEL[item.checkpoint]}</Text>
                <Text dimColor>{` · ${seconds1(item.ms)} · ${item.status ?? 'received'} · ${item.where}`}</Text>
              </Text>
            ))}
          </Box>

          <Box flexDirection="column" width={W} borderStyle="round" borderColor={BLUE} paddingX={1}>
            <Text bold color={BLUE}>
              COMMIS · subagents
            </Text>
            <Text wrap="truncate-end">
              runs <Text bold color={BLUE}>{sum.runs}</Text>
              <Text dimColor>{` · average ${seconds1(sum.runMs)} · stopped ${sum.stopped}`}</Text>
            </Text>
            <Text wrap="truncate-end">
              <Text dimColor>{'types     '}</Text>
              {counts(sum.types)}
            </Text>
            <Text wrap="truncate-end">
              <Text dimColor>{'models    '}</Text>
              {counts(sum.models)}
            </Text>
            {runs.map(item => (
              <Text key={`g-${item.at}-${item.type}`} wrap="truncate-end">
                <Text dimColor>{`${day(item.at)}  `}</Text>
                <Text color={BLUE}>{item.type}</Text>
                <Text dimColor>{` · ${shortModel(item.model)} · ${seconds1(item.ms)} · `}</Text>
                <Text color={item.status === 'done' ? GREEN : RED}>{item.status === 'done' ? '✓' : '■'}</Text>
              </Text>
            ))}
          </Box>
          {sum.decisions + sum.consults + sum.runs === 0 && <Text dimColor>nothing recorded for this period</Text>}
        </Box>
      )
    }

    if (!isWide) {
      return (
        <Box flexDirection="column" gap={spacer}>
          {tabs}
          {header}
          {advisorBox}
          {leadBox}
          {forkBox}
          {subBox}
          {quotaBox}
          {logBox}
          {footer}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={spacer}>
        {tabs}
        {header}
        <Box flexDirection="row">
          <Box width={LEFT} flexDirection="column">
            {advisorBox}
          </Box>
          <Box width={LINK} flexDirection="column">
            <Text> </Text>
            <Text> </Text>
            <Text color={isConsulting ? ORANGE : undefined} dimColor={!isConsulting}>
              ┄┄┄┄▶
            </Text>
          </Box>
          <Box width={R} flexDirection="column">
            {leadBox}
            {stem('│')}
            {forkBox}
            {stem('│', isDelegating)}
            {subBox}
            {stem('▼', isDelegating)}
            {backBox}
          </Box>
        </Box>
        {quotaBox}
        {logBox}
        {footer}
      </Box>
    )
  })
}
