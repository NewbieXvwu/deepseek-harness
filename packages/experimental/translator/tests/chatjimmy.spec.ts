import { afterEach, describe, expect, it } from 'vitest'
import Translator from '../src/index.ts'
import { anonymousRecipe } from '../src/provider.ts'
import { CHATJIMMY_REVISION, CHATJIMMY_SYSTEM, chatjimmyPrompt, chatjimmyTranslation, languageName } from '../src/chatjimmy.ts'
import { fixture, text, type RawConfig } from './fixture.ts'
import type { AnonymousTranslationSpec } from '../src/types.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const chat = (payload: string, overrides: RawConfig = {}) => fixture(cleanups, (_req, res) => { text(res, payload) }, overrides)
const stats = (reason = 'stop') => `<|stats|>{"created_at":1,"done":true,"done_reason":"${reason}","status":0,"decode_tokens":9}<|/stats|>`
const fragment = (source: string, targetLanguage: string): AnonymousTranslationSpec =>
  ({ text: source, targetLanguage, sourceLanguage: 'auto', provider: 'chatjimmy' })

describe('chatjimmy translator', () => {
  it('sends the tuned prompt through the direct chat envelope', async () => {
    const { translator, requests } = await chat(`你好，世界。${stats()}`)
    const request = translator.resolve({ text: 'Hello world.', targetLanguage: 'zh', provider: 'chatjimmy' })
    expect(await translator.translate(request)).toBe('你好，世界。')
    const sent = requests[0]!
    expect(sent.method).toBe('POST')
    expect(sent.headers['content-type']).toBe('application/json')
    expect(sent.headers.cookie).toBeUndefined()
    expect(sent.headers.authorization).toBeUndefined()
    expect(JSON.parse(sent.body)).toEqual({
      messages: [{ role: 'user', content: `Translate into ${languageName('zh')}:\n<<<Hello world.>>>\nTranslation:` }],
      chatOptions: { selectedModel: 'llama3.1-8B', systemPrompt: CHATJIMMY_SYSTEM, topK: 1, temperature: 0 },
      attachment: null,
    })
    expect(CHATJIMMY_SYSTEM).toContain('Never write the <<< >>> markers')
  })

  it('names the destination language and script for the model', () => {
    expect(chatjimmyPrompt(fragment('Keep 2 spaces.\n- bullet', 'zh-Hant')).user)
      .toBe(`Translate into ${languageName('zh-Hant')}:\n<<<Keep 2 spaces.\n- bullet>>>\nTranslation:`)
    expect(languageName('zh')).toBe('Simplified Chinese (简体中文)')
    expect(languageName('zh-HK')).toBe('Traditional Chinese (繁體中文)')
    expect(languageName('JA')).toBe('Japanese')
    expect(languageName('qq-zz')).toBe('qq-zz')
    expect(chatjimmyPrompt(fragment('hello', 'qq-ZZ')).user).toContain('Translate into qq-ZZ:')
  })

  it.each([
    [`你好，世界。${stats()}`, '你好，世界。'],
    ['你好\n<|stats|>{"done":true,"done_reason":"stop"}</stats>', '你好'],
    [`你好，世界。${stats()}`, '你好，世界。'],
    [`  「你好，世界。」 \n\n${stats()}`, '你好，世界。'],
    [`<<<你好，世界。>>${stats()}`, '你好，世界。'],
    [`Translation: 你好，世界。${stats()}`, '你好，世界。'],
    [`译文：你好，世界。${stats()}`, '你好，世界。'],
    [`简体中文：\n你好，世界。${stats()}`, '你好，世界。'],
    [`翻译：简体中文：你好，世界。${stats()}`, '你好，世界。'],
    ['你好，世界。<|stats|>not json<|/stats|>', '你好，世界。'],
    ['你好，世界。<|stats|>null<|/stats|>', '你好，世界。'],
    ['你好，世界。<|stats|>[1]<|/stats|>', '你好，世界。'],
    ['你好，世界。<|stats|>5<|/stats|>', '你好，世界。'],
    [`（「你好，世界。」）${stats()}`, '你好，世界。'],
  ])('reads the translation out of %j', async (payload, expected) => {
    const { translator } = await chat(payload)
    expect(await translator.translate(translator.resolve({ text: 'Hello world.', targetLanguage: 'zh', provider: 'chatjimmy' })))
      .toBe(expected)
  })

  it.each([
    ['', 'an empty body'],
    [` ${stats()}`, 'a reply with no translation'],
    [`翻译：\n${stats()}`, 'a reply that is only a language label'],
    [`你好，世界。${stats('length')}`, 'a reply telemetry says was cut short'],
    [`你好，世界。 ${stats()}\n<|stats|>tail`, 'a residual telemetry marker'],
    [`你好，世界。<|stats|>{"done_reason":"stop"}<|/stats|>${stats()}`, 'two telemetry trailers'],
    [`你好，世界。${stats()}\n<<<again>>>`, 'a residual prompt marker'],
    [`你好，世界。${stats()} <|eot_id|>`, 'a control token'],
  ])('rejects %s before the reader sees it', async (payload) => {
    const { translator } = await chat(payload)
    await expect(translator.translate(translator.resolve({ text: 'Hello world.', targetLanguage: 'zh', provider: 'chatjimmy' })))
      .rejects.toThrow(expect.objectContaining({ code: 'TRANSLATION_INVALID_RESPONSE' }))
  })

  it('refuses the reply shapes the small model is known for', () => {
    const outcome = (source: string, targetLanguage: string, reply: string): string => {
      try {
        return `accepted: ${chatjimmyTranslation(reply, fragment(source, targetLanguage))}`
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    }
    expect(outcome('The diff is empty.', 'zh', 'The diff is empty.')).toContain('left the fragment untranslated')
    expect(outcome('The disclosure stays original until the reader asks.', 'zh',
      'The disclosure stays original until the reader asks. （展开前保持原文）')).toContain('repeated the fragment')
    expect(outcome('An address draft stays hidden.', 'zh', '一个隐藏的地址草稿内容。一个隐藏的地址草稿内容。一个隐藏的地址草稿内容。'))
      .toContain('repeated itself')
    expect(outcome('Quotation marks appear around the output.', 'zh', '引号符会出现在输出中某些情况下。\n引号符会出现在输出中某些情况下。'))
      .toContain('repeated itself')
    expect(outcome('Every retry blocked when the endpoint was missing.', 'zh', '每次重试都被阻止，當時端点不存在。'))
      .toContain('used the wrong Chinese script')
    expect(outcome('Every retry blocked when the endpoint was missing.', 'zh-Hant', '每次重試都被阻止，當時端點不存在。'))
      .toBe('accepted: 每次重試都被阻止，當時端點不存在。')
    expect(outcome('你好', 'zh', '你好吗')).toBe('accepted: 你好吗')
    expect(outcome('The wrapper owns toolbar state and typography.', 'zh', '状态。')).toContain('dropped most of the fragment')
    expect(outcome('The gate failed once.', 'zh',
      '这道门禁检查失败了一次，并且它把每一个已经缓存的结果都重新计算了一遍，所以后面的请求仍然会继续发送。'))
      .toContain('added text the fragment does not contain')
    expect(outcome('你好，世界。', 'en', 'Hello world.')).toBe('accepted: Hello world.')
    expect(outcome('你好，世界。', 'ja', 'こんにちは世界。')).toBe('accepted: こんにちは世界。')
    expect(outcome('Say OK if you understand.', 'zh', '你明白了就说 OK。')).toBe('accepted: 你明白了就说 OK。')
  })

  it('keeps chatjimmy results distinct by prompt revision, endpoint, model and decoding settings', () => {
    const endpoint = 'https://chatjimmy.invalid/api/chat'
    const stored = (overrides: RawConfig = {}) => anonymousRecipe('chatjimmy',
      Translator.Config({ chatjimmyEndpoint: endpoint, ...overrides }))
    const identity = JSON.parse(stored()) as [string, string, string, number, number]
    expect(identity[0]).toBe(CHATJIMMY_REVISION)
    expect(identity[1]).toHaveLength(64)
    expect(identity.slice(2)).toEqual(['llama3.1-8B', 1, 0])
    expect(stored()).toBe(stored())
    expect(stored({ chatjimmyModel: 'other-model' })).not.toBe(stored())
    expect(stored({ chatjimmyTopK: 8 })).not.toBe(stored())
    expect(stored({ chatjimmyTemperature: 0.7 })).not.toBe(stored())
    expect(stored({ chatjimmyEndpoint: 'https://chatjimmy.other.invalid/api/chat' })).not.toBe(stored())
    expect(stored()).not.toContain('chatjimmy.invalid')
    expect(anonymousRecipe('bing', Translator.Config({}))).not.toBe(stored())
  })

  it('offers chatjimmy as an anonymous choice with its own defaults', async () => {
    const defaults = Translator.Config({})
    expect(defaults.chatjimmyEndpoint).toBe('https://chatjimmy.ai/api/chat')
    expect(defaults.chatjimmyModel).toBe('llama3.1-8B')
    expect(defaults.chatjimmyTopK).toBe(1)
    expect(defaults.chatjimmyTemperature).toBe(0)
    expect(() => Translator.Config({ chatjimmyEndpoint: 'https://user:secret@chatjimmy.invalid/' })).toThrow()
    expect(() => Translator.Config({ chatjimmyTopK: 0 })).toThrow()
    expect(() => Translator.Config({ chatjimmyTemperature: 3 })).toThrow()
    const { translator } = await chat(`你好，世界。${stats()}`)
    expect(await translator.availableProviders()).toContain('chatjimmy')
  })

  it('reports a rejected request without the source text and honours the byte limit', async () => {
    const refused = await fixture(cleanups, (_req, res) => { res.writeHead(429); res.end('private source text') })
    await expect(refused.translator.translate(refused.translator.resolve({ text: 'private source text', targetLanguage: 'zh', provider: 'chatjimmy' })))
      .rejects.toThrow(expect.objectContaining({ code: 'TRANSLATION_HTTP_ERROR', message: 'chatjimmy translation failed (HTTP 429)' }))
    const body = `你好，世界。${stats()}`
    const short = await chat(body, { maxResponseBytes: Buffer.byteLength(body) - 1 })
    await expect(short.translator.translate(short.translator.resolve({ text: 'Hello world again.', targetLanguage: 'zh', provider: 'chatjimmy' })))
      .rejects.toThrow(expect.objectContaining({ code: 'TRANSLATION_RESPONSE_LIMIT' }))
  })
})
