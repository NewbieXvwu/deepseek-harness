/** Configured-model translation through the shared LLM seam, with reasoning output tolerated. */
import { FiberState, type Context, type Fiber } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-settings'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { BlockAssembler, ReasoningEffortId, type FinishReason, type LlmConfigurableProvider,
  type LlmResolvedModelInfo, type LlmRuntime, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type { Config } from './index.ts'
import type { ModelTranslationSpec, TranslationIdentity } from './types.ts'
import { TranslationError } from './error.ts'
import type { TranslationLog } from './storage.ts'
import { assembledText, auditedFragment, awaitMetadata, deliverTranslation, logEmptyFragment, paidRouteFailure } from './model-route.ts'

/**
 * Routes a model choice must not name: the anonymous endpoints own their own selection, and the two built-in DeepSeek
 * routes own their billing identity, so a configured model may not reach either under a second name.
 */
const RESERVED_ROUTES: readonly string[] = ['google', 'bing', 'deeplx', 'chatjimmy', 'deepseek-account', 'deepseek-official']

/** One live model route, pinned to the provider entry and credential that make it usable. */
interface ModelOwner {
  llm: LlmRuntime
  fiber: Fiber
  provider: string
  model: string
  /** Settings namespace and section path that declare this provider, compared to detect a retarget. */
  settingsNs: string
  settingsPath: string
  /** Credential the settings document names for the route; absent when it declares none. */
  apiKeyRef?: string
}

/** What the settings document says about one provider row's credential. */
type RouteCredential = { state: 'declared'; ref: string } | { state: 'none' } | { state: 'unknown' }

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read the credential reference a provider row declares, from the settings document the Host serves.
 *
 * The row's path names a volatile settings subtree, so only the document's plain values can be walked. A route whose
 * section cannot be read is unknown rather than keyless, and is never offered.
 * @param ctx - translator context with an optional settings service.
 * @param row - directory entry of the selected provider.
 * @returns the declared reference, an explicit keyless route, or an unreadable route.
 */
function routeCredential(ctx: Context, row: LlmConfigurableProvider): RouteCredential {
  const settings = ctx.get('settings')
  if (settings === undefined) return { state: 'unknown' }
  let value: unknown = settings.describe({ redactSecrets: true }).find(entry => entry.ns === row.settingsNs)?.value
  for (const key of row.settingsPath) value = object(value) ? Reflect.get(value, key) : undefined
  if (!object(value)) return { state: 'unknown' }
  const ref: unknown = Reflect.get(value, 'apiKeyEnv')
  return typeof ref === 'string' && ref !== '' ? { state: 'declared', ref } : { state: 'none' }
}

/**
 * Resolve the configured route's live provider entry and credential without network reads.
 * @param ctx - translator context with optional LLM, loader, and settings services.
 * @param config - volatile route fields.
 * @returns the current owner, or undefined while no usable entry matches the configured names.
 */
function resolveOwner(ctx: Context, config: Config): ModelOwner | undefined {
  const provider = config.llmProvider.get(), model = config.llmModel.get()
  if (provider === '' || model === '' || RESERVED_ROUTES.includes(provider)) return undefined
  const llm = ctx.get('llm'), loader = ctx.get('loader')
  if (llm === undefined || loader === undefined) return undefined
  const row = llm.listConfigurableProviders().find(entry => entry.provider === provider)
  if (row === undefined || !llm.listProviders().some(entry => entry.id === provider)) return undefined
  const entry = [...loader.entries()].find(candidate => candidate.options.id === row.settingsNs)
  if (entry?.fiber === undefined || entry.fiber.state !== FiberState.ACTIVE) return undefined
  const credential = routeCredential(ctx, row)
  if (credential.state === 'unknown') return undefined
  return { llm, fiber: entry.fiber.ctx.fiber, provider, model, settingsNs: row.settingsNs, settingsPath: row.settingsPath.join('\u0000'),
    ...credential.state === 'declared' ? { apiKeyRef: credential.ref } : {} }
}

/**
 * Whether a route still resolves to the same live entry, names, and credential.
 * @param first - the admitted owner.
 * @param second - a freshly resolved owner.
 * @returns whether every admitted fact holds.
 */
function sameOwner(first: ModelOwner, second: ModelOwner): boolean {
  // The runtime is deliberately not compared: `ctx.get()` hands out a caller-scoped view per read, so its identity
  // says nothing about the provider, while the entry fiber's does.
  return first.fiber === second.fiber && first.provider === second.provider
    && first.model === second.model && first.settingsNs === second.settingsNs && first.settingsPath === second.settingsPath
    && first.apiKeyRef === second.apiKeyRef
}

/**
 * Confirm the configured route is usable now: its credential is configured and its catalog carries the exact model.
 * @param ctx - translator context with optional provider services.
 * @param config - route fields and bounds.
 * @param signal - caller and service cancellation.
 * @param track - translator-owned settlement tracking for lookups that cannot accept cancellation.
 * @returns the admitted owner, re-resolved after every await, or undefined when the route cannot serve a request.
 */
async function eligible(ctx: Context, config: Config, signal: AbortSignal,
  track: (work: Promise<unknown>) => void): Promise<ModelOwner | undefined> {
  signal.throwIfAborted()
  const owner = resolveOwner(ctx, config)
  if (owner === undefined) return undefined
  if (owner.apiKeyRef !== undefined) {
    const ref = owner.apiKeyRef
    const credentials = ctx.get('credentials')
    if (credentials === undefined) {
      if ((launchEnvironmentOf(ctx).get(ref)?.value.length ?? 0) === 0) return undefined
    } else if (!(await awaitMetadata(() => credentials.describe(credentialRef(ref)), signal, track)).configured) return undefined
  }
  const catalog = await awaitMetadata(() => owner.llm.listModels(owner.provider), signal, track)
  signal.throwIfAborted()
  if (!catalog.some(model => model.id === owner.model)) return undefined
  const current = resolveOwner(ctx, config)
  return current === undefined || !sameOwner(owner, current) ? undefined : current
}

/**
 * Whether the deployment serves a route a reader could pick: any registered provider that is not one of the choices
 * with their own identity. Availability of the route itself stays an execution result, like a provider directory, so a
 * reader can name a route whose credential they have not stored yet and the panel explains the withheld choice after saving.
 * @param ctx - translator context with an optional LLM runtime.
 * @returns true when an unset route selection still deserves a place in the picker.
 */
function hasPickableRoute(ctx: Context): boolean {
  const llm = ctx.get('llm')
  return llm !== undefined && llm.listProviders().some(entry => !RESERVED_ROUTES.includes(entry.id))
}

/**
 * Whether the panel may list the model route, without reporting a failure for an unset route. Stored names are checked
 * for eligibility; an unset pair lists the route whenever the deployment registers a provider of its own.
 * @param ctx - translator context with optional provider services.
 * @param config - route fields and discovery deadline.
 * @param signal - caller and service cancellation.
 * @param track - translator-owned settlement tracking for lookups that cannot accept cancellation.
 * @returns true when the panel may offer the route; discovery timeout reports unavailable, cancellation propagates.
 */
export async function availableModelRoute(ctx: Context, config: Config, signal: AbortSignal,
  track: (work: Promise<unknown>) => void): Promise<boolean> {
  if (config.llmProvider.get() === '' && config.llmModel.get() === '') return hasPickableRoute(ctx)
  using timeout = deadline(signal, config.llmTimeoutMs, 'TRANSLATION_TIMEOUT')
  try {
    return await eligible(ctx, config, timeout.signal, track) !== undefined
  } catch (_modelRouteDiscoveryFailed) {
    // Discovery is a preview of one route: a slow or failing catalog withdraws the choice instead of failing the list.
    const expired = timeoutOf(timeout.signal, 'TRANSLATION_TIMEOUT')
    if (expired !== undefined && expired !== signal.reason) return false
    timeout.signal.throwIfAborted()
    return false
  }
}

/**
 * Identify one route's translation semantics.
 *
 * A saved translation belongs to its exact provider and model, so a result from one model is never shown for another.
 * The negotiated thinking level follows from the route's catalog entry, so it needs no separate dimension.
 * @param config - configured route and requested output cap.
 * @returns route, prompt revision, and output-cap tuple retained with the result.
 */
export function llmRecipe(config: Config): string {
  return JSON.stringify([config.llmProvider.get(), config.llmModel.get(), 'literal-fragment-v1', config.llmMaxOutputTokens])
}

/**
 * Prefer disabled thinking, then the lowest selectable level, then the model's own default.
 * @param model - captured model metadata of the prepared call.
 * @returns the reasoning control to send, or none when the model exposes no selectable levels.
 */
function reasoningOf(model: Readonly<LlmResolvedModelInfo>): { reasoningEffort?: ReasoningEffortId } {
  const efforts = model.reasoning?.efforts
  if (efforts === undefined) return {}
  for (const id of ['off', 'low'] as const) {
    if (efforts.some(effort => effort.id === id)) return { reasoningEffort: ReasoningEffortId(id) }
  }
  return {}
}

/**
 * Whether a chunk carries output this route translates.
 *
 * A model that cannot disable thinking reasons before answering, and its reasoning is discarded rather than shown to
 * the reader; any other non-text output means the route is not answering a translation request.
 * @param chunk - one streamed chunk.
 * @returns false only for reasoning chunks, which assembly never sees.
 */
function translatable(chunk: StreamChunk): boolean {
  if (chunk.type === 'reasoning-delta') return false
  if (chunk.type === 'block-start') return chunk.blockType !== 'reasoning'
  return !(chunk.type === 'block-end' && chunk.block.type === 'reasoning')
}

/**
 * Audit and dispatch exactly one model translation request.
 * @param ctx - translator context with optional provider services.
 * @param spec - configured route, fragment, languages, and existing Session.
 * @param config - route deadline and output cap, and the shared response-byte limit.
 * @param signal - caller and service cancellation.
 * @param track - translator-owned settlement tracking for lookups that cannot accept cancellation.
 * @param log - common Session storage for this already cache-checked attempt.
 * @param identity - exact fragment, languages, route, and semantic recipe.
 * @returns non-empty text from a stop finish; all other outcomes reject safely.
 */
export async function translateWithModel(ctx: Context, spec: ModelTranslationSpec, config: Config, signal: AbortSignal,
  track: (work: Promise<unknown>) => void, log: TranslationLog, identity: TranslationIdentity): Promise<string> {
  const execution = new AbortController()
  using timeout = deadline(AbortSignal.any([signal, execution.signal]), config.llmTimeoutMs, 'TRANSLATION_TIMEOUT')
  let unwatch: (() => void) | undefined
  try {
    if (spec.text === '') return await logEmptyFragment(log, identity, timeout.signal, track)
    const accepted = await eligible(ctx, config, timeout.signal, track)
    timeout.signal.throwIfAborted()
    if (accepted === undefined) throw new TranslationError('TRANSLATION_UNAVAILABLE', 'Selected model translation route is unavailable')
    unwatch = ctx.on('internal/status', (fiber) => {
      if (fiber === accepted.fiber && fiber.state !== FiberState.ACTIVE) {
        execution.abort(new TranslationError('TRANSLATION_UNAVAILABLE', 'Model translation route was withdrawn'))
      }
    }, { global: true })
    const prepared = await awaitMetadata(
      () => accepted.llm.prepareCall({ provider: accepted.provider, model: accepted.model, maxTokens: config.llmMaxOutputTokens },
        timeout.signal, (controls, model) => ({ ...controls, ...reasoningOf(model) })),
      timeout.signal, track)
    timeout.signal.throwIfAborted()
    if (await eligible(ctx, config, timeout.signal, track) === undefined) {
      throw new TranslationError('TRANSLATION_UNAVAILABLE', 'Model translation route changed before dispatch')
    }
    const { options, requestSeq } = await auditedFragment(prepared.config, spec, identity, log, timeout.signal, track)
    timeout.signal.throwIfAborted()
    // Durable storage can outlast the admitted route, its credential, or its catalog.
    if (await eligible(ctx, config, timeout.signal, track) === undefined) {
      throw new TranslationError('TRANSLATION_UNAVAILABLE', 'Model translation route changed before dispatch')
    }
    timeout.signal.throwIfAborted()
    const assembler = new BlockAssembler()
    let terminal: FinishReason | undefined
    for await (const chunk of prepared.stream(options)) {
      timeout.signal.throwIfAborted()
      if (!translatable(chunk)) continue
      if ((chunk.type === 'block-start' && chunk.blockType !== 'text')
        || (chunk.type === 'block-end' && chunk.block.type !== 'text') || chunk.type === 'tool-call-delta') {
        throw new TranslationError('TRANSLATION_INVALID_RESPONSE', 'Model translation route returned non-text output')
      }
      assembler.push(chunk)
      if (chunk.type === 'finish') terminal = chunk.reason
      if (Buffer.byteLength(assembledText(assembler), 'utf8') > config.maxResponseBytes) {
        throw new TranslationError('TRANSLATION_RESPONSE_LIMIT', 'Model translation exceeds the configured response limit')
      }
    }
    return await deliverTranslation('Model', terminal, assembler, requestSeq, log, timeout.signal, track)
  } catch (error) {
    throw paidRouteFailure('Model', error, signal, timeout.signal)
  } finally {
    unwatch?.()
  }
}
