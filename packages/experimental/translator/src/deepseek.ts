/** Native-route admission and independent audited Flash translation without Agent history. */
import { FiberState, type Context, type Fiber } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { BlockAssembler, ReasoningEffortId, type LlmRuntime, type FinishReason } from '@deepseek-ai/dsh-llm'
import type { Config as AccountNativeConfig } from '@deepseek-ai/dsh-llm-deepseek-account'
import type { Config as OfficialNativeConfig } from '@deepseek-ai/dsh-llm-deepseek-api-key'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type { Config } from './index.ts'
import type { NativeTranslationProvider, NativeTranslationSpec, TranslationIdentity, TranslationProvider } from './types.ts'
import { ANONYMOUS_PROVIDERS } from './provider.ts'
import { TranslationError } from './error.ts'
import type { TranslationLog } from './storage.ts'
import { assembledText, auditedFragment, awaitMetadata, deliverTranslation, logEmptyFragment, paidRouteFailure } from './model-route.ts'

const MODEL = 'deepseek-flash'
const OWNER_PACKAGES = { 'deepseek-account': '@deepseek-ai/dsh-llm-deepseek-account',
  'deepseek-official': '@deepseek-ai/dsh-llm-deepseek-api-key' } as const

interface NativeOwnerFields { llm: LlmRuntime; fiber: Fiber }
type NativeOwner = NativeOwnerFields & (
  | { provider: 'deepseek-account'; config: AccountNativeConfig }
  | { provider: 'deepseek-official'; config: OfficialNativeConfig }
)
/** Configured model input of an owner: Account overrides over its listing, or the Official catalog. */
type ModelConfig = ReturnType<AccountNativeConfig['modelOverrides']['get']> | ReturnType<OfficialNativeConfig['models']['get']>
type EligibleOwner = NativeOwner & { modelConfig: ModelConfig; apiKeyRef?: string }

function modelConfigOf(owner: NativeOwner): ModelConfig {
  return owner.provider === 'deepseek-account' ? owner.config.modelOverrides.get() : owner.config.models.get()
}

/**
 * Identify fixed native translation semantics without inspecting credentials or a model catalog.
 * @param config - independent translation output-token limit.
 * @returns fixed Flash model, literal-text prompt revision, disabled thinking, and requested output cap.
 */
export function deepseekRecipe(config: Config): string {
  return JSON.stringify([MODEL, 'literal-fragment-v1', 'off', config.deepseekMaxOutputTokens])
}

function nativeOwner(ctx: Context, provider: NativeTranslationProvider): NativeOwner | undefined {
  const llm = ctx.get('llm'), loader = ctx.get('loader')
  if (llm === undefined || loader === undefined || !llm.listProviders().some(row => row.id === provider)) return undefined
  const directory = llm.listConfigurableProviders().find(row => row.provider === provider)
  if (directory === undefined || directory.settingsPath.length !== 0) return undefined
  const entry = [...loader.entries()].find(row => row.options.id === directory.settingsNs && row.options.name === OWNER_PACKAGES[provider])
  if (entry?.fiber?.state !== FiberState.ACTIVE) return undefined
  return provider === 'deepseek-account'
    ? { llm, fiber: entry.fiber.ctx.fiber, provider, config: entry.fiber.effectiveConfig as AccountNativeConfig }
    : { llm, fiber: entry.fiber.ctx.fiber, provider, config: entry.fiber.effectiveConfig as OfficialNativeConfig }
}

function unchanged(ctx: Context, provider: NativeTranslationProvider, previous: EligibleOwner): NativeOwner | undefined {
  const current = nativeOwner(ctx, provider)
  if (current === undefined || current.fiber !== previous.fiber
    || modelConfigOf(current) !== previous.modelConfig
    || (current.provider === 'deepseek-official' && current.config.apiKeyEnv.get() !== previous.apiKeyRef)) return undefined
  return current
}

async function eligible(ctx: Context, provider: NativeTranslationProvider, signal: AbortSignal,
  track: (work: Promise<unknown>) => void): Promise<EligibleOwner | undefined> {
  signal.throwIfAborted()
  const owner = nativeOwner(ctx, provider)
  if (owner === undefined) return undefined
  const modelConfig = modelConfigOf(owner)
  const apiKeyRef = owner.provider === 'deepseek-official' ? owner.config.apiKeyEnv.get() : undefined
  if (apiKeyRef !== undefined) {
    const credentials = ctx.get('credentials')
    if (credentials === undefined) {
      if ((launchEnvironmentOf(ctx).get(apiKeyRef)?.value.length ?? 0) === 0) return undefined
    } else if (!(await awaitMetadata(() => credentials.describe(credentialRef(apiKeyRef)), signal, track)).configured) return undefined
  }
  const catalog = await awaitMetadata(() => owner.llm.listModels(provider), signal, track)
  signal.throwIfAborted()
  if (!catalog.some(model => model.id === MODEL)) return undefined
  const accepted = { ...owner, modelConfig, ...apiKeyRef === undefined ? {} : { apiKeyRef } }
  return unchanged(ctx, provider, accepted) === undefined ? undefined : accepted
}

/**
 * Inspect native owners, credentials and exact Flash catalogs without inference.
 * @param ctx - translator context with optional provider services.
 * @param config - deadline for discovery.
 * @param signal - caller and service cancellation.
 * @param track - translator-owned settlement tracking for lookups that cannot accept cancellation.
 * @returns anonymous choices followed by eligible explicitly named paid routes.
 */
export async function availablePaidProviders(ctx: Context, config: Config, signal: AbortSignal,
  track: (work: Promise<unknown>) => void): Promise<readonly TranslationProvider[]> {
  using timeout = deadline(signal, config.deepseekTimeoutMs, 'TRANSLATION_TIMEOUT')
  const available: TranslationProvider[] = [...ANONYMOUS_PROVIDERS]
  for (const provider of ['deepseek-account', 'deepseek-official'] as const) {
    try {
      const candidate = await eligible(ctx, provider, timeout.signal, track)
      timeout.signal.throwIfAborted()
      if (candidate !== undefined) available.push(provider)
    } catch (_unavailableNativeProvider) {
      const expired = timeoutOf(timeout.signal, 'TRANSLATION_TIMEOUT')
      if (expired !== undefined && expired !== signal.reason) return available
      timeout.signal.throwIfAborted()
    }
  }
  return available
}

/**
 * Audit and dispatch exactly one native Flash request with disabled thinking.
 * @param ctx - translator context with optional native services.
 * @param spec - explicit paid route, fragment, target language and existing Session.
 * @param config - paid deadline/output-token cap and shared response-byte limit.
 * @param signal - caller and service cancellation.
 * @param track - translator-owned settlement tracking for lookups that cannot accept cancellation.
 * @param log - common Session storage for this already cache-checked attempt.
 * @param identity - exact fragment, languages, route, and semantic recipe.
 * @returns non-empty text from a stop finish; all other outcomes reject safely.
 */
export async function translateWithDeepSeek(ctx: Context, spec: NativeTranslationSpec, config: Config, signal: AbortSignal,
  track: (work: Promise<unknown>) => void, log: TranslationLog, identity: TranslationIdentity): Promise<string> {
  const execution = new AbortController()
  using timeout = deadline(AbortSignal.any([signal, execution.signal]), config.deepseekTimeoutMs, 'TRANSLATION_TIMEOUT')
  let unwatch: (() => void) | undefined
  try {
    if (spec.text === '') return await logEmptyFragment(log, identity, timeout.signal, track)
    const accepted = await eligible(ctx, spec.provider, timeout.signal, track)
    timeout.signal.throwIfAborted()
    if (accepted === undefined) throw new TranslationError('TRANSLATION_UNAVAILABLE', 'Selected native Flash translation provider is unavailable')
    const owner = unchanged(ctx, spec.provider, accepted)
    if (owner === undefined) throw new TranslationError('TRANSLATION_UNAVAILABLE', 'Selected native Flash translation provider is unavailable')
    unwatch = ctx.on('internal/status', (fiber) => {
      if (fiber === owner.fiber && fiber.state !== FiberState.ACTIVE) {
        execution.abort(new TranslationError('TRANSLATION_UNAVAILABLE', 'Native Flash translation provider was withdrawn'))
      }
    }, { global: true })
    const prepared = await awaitMetadata(() => owner.llm.prepareCall({ provider: spec.provider, model: MODEL,
      reasoningEffort: ReasoningEffortId('off'), maxTokens: config.deepseekMaxOutputTokens }, timeout.signal), timeout.signal, track)
    timeout.signal.throwIfAborted()
    if (await eligible(ctx, spec.provider, timeout.signal, track) === undefined || unchanged(ctx, spec.provider, accepted) === undefined) {
      throw new TranslationError('TRANSLATION_UNAVAILABLE', 'Native Flash translation provider changed before dispatch')
    }
    if (prepared.config.reasoningEffort !== 'off') throw new TranslationError('TRANSLATION_UNAVAILABLE', 'Native Flash translation requires disabled thinking')
    const { options, requestSeq } = await auditedFragment(prepared.config, spec, identity, log, timeout.signal, track)
    timeout.signal.throwIfAborted()
    // Durable storage can outlast the admitted owner, credentials, or model catalog.
    if (await eligible(ctx, spec.provider, timeout.signal, track) === undefined || unchanged(ctx, spec.provider, accepted) === undefined) {
      throw new TranslationError('TRANSLATION_UNAVAILABLE', 'Native Flash translation provider changed before dispatch')
    }
    timeout.signal.throwIfAborted()
    const assembler = new BlockAssembler()
    let terminal: FinishReason | undefined
    for await (const chunk of prepared.stream(options)) {
      timeout.signal.throwIfAborted()
      if ((chunk.type === 'block-start' && chunk.blockType !== 'text')
        || (chunk.type === 'block-end' && chunk.block.type !== 'text')
        || chunk.type === 'reasoning-delta' || chunk.type === 'tool-call-delta') {
        throw new TranslationError('TRANSLATION_INVALID_RESPONSE', 'Native Flash translation returned non-text output')
      }
      assembler.push(chunk)
      if (chunk.type === 'finish') terminal = chunk.reason
      const text = assembledText(assembler)
      if (Buffer.byteLength(text, 'utf8') > config.maxResponseBytes) {
        throw new TranslationError('TRANSLATION_RESPONSE_LIMIT', 'Native Flash translation exceeds the configured response limit')
      }
    }
    return await deliverTranslation('Native Flash', terminal, assembler, requestSeq, log, timeout.signal, track)
  } catch (error) {
    throw paidRouteFailure('Native Flash', error, signal, timeout.signal)
  } finally {
    unwatch?.()
  }
}
