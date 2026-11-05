/** Recorded main conversation translated through the keyless ChatJimmy route from the real Web GUI. */
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pluginRecordOf } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session/types'
import { chromium, type Browser } from 'playwright'
import { expect, it, onTestFailed, onTestFinished } from 'vitest'
import {
  acknowledgeReloadConnectionLoss, assertFixtureInventory, captureStableAria, compareOrRefreshGolden, fixtureUserPrompts,
  launchWebScaffold, readPersistedEvents, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import {
  connectFreshWorkspaceZh, expandOwningTurnProcess, PLUGIN_TOGGLE_SETTLE_MS, saveFailureShot, ZH_BROWSER_LOCALE,
} from './support.ts'

const BUNDLE_NAME = '@deepseek-ai/dsh-experimental-cot-translation-bundle'
const BUNDLE = fileURLToPath(new URL('../../../packages/experimental/cot-translation-bundle', import.meta.url))
const { version: bundleVersion } = JSON.parse(await readFile(join(BUNDLE, 'package.json'), 'utf8')) as { version: string }
const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/lifecycle-chrome/session.v4.jsonl', import.meta.url))
const EXPECTED = fileURLToPath(new URL('./expected/cot-translation-chatjimmy', import.meta.url))
const MODE = webSnapshotMode()
const ORIGINAL = 'The user wants me to reply with a single word. Let me comply.'
const TRANSLATED = '小模型译文：用户要求只回复一个词。'
const KEYLESS = 'Bing、Google、DeepLX 和 ChatJimmy 都无需额外登录或 API key'

/** Common translation records are the only additions to the recorded conversation. */
function isTranslationRecord(event: SessionEvent): boolean {
  const type = pluginRecordOf(event)?.type
  return type === 'plugin:translator/request' || type === 'plugin:translator/result'
}

async function requestBody(request: IncomingMessage): Promise<string> {
  const bytes: Buffer[] = []
  for await (const chunk of request) {
    if (!(chunk instanceof Buffer)) throw new Error('Expected native chat request bytes')
    bytes.push(chunk)
  }
  return Buffer.concat(bytes).toString('utf8')
}

/** The upstream answers with the translation as plain text and appends its telemetry trailer. */
function reply(response: ServerResponse, text: string): void {
  response.writeHead(200, { 'content-type': 'text/plain' })
  response.end(`${text}<|stats|>{"created_at":1,"done":true,"done_reason":"stop","status":0,"decode_tokens":12}<|/stats|>`)
}

interface ChatCall { body: Record<string, unknown>; cookie: string | undefined; bearer: string | undefined }

it.skipIf(MODE === 'record')('translates one reasoning fragment through the ChatJimmy route and reuses it across reopen and reload', async () => {
  const resources: { scaffold?: WebScaffold; browser?: Browser; sessionId?: SessionId } = {}
  const calls: ChatCall[] = [], fixtureErrors: unknown[] = [], pendingRequests: Promise<void>[] = []
  async function respond(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = new URL(request.url ?? '/', 'http://chatjimmy.test').pathname
    if (path !== '/chat') throw new Error(`Unexpected external translation request: ${path}`)
    const submitted: unknown = JSON.parse(await requestBody(request))
    if (typeof submitted !== 'object' || submitted === null || Array.isArray(submitted)) throw new Error('Expected a chat request object')
    calls.push({ body: submitted as Record<string, unknown>, cookie: request.headers.cookie, bearer: request.headers.authorization })
    reply(response, TRANSLATED)
  }
  const server = createServer((request, response) => {
    pendingRequests.push(respond(request, response).catch((error: unknown) => { fixtureErrors.push(error); response.destroy() }))
  })
  onTestFinished(async () => {
    const failures: unknown[] = []
    await resources.browser?.close().catch((error: unknown) => failures.push(error))
    await resources.scaffold?.close().catch((error: unknown) => failures.push(error))
    const closed = new Promise<void>((resolve, reject) => server.close((error) => { if (error) reject(error); else resolve() }))
    server.closeAllConnections()
    await closed.catch((error: unknown) => failures.push(error))
    await Promise.all(pendingRequests)
    if (failures.length > 0) throw new AggregateError(failures, 'ChatJimmy translation browser teardown failed')
  })
  const canonical = await readFile(FIXTURE, 'utf8')
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Expected an allocated loopback chat listener')
  const origin = `http://127.0.0.1:${address.port}`
  const scaffold = await launchWebScaffold({ profile: { packages: [{ dir: BUNDLE }] }, replayFixture: FIXTURE,
    compareReplaySession: false })
  resources.scaffold = scaffold
  const browser = await chromium.launch(); resources.browser = browser
  const context = await browser.newContext({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE, timezoneId: 'Asia/Shanghai' })
  const page = await context.newPage(), settings = await context.newPage()
  const consoles = [watchConsole(page), watchConsole(settings)]
  onTestFailed(async () => { await saveFailureShot(page, 'web-e2e-cot-chatjimmy'); await saveFailureShot(settings, 'web-e2e-cot-chatjimmy-settings') })
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
  const prompts = fixtureUserPrompts(canonical), prompt = prompts[0]
  expect(prompts).toHaveLength(1)
  if (prompt === undefined) throw new Error('Borrowed recorded reasoning requires its canonical user prompt')
  const settled = scaffold.whenTurnSettled(), composer = page.locator('[data-composer-input]').first()
  await composer.fill(prompt); await composer.press('Enter')
  const auditSessionId = await settled
  resources.sessionId = auditSessionId
  await page.getByText('LIGHTHOUSE', { exact: true }).waitFor()
  const session = scaffold.ctx.sessions.get(auditSessionId)
  if (session === undefined) throw new Error('Recorded main Session is absent')
  const history = session.deriveMessages(), header = session.requestHeader(), events = await readPersistedEvents(scaffold, auditSessionId)
  const storageHeader = (await scaffold.ctx.sessionPersistence.stat(auditSessionId))?.header
  if (storageHeader === undefined) throw new Error('Recorded main Session lacks its durable header')
  const reasoning = page.locator('[data-variant="think"]').first()
  await reasoning.waitFor({ state: 'attached' }); await expandOwningTurnProcess(page, reasoning)

  await settings.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await settings.getByRole('button', { name: '插件', exact: true }).click()
  const panel = settings.locator('[data-plugin-panel]'), card = panel.locator(`[data-plugin-package="${BUNDLE_NAME}"]`)
  await panel.getByRole('button', { name: '更多', exact: true }).click()
  const toggle = card.getByRole('switch'); await toggle.waitFor()
  await toggle.click()
  await expect.poll(() => toggle.getAttribute('aria-checked'), { timeout: PLUGIN_TOGGLE_SETTLE_MS }).toBe('true')
  // The deployment owns this address and model id, so they arrive through the profile rather than the panel.
  const translatorEntry = scaffold.ctx.configEditor.entries().find(row => row.options.id === 'translator')
  if (translatorEntry === undefined) throw new Error('The enabled bundle leaves no translator profile entry')
  await scaffold.ctx.configEditor.edit(translatorEntry, () => ({ chatjimmyEndpoint: `${origin}/chat` }))
  await card.getByRole('button').first().click()
  const provider = panel.getByLabel('翻译服务', { exact: true })
  await provider.waitFor(); expect(await provider.inputValue()).toBe('bing')
  await provider.getByRole('option', { name: 'ChatJimmy', exact: true }).waitFor({ state: 'attached' })
  expect(calls).toEqual([])
  await provider.selectOption('chatjimmy')
  const save = panel.getByRole('button', { name: '保存', exact: true })
  await save.click(); await expect.poll(() => save.isDisabled()).toBe(true)
  await panel.getByText(KEYLESS, { exact: false }).waitFor()
  await compareOrRefreshGolden(join(EXPECTED, 'chatjimmy-choices.expected.md'),
    await captureStableAria(settings, '[data-plugin-panel]', scaffold.workspaceCwd, {
      replacements: [[BUNDLE, '{{bundle}}'], [bundleVersion, '{{version}}']],
    }), MODE)
  await reasoning.locator('[data-disclosure-row]').first().click()
  const translated = reasoning.locator('[data-cot-translation]')
  await translated.getByText(TRANSLATED, { exact: true }).waitFor()
  await expect.poll(() => translated.getAttribute('data-translation-state')).toBe('ready')
  expect(calls).toHaveLength(1)
  await compareOrRefreshGolden(join(EXPECTED, 'chatjimmy-result.expected.md'),
    await captureStableAria(page, '[data-variant="think"]', scaffold.workspaceCwd), MODE)
  await translated.getByRole('button', { name: '查看原文', exact: true }).click()
  await translated.getByText(ORIGINAL, { exact: true }).waitFor()
  await translated.getByRole('button', { name: '查看译文', exact: true }).click()
  expect(calls).toHaveLength(1)
  const saved = await readPersistedEvents(scaffold, auditSessionId)
  expect(saved.filter(event => !isTranslationRecord(event))).toEqual(events)
  const savedRecords = saved.filter(isTranslationRecord)
  expect(savedRecords).toHaveLength(2)
  const request = calls[0]?.body as { chatOptions?: Record<string, unknown>; messages?: { role: string; content: string }[] }
  expect(savedRecords[0]).toMatchObject({ type: 'plugin:translator/request', ignorable: true,
    data: { provider: 'chatjimmy', text: ORIGINAL, targetLanguage: 'zh', sourceLanguage: 'auto' } })
  const stored = pluginRecordOf(savedRecords[0]!)?.data as { recipe?: unknown }
  const identity = JSON.parse(String(stored.recipe)) as [string, string, string, number, number]
  expect(identity[0]).toBe('chatjimmy-literal-v3')
  expect(identity[1]).toHaveLength(64)
  expect(identity.slice(2)).toEqual(['llama3.1-8B', 1, 0])
  expect(savedRecords[1]).toMatchObject({ type: 'plugin:translator/result', ignorable: true,
    data: { requestSeq: savedRecords[0]?.seq, text: TRANSLATED } })
  await reasoning.locator('[data-disclosure-row]').first().click(); await translated.waitFor({ state: 'detached' })
  await reasoning.locator('[data-disclosure-row]').first().click()
  await translated.getByText(TRANSLATED, { exact: true }).waitFor()
  expect(calls).toHaveLength(1)
  expect(await readPersistedEvents(scaffold, auditSessionId)).toEqual(saved)
  const warningStart = consoles[0]!.warnings.length
  await page.reload({ waitUntil: 'load' })
  await page.getByText('LIGHTHOUSE', { exact: true }).waitFor()
  await reasoning.waitFor({ state: 'attached' }); await expandOwningTurnProcess(page, reasoning)
  const disclosure = reasoning.locator('[data-disclosure-row]').first()
  if (await disclosure.getAttribute('aria-expanded') === 'false') await disclosure.click()
  await translated.getByText(TRANSLATED, { exact: true }).waitFor()
  await expect.poll(() => translated.getAttribute('data-translation-state')).toBe('ready')
  acknowledgeReloadConnectionLoss(consoles[0]!, warningStart)
  expect(calls).toHaveLength(1)
  expect(await readPersistedEvents(scaffold, auditSessionId)).toEqual(saved)

  // The tuned prompt reaches the documented envelope with no credential and no cookie.
  expect(request.chatOptions).toMatchObject({ selectedModel: 'llama3.1-8B', topK: 1, temperature: 0 })
  expect(String(request.chatOptions?.systemPrompt)).toContain('Never write the <<< >>> markers')
  expect(request.messages).toEqual([{ role: 'user', content: `Translate into Simplified Chinese (简体中文):\n<<<${ORIGINAL}>>>\nTranslation:` }])
  expect(calls[0]?.cookie).toBeUndefined()
  expect(calls[0]?.bearer).toBeUndefined()
  expect(JSON.stringify(request)).not.toContain('LIGHTHOUSE')
  expect((await scaffold.ctx.sessionPersistence.stat(auditSessionId))?.header).toEqual(storageHeader)
  expect(session.deriveMessages()).toEqual(history)
  expect(session.requestHeader()).toEqual(header)
  expect(fixtureErrors).toEqual([])
  for (const observed of consoles) { expect(observed.pageErrors).toEqual([]); expect(observed.warnings).toEqual([]) }
  await assertFixtureInventory(EXPECTED, ['chatjimmy-choices.expected.md', 'chatjimmy-result.expected.md'])
})
