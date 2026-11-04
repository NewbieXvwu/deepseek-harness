/** Provider, language, and external-service disclosure on the Plugins page. */
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { useEffect, useId } from 'react'
import type { TranslationProvider } from '@deepseek-ai/dsh-experimental-translator/types'
import { Button, SettingsForm, SettingsValueField, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelRouteChoice } from '../preferences.ts'
import { NS, formLabels } from './locales.ts'
import type { TranslationFormInjected } from './preferences-form.ts'
import css from './Translation.module.css'

/** Settings snapshots and explicit refresh callback supplied by the Host mirror. */
export interface TranslationSettingsInjected extends TranslationFormInjected {
  hooks: TranslationFormInjected['hooks'] & {
    availableProviders: HostObservable<readonly TranslationProvider[]>
    modelRoutes: HostObservable<readonly ModelRouteChoice[]>
  }
  /** Refresh native route eligibility without sending reasoning or starting inference. */
  refreshProviders: () => void
}

export type TranslationSettingsProps = PropsRuntime<'plugins.bundle.config'> & PropsLocale<typeof NS> & InjectFace<TranslationSettingsInjected>

function providerLabel(provider: string, t: TranslationSettingsProps['t']): string {
  switch (provider) {
    case 'bing': return t('bing')
    case 'google': return t('google')
    case 'deeplx': return t('deeplx')
    case 'llm': return t('llm')
    case 'deepseek-account': return t('deepseekAccount')
    case 'deepseek-official': return t('deepseekOfficial')
    default: return provider
  }
}

/**
 * Render staged translation preferences and name which text leaves the Host.
 * @param props - current draft fields, accepted-value metadata, and save actions.
 * @returns the bundle's translation preferences.
 */
export function TranslationSettings(props: TranslationSettingsProps) {
  const { t } = props
  const providerId = useId(), languageId = useId(), endpointId = useId(), modelId = useId()
  const state = props.useTranslationForm(value => value)
  const availableProviders = props.useAvailableProviders(value => value)
  const modelRoutes = props.useModelRoutes(value => value)
  useEffect(() => { props.refreshProviders() }, [props.refreshProviders])
  const missingProvider = state.provider.text !== '' && !availableProviders.some(provider => provider === state.provider.text)
  const paid = state.provider.text === 'deepseek-account' || state.provider.text === 'deepseek-official'
  const model = state.provider.text === 'llm'
  const selected = modelRoutes.findIndex(route => route.provider === state.llmProvider.text && route.model === state.llmModel.text)
  const disabled = !state.writable || state.saving
  const notice = paid ? 'paidNotice' : model ? 'modelNotice' : 'anonymousNotice'
  return <SettingsForm labels={formLabels(t)} state={state} onSave={props.save} onDiscard={props.discard}>
    <p className={css.notice}>{t('privacy')}</p>
    <p className={css.notice}>{t(notice)}</p>
    <div className={css.field}>
      <div className={css.toolbar}>
        <label htmlFor={providerId}>{t('provider')}</label>
        {state.provider.overridden && <><Tag tone="neutral">{t('overridden')}</Tag>
          <Button size="sm" disabled={disabled} onClick={() => { props.resetField('provider') }}>{t('reset')}</Button></>}
      </div>
      <select id={providerId} value={state.provider.text} disabled={disabled} aria-invalid={state.provider.invalid || undefined}
        onChange={(event) => { props.edit('provider', event.target.value) }}>
        {missingProvider && <option value={state.provider.text} disabled>{t('providerUnavailableOption', {
          provider: providerLabel(state.provider.text, t),
        })}</option>}
        {availableProviders.map(provider => <option key={provider} value={provider}>{providerLabel(provider, t)}</option>)}
      </select>
      {state.provider.invalid && <p role="status">{t('invalidProvider')}</p>}
      {missingProvider && !state.provider.invalid && <p role="status" className={css.notice}>{t('providerUnavailable')}</p>}
    </div>
    {state.endpointVisible && <SettingsValueField id={endpointId} label={t('deeplxEndpoint')} hint={t('deeplxEndpointHint')}
      {...state.endpoint} overriddenLabel={t('overridden')} resetLabel={t('reset')} invalidLabel={t('invalidEndpoint')}
      disabled={disabled} onEdit={(value) => { props.edit('deeplxEndpoint', value) }} onReset={() => { props.resetField('deeplxEndpoint') }} />}
    {state.modelVisible && <div className={css.field}>
      <div className={css.toolbar}>
        <label htmlFor={modelId}>{t('llmModel')}</label>
        {(state.llmProvider.overridden || state.llmModel.overridden) && <><Tag tone="neutral">{t('overridden')}</Tag>
          <Button size="sm" disabled={disabled}
            onClick={() => { props.resetField('llmProvider'); props.resetField('llmModel') }}>{t('reset')}</Button></>}
      </div>
      <select id={modelId} value={selected < 0 ? '' : String(selected)} disabled={disabled || modelRoutes.length === 0}
        onChange={(event) => {
          const choice = modelRoutes[Number(event.target.value)]
          if (choice === undefined) return
          props.edit('llmProvider', choice.provider)
          props.edit('llmModel', choice.model)
        }}>
        {selected < 0 && state.llmProvider.text === '' && <option value="" disabled>{t('llmModelUnset')}</option>}
        {selected < 0 && state.llmProvider.text !== '' && <option value="" disabled>{t('modelUnavailableOption', {
          model: `${state.llmProvider.text}/${state.llmModel.text}`,
        })}</option>}
        {modelRoutes.map((route, index) =>
          <option key={`${route.provider}/${route.model}`} value={String(index)}>{`${route.providerName} · ${route.modelName}`}</option>)}
      </select>
      <p role="status" className={css.notice}>{modelRoutes.length === 0 ? t('modelRoutesEmpty') : t('llmModelHint')}</p>
    </div>}
    <SettingsValueField id={languageId} label={t('targetLanguage')} hint={t('targetLanguageHint')}
      {...state.targetLanguage} overriddenLabel={t('overridden')} resetLabel={t('reset')} invalidLabel={t('invalidLanguage')}
      disabled={disabled} onEdit={(value) => { props.edit('targetLanguage', value) }} onReset={() => { props.resetField('targetLanguage') }} />
  </SettingsForm>
}
