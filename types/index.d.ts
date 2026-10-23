/** What the lead is doing right now, as its response streams. */
export type Phase = 'idle' | 'waiting' | 'thinking' | 'writing' | 'tool-input' | 'paused' | 'tool'

export type Lead = {
  model: string
  effort: string
  steps: number
  isTurnActive: boolean
  turnStartedAt?: number
  phase: Phase
  /** Seconds spent in `phase`, published by the ticker. */
  phaseSec: number
  /** Characters of visible text streamed in the current turn. */
  outChars: number
  /** Edit-type tool calls in the current turn: none yet means the lead is still planning. */
  edits: number
  tool?: string
  toolDetail?: string
  toolStartedAt?: number
}

export type AgentCard = {
  id: string
  type: string
  description: string
  model: string
  status: 'running' | 'done' | 'stopped'
  startedAt: number
  endedAt?: number
  steps: number
  tool?: string
}

/** The moment an advisor call answers: before a plan, after a repeated error, before done, or none of them. */
export type Checkpoint = 'plan' | 'error' | 'done' | 'mid'

export type AdvisorCall = {
  id: string
  at: number
  ms?: number
  /** Estimated tokens the advisor read: the context of the step that called it. */
  contextTokens?: number
  checkpoint: Checkpoint
  where: string
  /** From the result block: plaintext, encrypted (Opus 5, Sonnet 5, Fable...) or failed. */
  status?: 'reviewed' | 'encrypted' | 'unavailable'
  /** The advice text when the API returned it in plaintext, or the error code. */
  detail?: string
}

export type AdvisorState = {
  calls: number
  tokensRead: number
  /** The advisor model from the merged settings (`--advisor`, `advisorModel`); '' when unknown. */
  model: string
  marks: Record<Checkpoint, number>
  recent: AdvisorCall[]
  /** Set while the lead's stream is paused after an engine item: a consult is probably running. */
  pendingSince?: number
  /** The last repeated failure, and whether an advisor call followed it. */
  repeat?: { at: number; text: string; consulted: boolean }
}

/** One fork: a `jev` decision. `choice` and `confidence` appear once it answered. */
export type ForkCall = {
  id: string
  description: string
  choice?: string
  confidence?: number
  isAuto?: boolean
}

export type ForkState = {
  count: number
  recent: ForkCall[]
}

/** One subscription window as the host reports it (`five_hour`, `seven_day`, ...). */
export type Quota = {
  kind: string
  percentUsed: number
  resetsAt?: string
}

export type Tier = 'sonnet' | 'opus'
export type Mode = 'solo' | 'delegate' | 'team'
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type Verdict<T extends string> = { choice: T; confidence: number }

/** What the router applied to a request, from jev's three answers. */
export type Route = {
  tier: Tier
  /** Undefined when neither jev nor an earlier request set one: the session's own stands. */
  effort?: EffortLevel
  mode: Mode
  /** jev was unsure: the lead is asked to consult the advisor before it starts. */
  advisorFirst: boolean
  isUnsure: boolean
  /** `#max`, `#fast`, `#opus` or `#sonnet`, when the request carried one. */
  override?: string
}

export type Decision = {
  at: number
  /** How long jev took for the three questions together. */
  ms: number
  effort?: Verdict<EffortLevel>
  model?: Verdict<Tier>
  mode?: Verdict<Mode>
  route: Route
}

/** The request router: the tier the session has reached (it only goes up) and the effort in force. */
export type Router = {
  tier: Tier
  effort?: EffortLevel
  last?: Decision
  /** Decided when the request was submitted, applied when its turn starts (never inside a running turn). */
  pending?: Decision
  /** When the lead last finished a turn: past an hour the cache is cold and the tier may come down. */
  lastActiveAt?: number
}

/** Which face the pane shows: the live diagram, or the history over 7 days or everything kept. */
export type View = 'live' | 'week' | 'all'

/** One routed request, kept across sessions (the request's opening words only). */
export type DecisionRecord = {
  at: number
  request: string
  effort?: Verdict<EffortLevel>
  model?: Verdict<Tier>
  mode?: Verdict<Mode>
  route: Route
  ms: number
}

/** One advisor consult, kept across sessions. */
export type AdvisorRecord = {
  id: string
  at: number
  checkpoint: Checkpoint
  ms?: number
  status?: 'reviewed' | 'encrypted' | 'unavailable'
  where: string
}

/** One subagent run, kept across sessions. */
export type AgentRecord = {
  at: number
  type: string
  model: string
  ms: number
  status: 'done' | 'stopped'
}

/** What the pane remembers from one session to the next, newest last, capped. */
export type History = {
  decisions: DecisionRecord[]
  advisor: AdvisorRecord[]
  agents: AgentRecord[]
}

/** What one lead turn cost (session cost before and after it) and whether the advisor ran in it. */
export type TurnCost = { at: number; usd: number; advisorCalls: number }

/** What this session consumed since it launched. */
export type Spend = {
  /** The session's cost as /cost totals it: API prices, a measure of weight on a subscription. */
  usd: number
  /** Points of each subscription window used since launch; `last` is the latest reading. */
  windows: Record<string, { last: number; spent: number }>
  turns: TurnCost[]
}

export type LogLine = {
  at: number
  kind: 'lead' | 'advisor' | 'agent' | 'spawn' | 'fork' | 'error'
  agentId?: string
  /** Set on a tool line, so its result is written on the same line when it ends. */
  id?: string
  text: string
  suffix?: string
  isFailed?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'brigade': {
      lead: Lead
      agents: AgentCard[]
      advisorCalls: AdvisorState
      forks: ForkState
      quota: Quota[]
      spend: Spend
      router: Router
      history: History
      view: View
      log: LogLine[]
      now: number
    }
  }
}
