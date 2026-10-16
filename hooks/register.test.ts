import { expect, mock, test } from 'claude-code/testing'

import {
  advisorShare,
  advisorStatus,
  classify,
  failKey,
  hintFor,
  parseOverride,
  parseVerdict,
  DEFAULT_CONFIG,
  readConfig,
  route,
  shortModel,
  sparkline,
  summarize,
  trackWindows,
} from './register'

const ZERO = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

/** A model.complete beneath the plugin that answers each of jev's questions as given. */
const jevAnswers = (answers: { effort: string; model: string; mode: string }) => (_$: unknown, e: { prompt: string }) => ({
  value: {
    isAnswered: true as const,
    text: e.prompt.includes('reasoning effort')
      ? answers.effort
      : e.prompt.includes('Which model')
        ? answers.model
        : e.prompt.includes('organised')
          ? answers.mode
          : '{"choice":"retry","confidence":0.5}',
    usage: ZERO,
  },
})

const paneAt = (bodyColumns: number) =>
  ({
    plugin: 'brigade',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'brigade',
    props: {
      title: 'Claude live',
      isFocused: false,
      bodyColumns,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 40 },
      view: {},
    },
  }) as const

const PANE = paneAt(120)

const NOON = Date.UTC(2026, 9, 14, 12, 0, 0)

const USAGE = {
  input_tokens: 1_000,
  output_tokens: 50,
  cache_read_input_tokens: 40_000,
  cache_creation_input_tokens: 0,
  model: 'claude-sonnet-5-5',
}

test('the pane starts quiet: no advisor call, no subagent', async $ => {
  const ui = await $.ui.mount(PANE)

  expect(await ui.find({ type: 'Text', text: /silent so far/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /commis · delegated work/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /idle · 0 runs/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^scanner/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^editor/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /◇ before a plan/ })).toBeDefined()
  await ui.unmount()
})

test('a lead tool call lands in the session log with its result and is passed through untouched', async ($, on) => {
  mock.clock(on, { now: NOON })
  on('tool.call', () => ({ result: 'ok' }))

  const ran = await $.tool.call({ tool: 'Bash', command: 'echo hi' })
  const ui = await $.ui.mount(PANE)

  expect(ran).toEqual({ result: 'ok' })
  expect(await ui.find({ type: 'Text', text: /lead\s+Bash echo hi ✓ 0s/ })).toBeDefined()
  await ui.unmount()
})

test('an advisor call seen in a turn step is counted with its real duration and checkpoint', async ($, on) => {
  mock.clock(on, { now: NOON })
  on('turn.step', async function* (_$, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      serverToolUses: [{ id: 's1', name: 'advisor', input: {}, startedAt: NOON, endedAt: NOON + 12_000 }],
      stopReason: 'end_turn',
      usage: USAGE,
    }
  })

  for await (const _chunk of $.turn.step({
    turnId: 't1',
    index: 0,
    model: 'claude-sonnet-5-5',
    effort: 'high',
    messageCount: 4,
  })) {
    // the stream is only drained; the plugin observes the result
  }
  const ui = await $.ui.mount(PANE)

  expect(await ui.find({ type: 'Text', text: /calls 1/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /◆ before done · 12s/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /tokens read ≈ 21k/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /sonnet 5\.5 · the line/i })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /» received/ })).toBeDefined()
  await ui.unmount()
})

test('an advisor call before any edit lights "before a plan" and the text streamed is counted', async ($, on) => {
  mock.clock(on, { now: NOON })
  on('turn.step', async function* (_$, e) {
    yield { kind: 'text', index: 0, text: 'Let me plan.' }
    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'Let me plan.',
      toolUses: [],
      serverToolUses: [{ id: 'srv1', name: 'advisor', input: {}, startedAt: NOON, endedAt: NOON + 3_000 }],
      stopReason: 'tool_use',
      usage: USAGE,
    }
  })

  for await (const _chunk of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 4 })) {
    // drained
  }
  const ui = await $.ui.mount(PANE)

  expect(await ui.find({ type: 'Text', text: /◆ before a plan/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /advisor\s+◆ before a plan · 3s/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /12 chars/ })).toBeDefined()
  await ui.unmount()
})

test('the same failure twice lights "same error x2" until the advisor is consulted', async ($, on) => {
  mock.clock(on, { now: NOON })
  on('tool.call', () => ({ result: 'boom', isError: true, text: 'npm ERR! missing script: test' }))
  on('model.complete', () => ({
    value: {
      isAnswered: false,
      reason: 'empty-reply',
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  }))

  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  const once = await $.ui.mount(PANE)
  expect(await once.find({ type: 'Text', text: /⚠ Bash npm test/ })).toBeUndefined()
  await once.unmount()

  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  const twice = await $.ui.mount(PANE)
  expect(await twice.find({ type: 'Text', text: /⚠ Bash npm test/ })).toBeDefined()
  expect(await twice.find({ type: 'Text', text: /error\s+same error x2 · Bash npm test/ })).toBeDefined()
  expect(await twice.find({ type: 'Text', text: /Bash npm test ✗ 0s/ })).toBeDefined()
  await twice.unmount()
})

test('a subagent shows as running, then done when its turn completes', async ($, on) => {
  mock.clock(on, { now: NOON })
  on('agent.spawn', () => ({ model: 'claude-haiku-4-5-20251001', agentId: 'a1' }))
  on('turn.complete', () => ({ text: 'done' }))

  await $.agent.spawn({
    tool_use_id: 'u1',
    prompt: 'map the repo',
    description: 'map repo',
    subagentType: 'scanner',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-sonnet-5-5',
    background: false,
    fork: false,
  })
  const running = await $.ui.mount(PANE)
  expect(await running.find({ type: 'Text', text: /running 0s/ })).toBeDefined()
  expect(await running.find({ type: 'Text', text: /subagents \[1\/1\] swarming/ })).toBeDefined()
  expect(await running.find({ type: 'Text', text: /commis · delegated work/ })).toBeDefined()
  expect(await running.find({ type: 'Text', text: /1 running/ })).toBeDefined()
  expect(await running.find({ type: 'Text', text: /haiku 4\.5/ })).toBeDefined()
  await running.unmount()

  await $.turn.complete({
    turnId: 't2',
    agentId: 'a1',
    reason: 'answer',
    answer: 'done',
    durationMs: 4_000,
    isAborted: false,
  })
  const done = await $.ui.mount(PANE)
  expect(await done.find({ type: 'Text', text: /^done \d+s$/ })).toBeDefined()
  expect(await done.find({ type: 'Text', text: /subagents \[0\/1\] idle/ })).toBeDefined()
  await done.unmount()
})

test('a running subagent keeps counting while an unrelated agent ends', async ($, on) => {
  const clock = mock.clock(on, { now: NOON })
  on('agent.spawn', () => ({ model: 'claude-haiku-4-5-20251001', agentId: 'a1' }))
  on('turn.complete', () => ({ text: 'done' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'brigade' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  await $.agent.spawn({
    tool_use_id: 'u1',
    prompt: 'map the repo',
    description: 'map repo',
    subagentType: 'search',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-sonnet-5-5',
    background: false,
    fork: false,
  })
  await $.turn.complete({ turnId: 't9', agentId: 'compaction-fork', reason: 'answer', answer: '', durationMs: 1, isAborted: false })
  await clock.advance(5_000)

  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /running 5s/ })).toBeDefined()
  await ui.unmount()
})

test('a narrow pane drops the connectors and stacks the blocks', async $ => {
  const hasLink = async (bodyColumns: number) => {
    const ui = await $.ui.mount(paneAt(bodyColumns))
    const link = await ui.find({ type: 'Text', text: /┄┄┄┄▶/ })
    await ui.unmount()

    return link !== undefined
  }

  expect(await hasLink(120)).toBe(true)
  expect(await hasLink(50)).toBe(false)
})

test('parallel subagents each get a line, the running ones first, and the box lights up', async ($, on) => {
  mock.clock(on, { now: NOON })
  let id = 0
  on('agent.spawn', (_$, e) => ({ model: e.model ?? 'claude-haiku-4-5-20251001', agentId: `p${(id += 1)}` }))
  const spawn = (subagentType: string, description: string) =>
    $.agent.spawn({
      tool_use_id: `u-${description}`,
      prompt: description,
      description,
      subagentType,
      provider: { plugin: 'engine', tier: 'core' },
      parentModel: 'claude-sonnet-5-5',
      background: false,
      fork: false,
    })

  await spawn('scanner', 'map auth')
  await spawn('scanner', 'map billing')
  await spawn('editor', 'edit auth')
  await spawn('general-purpose', 'check docs')

  for (const bodyColumns of [90, 120, 143]) {
    const ui = await $.ui.mount(paneAt(bodyColumns))
    expect(await ui.find({ type: 'Text', text: /4 running/ })).toBeDefined()
    // the two slots plus the two other runs, one line each
    expect(await ui.findAll({ type: 'Text', text: /^running 0s$/ })).toHaveLength(4)
    // what each one does is shown when the pane is wide enough to hold it
    const hasDescriptions = (await ui.find({ type: 'Text', text: /^map auth/ })) !== undefined
    expect(hasDescriptions).toBe(bodyColumns >= 120)
    if (hasDescriptions) expect(await ui.find({ type: 'Text', text: /^check docs/ })).toBeDefined()
    await ui.unmount()
  }
})

test('a short pane drops the spacers and the advisor captions so the diagram is not clipped', async $ => {
  const captionAt = async (bodyRows: number) => {
    const target = paneAt(120)
    const ui = await $.ui.mount({ ...target, props: { ...target.props, scroll: { offset: 0, bodyRows } } })
    const caption = await ui.find({ type: 'Text', text: /reads the whole/ })
    await ui.unmount()

    return caption !== undefined
  }

  expect(await captionAt(60)).toBe(true)
  expect(await captionAt(30)).toBe(false)
})

test('a jev fork shows a confidence bar once it answers, and never draws a subagent card', async ($, on) => {
  mock.clock(on, { now: NOON })
  on('agent.spawn', () => ({ model: 'claude-haiku-4-5-20251001', agentId: 'j1' }))
  on('turn.complete', () => ({ text: 'done' }))
  on('store.set', () => ({ value: undefined }))

  await $.agent.spawn({
    tool_use_id: 'u2',
    prompt: 'retry or stop?',
    description: 'retry or stop',
    subagentType: 'jev',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: false,
    fork: false,
  })
  const asking = await $.ui.mount(PANE)
  expect(await asking.find({ type: 'Text', text: /asking jev/ })).toBeDefined()
  expect(await asking.find({ type: 'Text', text: /subagents \[0\/0\]/ })).toBeDefined()
  await asking.unmount()

  await $.turn.complete({
    turnId: 't3',
    agentId: 'j1',
    reason: 'answer',
    answer: '{"choice": "stop", "confidence": 0.7}',
    durationMs: 1_300,
    isAborted: false,
  })
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /retry or stop → stop +█+░* 0\.70 sharp/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /jev\s+retry or stop → stop p=0\.70 sharp/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /forks 1/ })).toBeDefined()
  await ui.unmount()
})

test('each lead turn adds a bar of what it cost, purple when the advisor ran in it', async ($, on) => {
  mock.clock(on, { now: NOON })
  let usd = 1
  let percentUsed = 30
  on('session.usage', () => ({
    value: {
      startedAt: NOON,
      context: { window: 200_000 },
      rateLimits: [{ kind: 'five_hour', percentUsed }],
      cost: { usd },
    },
  }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: 'done' }))
  let withAdvisor = true
  on('turn.step', async function* (_$, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      serverToolUses: withAdvisor
        ? [{ id: `s-${e.turnId}`, name: 'advisor', input: {}, startedAt: NOON, endedAt: NOON + 2_000 }]
        : undefined,
      stopReason: 'end_turn',
      usage: USAGE,
    }
  })
  const turn = async (turnId: string, cost: number, percent: number) => {
    await $.turn.start({ text: 'go', turnId })
    for await (const _chunk of $.turn.step({ turnId, index: 0, model: 'claude-sonnet-5-5', messageCount: 2 })) {
      // drained
    }
    usd = cost
    percentUsed = percent
    await $.turn.complete({ turnId, reason: 'answer', answer: 'ok', durationMs: 1_000, isAborted: false })
  }

  await turn('t1', 1.5, 33)
  withAdvisor = false
  await turn('t2', 2, 34)
  const ui = await $.ui.mount(PANE)

  expect(await ui.find({ type: 'Text', text: /per turn +█+ +session ≈ \$2\.00/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /turns with advisor: 1, 50% of the cost/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /5h .*66%.*this session 4 pts/ })).toBeDefined()
  await ui.unmount()
})

test('a request jev finds hard runs on opus at xhigh, and the lead is told to coordinate a team', async ($, on) => {
  mock.clock(on, { now: NOON })
  on('model.complete', jevAnswers({
    effort: '{"choice":"xhigh","confidence":0.8}',
    model: '{"choice":"opus","confidence":0.4}',
    mode: '{"choice":"team","confidence":0.75}',
  }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  const contexts: string[] = []
  on('prompt.submit', (_$, e) => {
    contexts.push(...(e.context ?? []))
    return { text: e.text, context: e.context }
  })
  on('store.set', () => ({ value: undefined }))
  const sent: { model: string; effort?: unknown }[] = []
  on('turn.step', async function* (_$, e) {
    sent.push({ model: e.model, effort: e.effort })
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: USAGE }
  })

  await $.prompt.submit({ text: 'Redesign the billing module across our three services', wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: 'Redesign the billing module across our three services', turnId: 't1' })
  for await (const _chunk of $.turn.step({ turnId: 't1', index: 0, model: 'claude-sonnet-5-5', effort: 'high', messageCount: 2 })) {
    // drained
  }

  expect(sent).toEqual([{ model: 'claude-opus-5-5', effort: 'xhigh' }])
  expect(contexts.join(' ')).toMatch(/\[request router\].*Act as the architect/)
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /→ OPUS 5\.5 · effort xhigh · team/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /model → opus +█+░* 0\.40 split/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /jev\s+route → opus 5\.5 · xhigh · team/ })).toBeDefined()
  await ui.unmount()
})

test('an unsure jev keeps the model, raises the effort a step and asks for the advisor; a continuation keeps the decision', async ($, on) => {
  mock.clock(on, { now: NOON })
  on('model.complete', jevAnswers({
    effort: '{"choice":"medium","confidence":0.45}',
    model: '{"choice":"sonnet","confidence":0.5}',
    mode: '{"choice":"solo","confidence":0.9}',
  }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  const contexts: string[] = []
  on('prompt.submit', (_$, e) => {
    contexts.push(...(e.context ?? []))
    return { text: e.text, context: e.context }
  })
  on('store.set', () => ({ value: undefined }))
  const sent: { model: string; effort?: unknown }[] = []
  on('turn.step', async function* (_$, e) {
    sent.push({ model: e.model, effort: e.effort })
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: USAGE }
  })
  const step = async (turnId: string) => {
    for await (const _chunk of $.turn.step({ turnId, index: 0, model: 'claude-sonnet-5-5', effort: 'high', messageCount: 2 })) {
      // drained
    }
  }

  await $.prompt.submit({ text: 'why does the cache miss sometimes?', wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: 'why does the cache miss sometimes?', turnId: 't1' })
  await step('t1')
  await $.turn.start({ text: '', turnId: 't2' })
  await step('t2')

  expect(sent).toEqual([
    { model: 'claude-sonnet-5-5', effort: 'high' },
    { model: 'claude-sonnet-5-5', effort: 'high' },
  ])
  expect(contexts).toHaveLength(1)
  expect(contexts[0]).toMatch(/consult the advisor/)
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /→ SONNET 5\.5 · effort high · solo · advisor first · unsure/ })).toBeDefined()
  await ui.unmount()
})

test('without an answer from jev nothing changes', async ($, on) => {
  mock.clock(on, { now: NOON })
  on('model.complete', () => ({ value: { isAnswered: false as const, reason: 'empty-reply' as const, usage: ZERO } }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  const contexts: string[] = []
  on('prompt.submit', (_$, e) => {
    contexts.push(...(e.context ?? []))
    return { text: e.text, context: e.context }
  })
  const sent: { model: string; effort?: unknown }[] = []
  on('turn.step', async function* (_$, e) {
    sent.push({ model: e.model, effort: e.effort })
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: USAGE }
  })

  await $.prompt.submit({ text: 'rename this variable', wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: 'rename this variable', turnId: 't1' })
  for await (const _chunk of $.turn.step({ turnId: 't1', index: 0, model: 'claude-sonnet-5-5', effort: 'high', messageCount: 2 })) {
    // drained
  }

  expect(sent).toEqual([{ model: 'claude-sonnet-5-5', effort: 'high' }])
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /route · no answer from jev · nothing changed/ })).toBeDefined()
  await ui.unmount()
})

test('a routed request lands in the history, shown by the 7-day face', async ($, on) => {
  mock.clock(on, { now: NOON })
  on('model.complete', jevAnswers({
    effort: '{"choice":"high","confidence":0.8}',
    model: '{"choice":"sonnet","confidence":0.9}',
    mode: '{"choice":"delegate","confidence":0.7}',
  }))
  on('prompt.submit', (_$, e) => ({ text: e.text, context: e.context }))
  on('store.set', () => ({ value: undefined }))

  await $.prompt.submit({ text: 'find every caller of parseConfig', wait: false, origin: { kind: 'composer' } })
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'view-week' })

  expect(await ui.find({ type: 'Text', text: /BRIGADE · history · last 7 days/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /requests 1 · unsure 0%/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /sonnet 5\.5 · high · delegate +“find every caller of parseConfig”/ })).toBeDefined()
  await ui.press({ key: 'view-live' })
  expect(await ui.find({ type: 'Text', text: /^BRIGADE$/ })).toBeDefined()
  await ui.unmount()
})

test('the history summary', () => {
  const route = { tier: 'opus' as const, effort: 'xhigh' as const, mode: 'team' as const, advisorFirst: true, isUnsure: true }
  const summary = summarize(
    {
      decisions: [
        { at: 1, request: 'old', route: { ...route, isUnsure: false }, ms: 900 },
        { at: 10, request: 'new', model: { choice: 'opus', confidence: 0.4 }, route, ms: 1100 },
      ],
      advisor: [{ id: 's', at: 11, checkpoint: 'plan', ms: 3000, status: 'encrypted', where: 'lead' }],
      agents: [{ at: 12, type: 'scanner', model: 'claude-haiku-4-5-20251001', ms: 40_000, status: 'done' }],
    },
    5,
  )

  expect(summary).toMatchObject({
    decisions: 1,
    tiers: { opus: 1 },
    unsure: 1,
    unanswered: 0,
    confidence: { model: 0.4 },
    decideMs: 1100,
    consults: 1,
    checkpoints: { plan: 1 },
    statuses: { encrypted: 1 },
    runs: 1,
    models: { 'haiku 4.5': 1 },
    runMs: 40_000,
  })
})

test('with routing off the pane only observes: jev is never asked and the model stays', { options: { routing: 'off' } }, async ($, on) => {
  mock.clock(on, { now: NOON })
  let asked = 0
  on('model.complete', () => {
    asked += 1
    return { value: { isAnswered: false as const, reason: 'empty-reply' as const, usage: ZERO } }
  })
  on('prompt.submit', (_$, e) => ({ text: e.text, context: e.context }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  const sent: { model: string; effort?: unknown }[] = []
  on('turn.step', async function* (_$, e) {
    sent.push({ model: e.model, effort: e.effort })
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: USAGE }
  })

  await $.prompt.submit({ text: 'Redesign the billing module across our three services', wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: 'Redesign the billing module across our three services', turnId: 't1' })
  for await (const _chunk of $.turn.step({ turnId: 't1', index: 0, model: 'claude-sonnet-5-5', effort: 'high', messageCount: 2 })) {
    // drained
  }

  expect(asked).toBe(0)
  expect(sent).toEqual([{ model: 'claude-sonnet-5-5', effort: 'high' }])
})

test('jev runs on the configured model with the built-in prompt', { options: { jevModel: 'claude-haiku-4-5' } }, async ($, on) => {
  mock.clock(on, { now: NOON })
  const seen: { model: string; system?: string }[] = []
  on('model.complete', (_$, e) => {
    seen.push({ model: e.model, system: e.system })
    return { value: { isAnswered: false as const, reason: 'empty-reply' as const, usage: ZERO } }
  })
  on('prompt.submit', (_$, e) => ({ text: e.text, context: e.context }))

  await $.prompt.submit({ text: 'rename this variable', wait: false, origin: { kind: 'composer' } })

  expect(seen).toHaveLength(3)
  expect(seen.every(one => one.model === 'claude-haiku-4-5')).toBe(true)
  expect(seen.every(one => one.system?.includes('fast decision model'))).toBe(true)
})

test('the routing rule', () => {
  const sure = { choice: 'sonnet' as const, confidence: 0.9 }
  // confident and routine: as jev said, nothing more
  expect(route({ effort: { choice: 'high', confidence: 0.8 }, model: sure, mode: { choice: 'solo', confidence: 0.9 }, tier: 'sonnet' })).toEqual({
    tier: 'sonnet',
    effort: 'high',
    mode: 'solo',
    advisorFirst: false,
    isUnsure: false,
    override: undefined,
  })
  // going up takes little certainty
  expect(route({ model: { choice: 'opus', confidence: 0.35 }, tier: 'sonnet' }).tier).toBe('opus')
  // opus too faintly: unsure, the model stays
  expect(route({ model: { choice: 'opus', confidence: 0.2 }, effort: { choice: 'high', confidence: 0.9 }, tier: 'sonnet' })).toMatchObject({
    tier: 'sonnet',
    effort: 'xhigh',
    advisorFirst: true,
  })
  // the tier never comes down within a session
  expect(route({ model: sure, tier: 'opus' }).tier).toBe('opus')
  // the effort is capped at max
  expect(route({ effort: { choice: 'max', confidence: 0.3 }, tier: 'sonnet' }).effort).toBe('max')
  // a team takes a confident call; a weaker one only delegates
  expect(route({ mode: { choice: 'team', confidence: 0.8 }, tier: 'sonnet' }).mode).toBe('team')
  expect(route({ mode: { choice: 'team', confidence: 0.6 }, tier: 'sonnet' }).mode).toBe('delegate')
  expect(route({ mode: { choice: 'delegate', confidence: 0.4 }, tier: 'sonnet' }).mode).toBe('solo')
  // nothing answered: the session's own settings stand
  expect(route({ tier: 'sonnet', effortNow: 'medium' })).toMatchObject({ tier: 'sonnet', effort: 'medium', mode: 'solo', isUnsure: false })
  // the person's word wins
  expect(route({ model: sure, tier: 'sonnet', override: '#max' })).toMatchObject({ tier: 'opus', effort: 'max' })
  expect(route({ model: { choice: 'opus', confidence: 0.9 }, tier: 'opus', override: '#fast' })).toMatchObject({ tier: 'sonnet', effort: 'low' })
  expect(route({ model: { choice: 'opus', confidence: 0.9 }, tier: 'opus', override: '#sonnet' }).tier).toBe('sonnet')

  expect(parseOverride('#max fix the flaky test')).toBe('#max')
  expect(parseOverride('fix the flaky test #FAST')).toBe('#fast')
  expect(parseOverride('use #max here')).toBeUndefined()

  expect(hintFor({ tier: 'sonnet', mode: 'solo', advisorFirst: false, isUnsure: false })).toBeUndefined()
  expect(hintFor({ tier: 'sonnet', mode: 'delegate', advisorFirst: true, isUnsure: true })).toMatch(
    /consult the advisor.*subagent/,
  )
})

test('the pure helpers', () => {
  expect(trackWindows({}, [{ kind: 'five_hour', percentUsed: 30 }])).toEqual({ five_hour: { last: 30, spent: 0 } })
  expect(trackWindows({ five_hour: { last: 30, spent: 2 } }, [{ kind: 'five_hour', percentUsed: 35 }])).toEqual({
    five_hour: { last: 35, spent: 7 },
  })
  // the window reset: everything in the new reading is new use
  expect(trackWindows({ five_hour: { last: 90, spent: 10 } }, [{ kind: 'five_hour', percentUsed: 4 }])).toEqual({
    five_hour: { last: 4, spent: 14 },
  })
  expect(sparkline([0, 1, 2, 4])).toEqual(['▁', '▃', '▅', '█'])
  expect(sparkline([0, 0])).toEqual(['▁', '▁'])
  expect(
    advisorShare([
      { at: 1, usd: 0.5, advisorCalls: 2 },
      { at: 2, usd: 1.5, advisorCalls: 0 },
    ]),
  ).toEqual({ total: 2, withAdvisor: 0.5, count: 1 })
  expect(shortModel('claude-opus-5-5')).toBe('opus 5.5')
  expect(shortModel('opus')).toBe('opus')
  expect(parseVerdict('x {"choice":"retry","confidence":1.4} y')).toEqual({ choice: 'retry', confidence: 1 })
  expect(parseVerdict('nothing')).toBeUndefined()
  expect(readConfig({})).toEqual(DEFAULT_CONFIG)
  expect(readConfig({ jevModel: ' claude-haiku-4-5 ', routing: 'off', panel: 'command', retryConsult: false })).toEqual({
    jevModel: 'claude-haiku-4-5',
    routing: 'off',
    panel: 'command',
    retryConsult: false,
  })
  expect(readConfig({ jevModel: '  ', routing: 'sideways' }).jevModel).toBe('haiku')
  expect(classify({ isRepeatOpen: true, stopReason: 'end_turn', edits: 0 })).toBe('error')
  expect(classify({ isRepeatOpen: false, stopReason: 'end_turn', edits: 0 })).toBe('done')
  expect(classify({ isRepeatOpen: false, stopReason: 'tool_use', edits: 0 })).toBe('plan')
  expect(classify({ isRepeatOpen: false, stopReason: 'tool_use', edits: 2 })).toBe('mid')
  expect(failKey('Bash', 'npm test', 'whatever')).toBe('Bash:npm test')
  expect(
    advisorStatus({
      type: 'advisor_tool_result',
      tool_use_id: 's',
      content: { type: 'advisor_result', text: 'Use a channel.' },
    }),
  ).toEqual({ id: 's', status: 'reviewed', detail: 'Use a channel.' })
  expect(
    advisorStatus({
      type: 'advisor_tool_result',
      tool_use_id: 's',
      content: { type: 'advisor_tool_result_error', error_code: 'overloaded' },
    }),
  ).toEqual({ id: 's', status: 'unavailable', detail: 'overloaded' })
  expect(advisorStatus({ type: 'text', text: 'hi' })).toBeUndefined()
})
