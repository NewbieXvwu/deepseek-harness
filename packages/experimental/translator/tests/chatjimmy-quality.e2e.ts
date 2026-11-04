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

describe.skipIf(process.env.DSH_TRANSLATION_LIVE !== '1')('chatjimmy prompt tuning', () => {
  it(`translates ${SENTENCES} English sentences and serves only usable Simplified Chinese`, async () => {
    const corpus = JSON.parse(readFileSync(new URL('./fixtures/chatjimmy-corpus.json', import.meta.url), 'utf8')) as string[]
    const submitted = corpus.slice(0, SENTENCES)
    const service = await translator()
    const defects: string[] = []
    const refused: string[] = []
    const transport: string[] = []
    let served = 0
    for (const [index, text] of submitted.entries()) {
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
      served += 1
      const kinds = violations(text, reply)
      if (kinds.length > 0) {
        defects.push(`${index} ${kinds.join(',')} ${JSON.stringify(reply.slice(0, 70))} <- ${text.slice(0, 40)}`)
      }
    }
    // The counts are the tuning evidence the Agent Note states: a refused fragment shows the original reasoning, and
    // every served fragment must be usable.
    console.info('chatjimmy measured run', { submitted: submitted.length, served, refused: refused.length,
      transport: transport.length })
    expect(defects, `${defects.length} served replies violated the contract:\n${defects.slice(0, 20).join('\n')}`).toEqual([])
    // A refusal shows the original reasoning, so it is safe; a route that refuses most fragments is not working.
    expect(served, `served only ${served} of ${served + refused.length}: ${refused.slice(0, 10).join(' | ')}`)
      .toBeGreaterThan((served + refused.length) * 0.5)
    // The shared operator answers nearly all of a paced run; an endpoint losing a tenth of the fragments is not a route
    // worth offering, and its availability is disclosed as inherited rather than guaranteed.
    const transportBound = Math.floor(submitted.length * 0.1)
    expect(transport.length, `transport failures ${transport.length} of ${submitted.length}: ${transport.slice(0, 5).join(' | ')}`)
      .toBeLessThanOrEqual(transportBound)
  }, 4_000_000)
})
