import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Agent, Conversation, EngineId, Message, Settings } from '../src/shared/types'
import { Db } from '../src/core/db'
import { fakeEngine } from '../src/core/engines/fake'
import type { Engine, Turn } from '../src/core/engines/types'
import { Gateway } from '../src/core/gateway'
import { Runner } from '../src/core/runs'
import { handoffSystem } from '../src/core/router'

const ready = { installed: true, loggedIn: true }
const agent = (id: string, role: string): Agent => ({ id, name: id, handle: id, role, color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false })

let db: Db
let gateway: Gateway
let settings: Settings
let turns: Turn[]
let gates: (() => void)[] // one per running turn, oldest first
let say: Record<string, string> = {} // what an agent says next, by name

// Every agent works until it's let go, then answers.
const slow: Engine = {
  id: 'claude',
  async *run(turn) {
    // The router's look at a reply's mentions answers as the fake one does.
    if (turn.system === handoffSystem()) {
      yield* fakeEngine('claude').run(turn)
      return
    }
    turns.push(turn)
    await new Promise<void>((resolve) => {
      gates.push(resolve)
      turn.signal.addEventListener('abort', () => resolve(), { once: true })
    })
    if (turn.signal.aborted) return
    const text = say[who(turn)] ?? 'feito'
    delete say[who(turn)]
    yield { type: 'done', text, usage: { inputTokens: 1, cacheReadTokens: 0, outputTokens: 1 } }
  }
}
const releaseOldest = (): void => gates.shift()?.()
const who = (t: Turn): string => /^Você é (\w+)/.exec(t.system)?.[1] ?? '?'
const until = async (ok: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 10))
  expect(ok()).toBe(true)
}
const of = (id: string): Message[] => db.messages().filter((m) => m.author.kind === 'agent' && m.author.id === id)

beforeEach(async () => {
  db = new Db(join(mkdtempSync(join(tmpdir(), 'aq-db-')), 'test.db'))
  settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, gemini: ready, cursor: ready, grok: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'pt' }
  db.saveAgent(agent('dev', 'Engenharia'))
  db.saveAgent(agent('ana', 'Dados'))
  db.createConversation({ id: 'c', kind: 'channel', name: 'geral', members: ['dev', 'ana'] })
  turns = []
  gates = []
  gateway = new Gateway()
  await gateway.start()
})
afterEach(() => gateway.stop())

describe('an agent does one thing at a time in each place', () => {
  const run = (): { r: Runner; events: Message[] } => {
    const events: Message[] = []
    const engines: Record<EngineId, Engine> = { claude: slow, codex: fakeEngine('codex'), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), gemini: fakeEngine('gemini'), cursor: fakeEngine('cursor'), grok: fakeEngine('grok') }
    const r = new Runner({ db, engines, settings: async () => settings, emit: (e) => e.type === 'message' && events.push(e.message), workDir: mkdtempSync(join(tmpdir(), 'aq-w-')), gateway })
    return { r, events }
  }
  // A turn for an agent already replying there, as a team's work asks for it: it waits its turn.
  const startAnother = (r: Runner, conv: string): void => {
    const runner = r as unknown as { start(agent: Agent, conv: Conversation, opts: { depth: number; task?: string }): void }
    runner.start(db.agent('dev')!, db.conversation(conv)!, { depth: 2, task: 'olha o build' })
  }
  const waitingReply = (): Message | undefined => of('dev').find((m) => m.run?.steps[0]?.label === 'Na fila')
  const finish = async (r: Runner): Promise<void> => {
    let done = false
    void r.idle().then(() => (done = true))
    for (let i = 0; i < 400 && !done; i++) {
      releaseOldest()
      await new Promise((go) => setTimeout(go, 5))
    }
    expect(done).toBe(true)
  }

  it('my next message waits for the agent replying there, and others work meanwhile', async () => {
    const { r } = run()
    await r.send('c', '@dev revisa o PR 12')
    await until(() => turns.length === 1)
    await r.send('c', '@dev depois olha o build')
    await r.send('c', '@ana quantos pedidos ontem?')
    await until(() => turns.length === 2)
    expect(turns.map(who)).toEqual(['dev', 'ana'])
    releaseOldest() // dev's first is done: the one follow-up reads what waited
    await until(() => turns.length === 3)
    expect(who(turns[2]!)).toBe('dev')
    expect(turns[2]!.prompt).toContain('olha o build')
    await finish(r)
    expect(of('dev').map((m) => m.run?.status)).toEqual(['done', 'done'])
  })

  it('in another thread or conversation the same agent works at once', async () => {
    db.createConversation({ id: 'd', kind: 'dm', name: 'dev', members: ['dev'] })
    const { r } = run()
    await r.send('c', '@dev revisa o PR 12')
    await until(() => turns.length === 1)
    db.saveMessage({ id: 'old', conversationId: 'c', author: { kind: 'me' }, text: 'o build de ontem', at: 1 })
    await r.send('c', '@dev depois olha o build', [], 'old')
    await r.send('d', 'e os testes?')
    await until(() => turns.length === 3)
    expect(waitingReply()).toBeUndefined()
    await finish(r)
  })

  it('an agent calling one already replying there: no second reply beside it, one more right after', async () => {
    const { r } = run()
    await r.send('c', '@dev revisa o PR 12')
    await until(() => turns.length === 1)
    say['ana'] = '@dev pode olhar o build também?'
    await r.send('c', '@ana olha os números')
    await until(() => turns.length === 2)
    gates.splice(1, 1)[0]!() // Ana answers and calls Dev, who is replying
    await until(() => of('ana')[0]?.run?.status === 'done' && !!of('ana')[0]?.run?.steps.some((s) => s.label === 'Chamou'))
    expect(turns).toHaveLength(2)
    expect(waitingReply()).toBeUndefined()
    const called = of('ana')[0]!
    releaseOldest() // Dev is done: it answers once, after what came meanwhile
    await until(() => turns.length === 3)
    expect(who(turns[2]!)).toBe('dev')
    await finish(r)
    expect(of('dev')).toHaveLength(2)
    expect(of('dev')[1]!.at).toBeGreaterThan(called.at)
  })

  it('a reply that has to wait stays over the field, and goes in when it starts, after what came meanwhile', async () => {
    const { r, events } = run()
    await r.send('c', '@dev revisa o PR 12')
    await until(() => turns.length === 1)
    startAnother(r, 'c')
    const waiting = waitingReply()!
    expect(events.findLast((m) => m.id === waiting.id)?.queued).toBe('dev')
    expect(turns).toHaveLength(1)
    await r.send('c', '@ana quantos pedidos ontem?')
    await until(() => turns.length === 2)
    const meanwhile = db.messages().findLast((m) => m.text === '@ana quantos pedidos ontem?')!
    releaseOldest()
    await until(() => turns.filter((x) => who(x) === 'dev').length === 2)
    const started = events.findLast((m) => m.id === waiting.id)!
    expect(started.queued).toBeUndefined()
    expect(started.at).toBeGreaterThan(meanwhile.at)
    expect(db.message(waiting.id)!.at).toBe(started.at)
    await finish(r)
    expect(of('dev').map((m) => m.run?.status)).toEqual(['done', 'done'])
  })

  it('cancelled while it waits: it never runs, and shows in the conversation as cancelled', async () => {
    const { r, events } = run()
    await r.send('c', '@dev revisa o PR 12')
    await until(() => turns.length === 1)
    startAnother(r, 'c')
    const waiting = waitingReply()!
    r.stop(waiting.id)
    const last = events.findLast((m) => m.id === waiting.id)!
    expect(last.queued).toBeUndefined()
    expect(last.run?.status).toBe('stopped')
    expect(db.message(waiting.id)!.run).toMatchObject({ status: 'stopped', steps: [{ label: 'Cancelado' }] })
    await finish(r)
    expect(turns).toHaveLength(1)
  })

  it('reading everything again (a window reload) keeps what waits out of the conversation', async () => {
    db.createConversation({ id: 'd', kind: 'dm', name: 'dev', members: ['dev'] })
    const { r } = run()
    await r.send('d', 'teste')
    await until(() => turns.length === 1)
    await r.send('d', 'teste 2')
    startAnother(r, 'd')
    const seen = r.withQueue(db.messages())
    expect(seen.find((m) => m.text === 'teste 2')?.queued).toBe('dev')
    expect(seen.find((m) => m.text === 'teste')?.queued).toBeUndefined()
    expect(seen.find((m) => m.run?.steps[0]?.label === 'Na fila')?.queued).toBe('dev')
    await finish(r)
    expect(r.withQueue(db.messages()).some((m) => m.queued)).toBe(false)
  })
})
