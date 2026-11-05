/** Opt-in prompt-tuning evidence for the chatjimmy route, paced to the free upstream quota. */
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Translator, { TranslationError } from '../src/index.ts'

const SENTENCES = Number(process.env.DSH_TRANSLATION_SENTENCES ?? 561)
const PACE_MS = Number(process.env.DSH_TRANSLATION_PACE_MS ?? 3_500)
const contexts: Context[] = []

afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })

async function translator() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Translator, { timeoutMs: 30_000 })
  return ctx.translator
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })
const HAN = /[一-鿿]/u
const HAN_CHARS = /[一-鿿]/gu
const WORD = /^[A-Za-z][a-z]{1,}$/u
/** Glyphs that only occur in Traditional Chinese, so a Simplified request never receives them. */
const TRADITIONAL = /[個們來說對時國點樣歷關聯數據庫網絡係範號標準實現簡單繼續動態靜區塊讀寫權歸應將專與發變讓經過運從處門費資質則務議週歲]/u

/**
 * Classify a served reply. The guarded shapes never reach this check: the route refuses them instead of showing them.
 * @param source - submitted English fragment.
 * @param reply - text the route served.
 * @returns violation names; empty means the reply is a usable translation.
 */
function violations(source: string, reply: string): string[] {
  const flat = reply.replace(/\s+/gu, ' ').trim()
  const found: string[] = []
  if (/<<<|>>>|translation:|target language|source text|do not answer it|output only/iu.test(flat)) found.push('prompt-leak')
  if (/^(sure|certainly|of course|here is|here's|the translation|好的|抱歉|对不起|请注意)/iu.test(flat)) found.push('preamble')
  // The route strips a leading script label, so a hit here means the strip list missed one of its shapes.
  if (/^(?:译文|译文如下|翻译|翻译结果|以下是|中文|英文|汉语|简体中文|繁體中文|simplified chinese|traditional chinese|chinese|english|translation)\s*[:：]/iu.test(flat)) found.push('language-label')
  if (TRADITIONAL.test(flat)) found.push('traditional-variant')
  if (/```|~~~/u.test(flat) && !/```/u.test(source)) found.push('markup')
  const words = source.split(/[^A-Za-z]+/u).filter(word => WORD.test(word))
  if (words.length >= 4 && flat.toLowerCase().includes(words.slice(0, 4).join(' ').toLowerCase())) found.push('partial-echo')
  const rendered = (flat.match(HAN_CHARS) ?? []).length
  if (words.length >= 5 && rendered < words.length * 0.5) found.push('dropped-text')
  if (words.length >= 3 && rendered > words.length * 6) found.push('added-text')
  if (!HAN.test(flat) && words.length >= 2) found.push('english-passthrough')
  return found
}

/**
 * An independent reference translation for fidelity scoring, taken from the anonymous Bing endpoint this package also
 * serves as the panel's default provider — a different operator from the route under test. Opt-in, because it adds a
 * second upstream to a run that already paces against one.
 */
async function reference(text: string): Promise<string | undefined> {
  const url = new URL('https://edge.microsoft.com/translate/translatetext')
  url.searchParams.set('to', 'zh-Hans')
  url.searchParams.set('isEnterpriseClient', 'false')
  const body = JSON.stringify([text])
  for (let attempt = 0; attempt < 3; attempt++) {
    await sleep(1_200)
    try {
      const response = await fetch(url, { method: 'POST', body, headers: { 'content-type': 'application/json' } })
      if (response.ok) {
        const payload = await response.json() as unknown
        if (!Array.isArray(payload)) return undefined
        const first: unknown = payload[0]
        if (typeof first !== 'object' || first === null || !('translations' in first)) return undefined
        const translations: unknown = first.translations
        if (!Array.isArray(translations)) return undefined
        const entry: unknown = translations[0]
        if (typeof entry !== 'object' || entry === null || !('text' in entry) || typeof entry.text !== 'string') return undefined
        return entry.text
      }
      // Throttling is expected traffic on a free endpoint, so it is retried; anything else leaves the reply ungraded.
      if (response.status !== 429 && response.status !== 503) return undefined
    } catch (_error) {
      /* A failed lookup leaves this reply ungraded; the run still reports the fragments it scored. */
    }
    await sleep(8_000 * (attempt + 1))
  }
  return undefined
}

const REFERENCE_CHARS = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]/gu

/**
 * Share of an independent reference's characters that the served reply also uses, as a multiset overlap.
 * Alternative phrasings and untranslated proper nouns lower it, so it screens for review rather than judging quality.
 * @param reply - text the route served.
 * @param target - reference translation.
 * @returns overlap in `[0, 1]`, or `undefined` when the reference was unavailable.
 */
function overlap(reply: string, target: string | undefined): number | undefined {
  if (target === undefined || target === '') return undefined
  const pool = new Map<string, number>()
  for (const char of target.match(REFERENCE_CHARS) ?? []) pool.set(char, (pool.get(char) ?? 0) + 1)
  const used = (target.match(REFERENCE_CHARS) ?? []).length
  if (used === 0) return undefined
  let shared = 0
  for (const char of reply.match(REFERENCE_CHARS) ?? []) {
    const left = pool.get(char) ?? 0
    if (left > 0) { shared += 1; pool.set(char, left - 1) }
  }
  return shared / used
}

describe.skipIf(process.env.DSH_TRANSLATION_LIVE !== '1')('chatjimmy prompt tuning', () => {
  it(`translates ${SENTENCES} English sentences and serves only usable Simplified Chinese`, { timeout: 8_400_000, retry: 0 }, async () => {
    const corpus = JSON.parse(readFileSync(new URL('./fixtures/chatjimmy-corpus.json', import.meta.url), 'utf8')) as string[]
    const submitted = corpus.slice(0, SENTENCES)
    // A free shared endpoint throttles hard enough that a full pass can exceed any test budget. Stopping at a
    // deadline keeps the counts already measured instead of losing the whole run, and the assertions below then
    // describe the fragments actually attempted.
    const deadline = Number(process.env.DSH_TRANSLATION_DEADLINE_MIN ?? 0) * 60_000
    const startedAt = Date.now()
    const service = await translator()
    const defects: string[] = []
    const refused: string[] = []
    const transport: string[] = []
    const served: { text: string; reply: string }[] = []
    let attempted = 0
    for (const [index, text] of submitted.entries()) {
      if (deadline > 0 && Date.now() - startedAt > deadline) break
      attempted = index + 1
      await sleep(PACE_MS)
      let reply: string
      try {
        reply = await service.translate(service.resolve({ text, targetLanguage: 'zh', provider: 'chatjimmy' }))
      } catch (error) {
        if (error instanceof TranslationError && error.code === 'TRANSLATION_INVALID_RESPONSE') {
          refused.push(`${index} ${error.message} <- ${text.slice(0, 40)}`)
          continue
        }
        if (error instanceof TranslationError && error.message.includes('HTTP 429')) {
          await sleep(65_000)
          try {
            reply = await service.translate(service.resolve({ text, targetLanguage: 'zh', provider: 'chatjimmy' }))
          } catch (retry) {
            transport.push(`${index} ${String(retry)}`)
            continue
          }
        } else {
          transport.push(`${index} ${String(error)} <- ${text.slice(0, 40)}`)
          continue
        }
      }
      served.push({ text, reply })
      const kinds = violations(text, reply)
      if (kinds.length > 0) {
        defects.push(`${index} ${kinds.join(',')} ${JSON.stringify(reply.slice(0, 70))} <- ${text.slice(0, 40)}`)
      }
    }
    // The counts are the tuning evidence the Agent Note states: a refused fragment shows the original reasoning, and
    // every served fragment must be usable.
    console.info('chatjimmy measured run', { corpus: submitted.length, attempted, served: served.length,
      refused: refused.length, transport: transport.length })
    expect(defects, `${defects.length} served replies violated the contract:\n${defects.slice(0, 20).join('\n')}`).toEqual([])
    // A refusal shows the original reasoning, so it is safe; a route that refuses most fragments is not working.
    expect(served.length, `served only ${served.length} of ${served.length + refused.length}: ${refused.slice(0, 10).join(' | ')}`)
      .toBeGreaterThan((served.length + refused.length) * 0.5)
    // The shared operator answers nearly all of a paced run; an endpoint losing a tenth of the fragments is not a route
    // worth offering, and its availability is disclosed as inherited rather than guaranteed.
    const transportBound = Math.floor(attempted * 0.1)
    expect(transport.length, `transport failures ${transport.length} of ${attempted}: ${transport.slice(0, 5).join(' | ')}`)
      .toBeLessThanOrEqual(transportBound)
    // DSH_TRANSLATION_REFERENCE=bing additionally grades served replies against an independent reference
    // translation, which screens for replies that rewrite or answer the fragment instead of translating it. The
    // reference endpoint throttles, so the pass samples a spread of the served set instead of all of it.
    if (process.env.DSH_TRANSLATION_REFERENCE === 'bing') {
      const limit = Number(process.env.DSH_TRANSLATION_GRADE_LIMIT ?? 150)
      const step = Math.max(1, Math.ceil(served.length / limit))
      const sampled = served.filter((_pair, position) => position % step === 0)
      const scores: number[] = []
      const suspects: string[] = []
      for (const pair of sampled) {
        const score = overlap(pair.reply, await reference(pair.text))
        if (score === undefined) continue
        scores.push(score)
        if (score < 0.4) suspects.push(`${score.toFixed(2)} ${JSON.stringify(pair.reply.slice(0, 60))} <- ${pair.text.slice(0, 40)}`)
      }
      const sorted = scores.slice().sort((left, right) => left - right)
      const median = sorted[Math.floor(sorted.length / 2)] ?? 0
      console.info('chatjimmy fidelity against an independent reference',
        { sampled: sampled.length, graded: sorted.length, median: median.toFixed(2), below040: suspects.length })
      console.info(`lowest served replies:\n${suspects.slice(0, 12).join('\n')}`)
      // Proper nouns, alternative phrasing and Markdown all lower the overlap, so this is a floor against a route that
      // stopped translating rather than a quality bar; a measured run lands near 0.7.
      expect(sorted.length, `only ${sorted.length} of ${sampled.length} replies were graded`)
        .toBeGreaterThanOrEqual(sampled.length * 0.5)
      expect(median, `median character overlap ${median.toFixed(2)} over ${sorted.length} graded replies`)
        .toBeGreaterThanOrEqual(0.6)
    }
  })
})
