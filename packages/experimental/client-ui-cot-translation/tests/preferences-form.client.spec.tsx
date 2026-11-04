// @vitest-environment jsdom
/** Preferences remain staged until one explicit Settings save. */
import type { TranslationProvider } from '@deepseek-ai/dsh-experimental-translator/types'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate, stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { TranslationPreferencesForm, type TranslationFormInjected } from '../src/client/preferences-form.ts'
import { TranslationSettings, type TranslationSettingsProps } from '../src/client/TranslationSettings.tsx'
import type { CotTranslationPreferences, ModelRouteChoice, TranslatorPreference } from '../src/preferences.ts'
import { en, zh, formLabels } from '../src/client/locales.ts'

afterEach(cleanup)

/** Render the page over one form's injected state, the services it offers, and the model routes it serves. */
function renderSettings(injected: TranslationFormInjected, providers: SnapshotStore<readonly TranslationProvider[]>,
  routes: SnapshotStore<readonly ModelRouteChoice[]>) {
  const { hooks, ...actions } = injected
  const t: TranslationSettingsProps['t'] = makeTranslate(en)
  const refreshProviders = vi.fn()
  const props = { view: 'page' as const, ...actions, refreshProviders,
    useTranslationForm: bindSnapshotSelector(hooks.translationForm), useAvailableProviders: bindSnapshotSelector(providers),
    useModelRoutes: bindSnapshotSelector(routes), t } as TranslationSettingsProps
  return { view: render(<TranslationSettings {...props} />), props, actions, hooks, providers, routes, refreshProviders }
}

const DEFAULT_ENDPOINT = 'http://127.0.0.1:22330/translate'

/** Translator entry as the Host serves it: the deployment address and no chosen model route. */
const DEFAULT_SECTION = { deeplxEndpoint: DEFAULT_ENDPOINT, llmProvider: '', llmModel: '' }

const ROUTES: readonly ModelRouteChoice[] = [{ provider: 'gateway', providerName: 'Gateway', model: 'flash-lite', modelName: 'Flash Lite' },
  { provider: 'lab', providerName: 'Local Lab', model: 'mini', modelName: 'Mini' }]

/** Preferences the Host serves for this plugin, stored at the given revision. */
function selection(provider: TranslationProvider, revision: number) {
  return { status: 'ready' as const, value: { provider, targetLanguage: 'auto' },
    base: { provider, targetLanguage: 'auto' }, user: {}, writable: true, revision }
}

/** Translator entry the Host serves, with an optional stored override. */
function translatorEntry(revision: number, value = DEFAULT_SECTION, user: Partial<TranslatorPreference> = {}) {
  return { status: 'ready' as const, value, base: DEFAULT_SECTION, user, writable: true, revision }
}

const providersOf = (...providers: TranslationProvider[]) => createSnapshotStore<readonly TranslationProvider[]>(providers)
const routesOf = (routes: readonly ModelRouteChoice[]) => createSnapshotStore<readonly ModelRouteChoice[]>(routes)

it('stages provider and language together, rejects malformed codes, and resets the language', async () => {
  const scope = stubConfigForm<CotTranslationPreferences>(), translator = stubConfigForm<TranslatorPreference>()
  scope.publish(selection('bing', 7))
  const form = new TranslationPreferencesForm(scope.scope, translator.scope)
  const { view } = renderSettings(form.inject(), providersOf('bing', 'google'), routesOf([]))
  expect(view.getByLabelText(en.provider)).toHaveProperty('value', 'bing')
  expect(view.getByLabelText(en.targetLanguage)).toHaveProperty('value', 'auto')
  expect(view.getByText(en.privacy)).toBeTruthy()
  fireEvent.change(view.getByLabelText(en.provider), { target: { value: 'google' } })
  fireEvent.change(view.getByLabelText(en.targetLanguage), { target: { value: 'invalid code!' } })
  expect(view.getByRole('button', { name: en.save })).toHaveProperty('disabled', true)
  expect(scope.mutate).not.toHaveBeenCalled()
  fireEvent.change(view.getByLabelText(en.targetLanguage), { target: { value: 'zh-Hant' } })
  fireEvent.click(view.getByRole('button', { name: en.save }))
  await vi.waitFor(() => { expect(scope.mutate).toHaveBeenCalledWith([
    { op: 'set', path: ['provider'], value: 'google' }, { op: 'set', path: ['targetLanguage'], value: 'zh-Hant' },
  ], 7) })
  fireEvent.change(view.getByLabelText(en.targetLanguage), { target: { value: 'ja' } })
  fireEvent.click(view.getAllByRole('button', { name: en.reset }).at(-1)!)
  expect(view.getByLabelText(en.targetLanguage)).toHaveProperty('value', 'auto')
  view.unmount()
  form.dispose()
  expect(scope.listenerCount()).toBe(0)
})

it('uses the shared unavailable and read-only states and supplies every dictionary', () => {
  const scope = stubConfigForm<CotTranslationPreferences>(), translator = stubConfigForm<TranslatorPreference>()
  const form = new TranslationPreferencesForm(scope.scope, translator.scope)
  try {
    expect(Object.keys(en)).toEqual(Object.keys(zh))
    expect(formLabels(makeTranslate(zh)).save).toBe('保存')
    const { view, props } = renderSettings(form.inject(), providersOf('bing', 'google'), routesOf([]))
    expect(view.getByText(en.unavailable)).toBeTruthy()
    scope.publish({ status: 'ready', value: { provider: 'bing', targetLanguage: 'auto' } })
    view.rerender(<TranslationSettings {...props} />)
    expect(view.getByText(en.readOnly)).toBeTruthy()
    expect(view.getByLabelText(en.provider)).toHaveProperty('disabled', true)
  } finally { form.dispose() }
})

it('reports provider overrides, rejects an invalid draft, and resets to the inherited choice', async () => {
  const scope = stubConfigForm<CotTranslationPreferences>(), translator = stubConfigForm<TranslatorPreference>()
  scope.publish({ ...selection('google', 3), base: { provider: 'bing', targetLanguage: 'auto' }, user: { provider: 'google' } })
  const form = new TranslationPreferencesForm(scope.scope, translator.scope)
  const { view, props, actions, hooks } = renderSettings(form.inject(), providersOf('bing', 'google'), routesOf([]))
  try {
    expect(view.getByText(en.overridden)).toBeTruthy()
    expect(view.getByRole('button', { name: en.reset })).toBeTruthy()
    actions.edit('provider', 'bing')
    expect(hooks.translationForm.getSnapshot().invalid).toBe(false)
    actions.edit('provider', 'unsupported')
    view.rerender(<TranslationSettings {...props} />)
    expect(view.getByText(en.invalidProvider)).toBeTruthy()
    expect(view.getByRole('button', { name: en.save })).toHaveProperty('disabled', true)
    actions.discard()
    view.rerender(<TranslationSettings {...props} />)
    fireEvent.click(view.getByRole('button', { name: en.reset }))
    expect(view.getByLabelText(en.provider)).toHaveProperty('value', 'bing')
    fireEvent.click(view.getByRole('button', { name: en.save }))
    await vi.waitFor(() => { expect(scope.mutate).toHaveBeenCalledWith([{ op: 'unset', path: ['provider'] }], 3) })
    actions.edit('provider', '')
    expect(hooks.translationForm.getSnapshot().invalid).toBe(false)
  } finally { view.unmount(); form.dispose() }
})

it('offers both version-free paid routes only when eligible and keeps selection staged until Save', async () => {
  const scope = stubConfigForm<CotTranslationPreferences>(), translator = stubConfigForm<TranslatorPreference>()
  scope.publish(selection('bing', 4))
  const form = new TranslationPreferencesForm(scope.scope, translator.scope)
  const { view, props, hooks, refreshProviders } = renderSettings(form.inject(),
    providersOf('bing', 'google', 'deepseek-account', 'deepseek-official'), routesOf([]))
  try {
    expect(refreshProviders).toHaveBeenCalledOnce()
    expect(view.getByLabelText(en.provider)).toHaveProperty('value', 'bing')
    expect(view.getByRole('option', { name: en.deepseekAccount })).toBeTruthy()
    expect(view.getByRole('option', { name: en.deepseekOfficial })).toBeTruthy()
    expect(en.deepseekAccount).not.toMatch(/v?4\.1/)
    expect(view.getByText(en.anonymousNotice)).toBeTruthy()
    expect(view.queryByText(en.paidNotice)).toBeNull()
    fireEvent.change(view.getByLabelText(en.provider), { target: { value: 'deepseek-account' } })
    expect(view.getByText(en.paidNotice)).toBeTruthy()
    expect(en.paidNotice).toContain('Each uncached fragment sends a separate paid')
    expect(en.paidNotice).toContain('Reopening reasoning reuses saved results')
    expect(zh.paidNotice).toContain('每个未缓存片段')
    expect(zh.paidNotice).toContain('重新展开会复用已保存的译文')
    expect(view.queryByText(en.anonymousNotice)).toBeNull()
    expect(scope.mutate).not.toHaveBeenCalled()
    fireEvent.click(view.getByRole('button', { name: en.save }))
    await vi.waitFor(() => { expect(scope.mutate).toHaveBeenCalledWith([{ op: 'set', path: ['provider'], value: 'deepseek-account' }], 4) })
    fireEvent.change(view.getByLabelText(en.provider), { target: { value: 'deepseek-official' } })
    expect(hooks.translationForm.getSnapshot().invalid).toBe(false)
    view.rerender(<TranslationSettings {...props} />)
    expect(view.getByText(en.paidNotice)).toBeTruthy()
  } finally { view.unmount(); form.dispose() }
})

it('offers ChatJimmy as a keyless service without an address or model row', () => {
  const scope = stubConfigForm<CotTranslationPreferences>(), translator = stubConfigForm<TranslatorPreference>()
  scope.publish(selection('bing', 8))
  translator.publish(translatorEntry(5))
  const form = new TranslationPreferencesForm(scope.scope, translator.scope)
  const { view, props, hooks } = renderSettings(form.inject(), providersOf('bing', 'google', 'deeplx', 'chatjimmy'), routesOf([]))
  try {
    expect(view.getByRole('option', { name: en.chatjimmy })).toHaveProperty('value', 'chatjimmy')
    expect(en.anonymousNotice).toContain('ChatJimmy')
    expect(zh.anonymousNotice).toContain('ChatJimmy')
    fireEvent.change(view.getByLabelText(en.provider), { target: { value: 'chatjimmy' } })
    view.rerender(<TranslationSettings {...props} />)
    // The deployment owns this address and its model id, so the panel stages the service choice alone.
    expect(view.queryByLabelText(en.deeplxEndpoint)).toBeNull()
    expect(view.queryByLabelText(en.llmModel)).toBeNull()
    expect(view.getByText(en.anonymousNotice)).toBeTruthy()
    expect(hooks.translationForm.getSnapshot().provider.text).toBe('chatjimmy')
    expect(hooks.translationForm.getSnapshot().endpointVisible).toBe(false)
    expect(hooks.translationForm.getSnapshot().modelVisible).toBe(false)
  } finally { view.unmount(); form.dispose() }
})

it('lists DeepLX as a keyless service and offers the model picker only over routes the Host serves', () => {
  const scope = stubConfigForm<CotTranslationPreferences>(), translator = stubConfigForm<TranslatorPreference>()
  scope.publish(selection('bing', 8))
  translator.publish(translatorEntry(5))
  const form = new TranslationPreferencesForm(scope.scope, translator.scope)
  const { view, props, routes, hooks } = renderSettings(form.inject(), providersOf('bing', 'google', 'deeplx', 'llm'), routesOf([]))
  try {
    expect(view.getByRole('option', { name: en.deeplx })).toHaveProperty('value', 'deeplx')
    expect(view.getByRole('option', { name: en.llm })).toHaveProperty('value', 'llm')
    expect(en.anonymousNotice).toContain('DeepLX')
    expect(zh.anonymousNotice).toContain('DeepLX')
    expect(view.queryByLabelText(en.llmModel)).toBeNull()
    fireEvent.change(view.getByLabelText(en.provider), { target: { value: 'llm' } })
    view.rerender(<TranslationSettings {...props} />)
    expect(view.getByText(en.modelNotice)).toBeTruthy()
    expect(zh.modelNotice).toContain('无法关闭思考')
    expect(view.getByLabelText(en.llmModel)).toHaveProperty('disabled', true)
    expect(view.getByText(en.modelRoutesEmpty)).toBeTruthy()
    // No served route can answer a change, so the picker stages nothing.
    const staged = hooks.translationForm.getSnapshot()
    fireEvent.change(view.getByLabelText(en.llmModel), { target: { value: '0' } })
    expect(hooks.translationForm.getSnapshot()).toBe(staged)
    act(() => { routes.set(ROUTES) })
    view.rerender(<TranslationSettings {...props} />)
    expect(view.queryByText(en.modelRoutesEmpty)).toBeNull()
    expect(view.getByText(en.llmModelHint)).toBeTruthy()
    expect(view.getByRole('option', { name: 'Gateway · Flash Lite' })).toHaveProperty('value', '0')
    expect(view.getByRole('option', { name: 'Local Lab · Mini' })).toHaveProperty('value', '1')
    expect(view.getByLabelText(en.llmModel)).toHaveProperty('disabled', false)
  } finally { view.unmount(); form.dispose() }
})

it('keeps an unavailable paid choice disabled and offers repair or an explicit reset without selecting a free fallback', () => {
  const scope = stubConfigForm<CotTranslationPreferences>(), translator = stubConfigForm<TranslatorPreference>()
  scope.publish({ ...selection('deepseek-official', 6), base: { provider: 'bing', targetLanguage: 'auto' },
    user: { provider: 'deepseek-official' } })
  const form = new TranslationPreferencesForm(scope.scope, translator.scope)
  const availability = providersOf('bing', 'google')
  const { view, props, hooks } = renderSettings(form.inject(), availability, routesOf([]))
  try {
    expect(view.getByLabelText(en.provider)).toHaveProperty('value', 'deepseek-official')
    expect(view.getByRole('option', { name: `${en.deepseekOfficial} — unavailable` })).toHaveProperty('disabled', true)
    expect(view.queryByRole('option', { name: en.deepseekAccount })).toBeNull()
    expect(view.getByText(en.providerUnavailable)).toBeTruthy()
    expect(view.getByText(en.paidNotice)).toBeTruthy()
    expect(scope.mutate).not.toHaveBeenCalled()
    act(() => { availability.set(['bing', 'google', 'deepseek-official']) })
    view.rerender(<TranslationSettings {...props} />)
    expect(view.getByLabelText(en.provider)).toHaveProperty('value', 'deepseek-official')
    expect(view.getByRole('option', { name: en.deepseekOfficial })).toHaveProperty('disabled', false)
    expect(view.queryByText(en.providerUnavailable)).toBeNull()
    expect(scope.mutate).not.toHaveBeenCalled()
    fireEvent.click(view.getByRole('button', { name: en.reset }))
    view.rerender(<TranslationSettings {...props} />)
    expect(view.getByLabelText(en.provider)).toHaveProperty('value', 'bing')
    expect(view.getByText(en.anonymousNotice)).toBeTruthy()
    expect(hooks.translationForm.getSnapshot().dirty).toBe(true)
  } finally { view.unmount(); form.dispose() }
})

it('shows the address row only for the staged DeepLX service and writes the translator entry before the service choice', async () => {
  const scope = stubConfigForm<CotTranslationPreferences>(), translator = stubConfigForm<TranslatorPreference>()
  scope.publish(selection('bing', 9))
  const form = new TranslationPreferencesForm(scope.scope, translator.scope)
  const { view, props, actions, hooks } = renderSettings(form.inject(), providersOf('bing', 'google', 'deeplx'), routesOf([]))
  try {
    expect(view.queryByLabelText(en.deeplxEndpoint)).toBeNull()
    translator.publish(translatorEntry(5))
    view.rerender(<TranslationSettings {...props} />)
    expect(view.queryByLabelText(en.deeplxEndpoint)).toBeNull()
    act(() => { actions.edit('provider', 'deeplx') })
    view.rerender(<TranslationSettings {...props} />)
    expect(view.getByLabelText(en.deeplxEndpoint)).toHaveProperty('value', DEFAULT_ENDPOINT)
    expect(view.getByText(en.deeplxEndpointHint)).toBeTruthy()
    const writes: string[] = []
    translator.mutate.mockImplementation((ops, revision) => { writes.push(`translator ${JSON.stringify([ops, revision])}`); return Promise.resolve(true) })
    scope.mutate.mockImplementation((ops, revision) => { writes.push(`selection ${JSON.stringify([ops, revision])}`); return Promise.resolve(true) })
    fireEvent.change(view.getByLabelText(en.deeplxEndpoint), { target: { value: 'not an endpoint' } })
    view.rerender(<TranslationSettings {...props} />)
    expect(view.getByText(en.invalidEndpoint)).toBeTruthy()
    expect(view.getByRole('button', { name: en.save })).toHaveProperty('disabled', true)
    expect(writes).toEqual([])
    fireEvent.change(view.getByLabelText(en.deeplxEndpoint), { target: { value: 'https://deeplx.example.test/translate' } })
    expect(hooks.translationForm.getSnapshot().invalid).toBe(false)
    fireEvent.change(view.getByLabelText(en.deeplxEndpoint), { target: { value: 'http://192.168.1.9:22330/translate' } })
    fireEvent.click(view.getByRole('button', { name: en.save }))
    await vi.waitFor(() => { expect(writes).toEqual([
      `translator ${JSON.stringify([[{ op: 'set', path: ['deeplxEndpoint'], value: 'http://192.168.1.9:22330/translate' }], 5])}`,
      `selection ${JSON.stringify([[{ op: 'set', path: ['provider'], value: 'deeplx' }], 9])}`,
    ]) })
    expect(hooks.translationForm.getSnapshot().dirty).toBe(false)
  } finally { view.unmount(); form.dispose() }
  expect(scope.listenerCount()).toBe(0)
  expect(translator.listenerCount()).toBe(0)
})

it('keeps an unusable address draft on screen after the service moves off DeepLX, and saves a corrected one', async () => {
  const scope = stubConfigForm<CotTranslationPreferences>(), translator = stubConfigForm<TranslatorPreference>()
  scope.publish(selection('deeplx', 9))
  translator.publish(translatorEntry(5))
  const form = new TranslationPreferencesForm(scope.scope, translator.scope)
  const { view, props, actions, hooks } = renderSettings(form.inject(), providersOf('bing', 'google', 'deeplx'), routesOf([]))
  try {
    fireEvent.change(view.getByLabelText(en.deeplxEndpoint), { target: { value: 'not an endpoint' } })
    act(() => { actions.edit('provider', 'bing') })
    view.rerender(<TranslationSettings {...props} />)
    // A draft the translator would reject stays on screen, so its refusal never blocks the panel without a cause.
    expect(view.getByLabelText(en.deeplxEndpoint)).toHaveProperty('value', 'not an endpoint')
    expect(view.getByText(en.invalidEndpoint)).toBeTruthy()
    expect(view.getByRole('button', { name: en.save })).toHaveProperty('disabled', true)
    fireEvent.change(view.getByLabelText(en.deeplxEndpoint), { target: { value: 'http://192.168.1.9:22330/translate' } })
    view.rerender(<TranslationSettings {...props} />)
    expect(view.queryByLabelText(en.deeplxEndpoint)).toBeNull()
    expect(hooks.translationForm.getSnapshot().dirty).toBe(true)
    fireEvent.click(view.getByRole('button', { name: en.save }))
    await vi.waitFor(() => { expect(translator.mutate).toHaveBeenCalledWith(
      [{ op: 'set', path: ['deeplxEndpoint'], value: 'http://192.168.1.9:22330/translate' }], 5) })
    await vi.waitFor(() => { expect(scope.mutate).toHaveBeenCalledWith([{ op: 'set', path: ['provider'], value: 'bing' }], 9) })
  } finally { view.unmount(); form.dispose() }
})

it('stops before the service choice when the translator refuses an edit, and keeps both drafts', async () => {
  const scope = stubConfigForm<CotTranslationPreferences>(), translator = stubConfigForm<TranslatorPreference>()
  scope.publish(selection('bing', 9))
  translator.publish(translatorEntry(5))
  translator.mutate.mockImplementation(() => Promise.resolve(false))
  const form = new TranslationPreferencesForm(scope.scope, translator.scope)
  const { view, props, actions, hooks } = renderSettings(form.inject(), providersOf('bing', 'google', 'deeplx'), routesOf([]))
  try {
    act(() => {
      actions.edit('provider', 'deeplx')
      actions.edit('deeplxEndpoint', 'http://192.168.1.9:22330/translate')
    })
    fireEvent.click(view.getByRole('button', { name: en.save }))
    await vi.waitFor(() => { expect(hooks.translationForm.getSnapshot().failed).toBe(true) })
    expect(scope.mutate).not.toHaveBeenCalled()
    view.rerender(<TranslationSettings {...props} />)
    expect(view.getByText(en.saveFailed)).toBeTruthy()
    expect(hooks.translationForm.getSnapshot().provider.text).toBe('deeplx')
    act(() => { actions.discard() })
    expect(hooks.translationForm.getSnapshot().dirty).toBe(false)
  } finally { view.unmount(); form.dispose() }
})

it('saves a chosen model route before the service choice that selects it', async () => {
  const scope = stubConfigForm<CotTranslationPreferences>(), translator = stubConfigForm<TranslatorPreference>()
  scope.publish(selection('bing', 9))
  translator.publish(translatorEntry(5))
  const form = new TranslationPreferencesForm(scope.scope, translator.scope)
  const { view, props, hooks } = renderSettings(form.inject(), providersOf('bing', 'google', 'llm'), routesOf(ROUTES))
  try {
    fireEvent.change(view.getByLabelText(en.provider), { target: { value: 'llm' } })
    view.rerender(<TranslationSettings {...props} />)
    const model = view.getByLabelText(en.llmModel)
    expect(model).toHaveProperty('value', '')
    expect(view.getByRole('option', { name: en.llmModelUnset })).toHaveProperty('disabled', true)
    fireEvent.change(model, { target: { value: '1' } })
    expect(hooks.translationForm.getSnapshot().dirty).toBe(true)
    view.rerender(<TranslationSettings {...props} />)
    expect(model).toHaveProperty('value', '1')
    fireEvent.click(view.getByRole('button', { name: en.save }))
    await vi.waitFor(() => { expect(translator.mutate).toHaveBeenCalledWith([
      { op: 'set', path: ['llmProvider'], value: 'lab' }, { op: 'set', path: ['llmModel'], value: 'mini' },
    ], 5) })
    await vi.waitFor(() => { expect(scope.mutate).toHaveBeenCalledWith([{ op: 'set', path: ['provider'], value: 'llm' }], 9) })
    expect(hooks.translationForm.getSnapshot().dirty).toBe(false)
  } finally { view.unmount(); form.dispose() }
})

it('names a stored route the served catalog no longer carries and writes nothing for it', async () => {
  const scope = stubConfigForm<CotTranslationPreferences>(), translator = stubConfigForm<TranslatorPreference>()
  const stored = { ...DEFAULT_SECTION, llmProvider: 'gone', llmModel: 'model' }
  scope.publish(selection('llm', 3))
  translator.publish(translatorEntry(4, stored, { llmProvider: 'gone', llmModel: 'model' }))
  const form = new TranslationPreferencesForm(scope.scope, translator.scope)
  const { view, actions, hooks } = renderSettings(form.inject(), providersOf('bing', 'llm'), routesOf(ROUTES))
  try {
    expect(view.getByText(en.modelUnavailableOption.replace('{model}', 'gone/model'))).toBeTruthy()
    expect(view.getByLabelText(en.llmModel)).toHaveProperty('disabled', false)
    expect(view.getByText(en.overridden)).toBeTruthy()
    act(() => { actions.edit('targetLanguage', 'ja') })
    expect(hooks.translationForm.getSnapshot().invalid).toBe(false)
    fireEvent.click(view.getByRole('button', { name: en.save }))
    await vi.waitFor(() => { expect(scope.mutate).toHaveBeenCalledWith([{ op: 'set', path: ['targetLanguage'], value: 'ja' }], 3) })
    expect(translator.mutate).not.toHaveBeenCalled()
  } finally { view.unmount(); form.dispose() }
})

it('resets both halves of a stored route back to the inherited selection', async () => {
  const scope = stubConfigForm<CotTranslationPreferences>(), translator = stubConfigForm<TranslatorPreference>()
  const stored = { ...DEFAULT_SECTION, llmProvider: 'gateway', llmModel: 'flash-lite' }
  scope.publish(selection('llm', 3))
  translator.publish(translatorEntry(4, stored, { llmProvider: 'gateway', llmModel: 'flash-lite' }))
  const form = new TranslationPreferencesForm(scope.scope, translator.scope)
  const { view, props, hooks } = renderSettings(form.inject(), providersOf('bing', 'llm'), routesOf(ROUTES))
  try {
    expect(view.getByLabelText(en.llmModel)).toHaveProperty('value', '0')
    fireEvent.click(view.getByRole('button', { name: en.reset }))
    view.rerender(<TranslationSettings {...props} />)
    expect(hooks.translationForm.getSnapshot().dirty).toBe(true)
    fireEvent.click(view.getByRole('button', { name: en.save }))
    await vi.waitFor(() => { expect(translator.mutate).toHaveBeenCalledWith([
      { op: 'unset', path: ['llmProvider'] }, { op: 'unset', path: ['llmModel'] }], 4) })
  } finally { view.unmount(); form.dispose() }
})

it('clears a stored address back to the deployment endpoint from the row or an empty draft', async () => {
  const scope = stubConfigForm<CotTranslationPreferences>(), translator = stubConfigForm<TranslatorPreference>()
  const stored = { ...DEFAULT_SECTION, deeplxEndpoint: 'http://10.0.0.2:22330/translate' }
  scope.publish(selection('deeplx', 2))
  translator.publish(translatorEntry(4, stored, { deeplxEndpoint: 'http://10.0.0.2:22330/translate' }))
  const form = new TranslationPreferencesForm(scope.scope, translator.scope)
  const { view, props, actions, hooks } = renderSettings(form.inject(), providersOf('bing', 'google', 'deeplx'), routesOf([]))
  try {
    expect(view.getByText(en.overridden)).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: en.reset }))
    view.rerender(<TranslationSettings {...props} />)
    expect(view.getByLabelText(en.deeplxEndpoint)).toHaveProperty('value', DEFAULT_ENDPOINT)
    fireEvent.click(view.getByRole('button', { name: en.save }))
    await vi.waitFor(() => { expect(translator.mutate).toHaveBeenCalledWith([{ op: 'unset', path: ['deeplxEndpoint'] }], 4) })
    await vi.waitFor(() => { expect(hooks.translationForm.getSnapshot().saving).toBe(false) })
    translator.mutate.mockClear()
    act(() => { actions.edit('deeplxEndpoint', '') })
    expect(hooks.translationForm.getSnapshot().invalid).toBe(false)
    fireEvent.click(view.getByRole('button', { name: en.save }))
    await vi.waitFor(() => { expect(translator.mutate).toHaveBeenCalledWith([{ op: 'unset', path: ['deeplxEndpoint'] }], 4) })
    expect(scope.mutate).not.toHaveBeenCalled()
  } finally { view.unmount(); form.dispose() }
})

it('drops a staged translator draft from the form state once the translator entry stops being served', () => {
  const scope = stubConfigForm<CotTranslationPreferences>(), translator = stubConfigForm<TranslatorPreference>()
  scope.publish(selection('llm', 2))
  translator.publish(translatorEntry(1))
  const form = new TranslationPreferencesForm(scope.scope, translator.scope)
  const { view, props, actions, hooks } = renderSettings(form.inject(), providersOf('bing', 'google', 'llm'), routesOf(ROUTES))
  try {
    expect(view.getByLabelText(en.llmModel)).toBeTruthy()
    act(() => { actions.edit('deeplxEndpoint', 'http://192.168.1.9:22330/translate') })
    expect(hooks.translationForm.getSnapshot().dirty).toBe(true)
    translator.publish({ status: 'unavailable' })
    view.rerender(<TranslationSettings {...props} />)
    expect(view.queryByLabelText(en.llmModel)).toBeNull()
    expect(view.queryByLabelText(en.deeplxEndpoint)).toBeNull()
    expect(hooks.translationForm.getSnapshot().dirty).toBe(false)
    expect(view.getByRole('button', { name: en.save })).toHaveProperty('disabled', true)
  } finally { view.unmount(); form.dispose() }
})
