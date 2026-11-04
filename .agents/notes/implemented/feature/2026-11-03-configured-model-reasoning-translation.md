# Agent Note: Reasoning translation can use one configured model route

Status: implemented

English | [中文](2026-11-03-configured-model-reasoning-translation.zh.md)

## Problem

The [paid native Flash decision](../architecture/2026-10-05-paid-native-flash-reasoning-translation.md) limited model-based translation to two built-in DeepSeek credential routes, because a fragment sent to an arbitrary configured model concealed who received it and which billing surface paid for it. Deployments that chat through an OpenAI- or Anthropic-compatible gateway, a self-hosted endpoint, or any other route registered by [`dsh-llm-pi-ai`](../../../../packages/llm/llm-pi-ai/README.md) therefore had no model-based translation at all, and readers who already trust that route for their conversation could not extend that trust to reasoning display. The facts that motivated the restriction now have counterparts in the shipped composition: the Models page registers every configurable route with its own credential reference and model catalog, so a receiver is a named deployment choice rather than an open-ended string, and the reasoning-translation panel is where the reader accepts the cost.

## Decision

Translation offers a third paid choice, `llm`, beside `deepseek-account` and `deepseek-official`. The reader picks one `(provider, model)` pair from the Host's model catalog in the same panel that discloses billing; the pair is stored as the translator entry's volatile `llmProvider` and `llmModel`, so every translator consumer in the deployment shares one configured route. While both names are empty, discovery lists `llm` as soon as some registered provider holds none of the reserved identities, because the panel is where a route is first picked; a stored pair has to name a live route before it is listed again.

A request qualifies only while the pair names a live route: the provider is registered with `ctx.llm`, its Loader entry is active, the settings section that declares it names a credential which is configured — or names none — and the provider's catalog carries the exact model id. `google`, `bing`, `deeplx`, `deepseek-account`, and `deepseek-official` are refused as route names, so each billing surface keeps one identity; `chatjimmy` joined that refusal when it became a [keyless route](2026-11-04-keyless-small-model-translation-route.md). Admission is re-checked after the credential and catalog reads, before dispatch, and again after the request record is durable, because durable storage can outlast the route that was admitted.

Thinking is negotiated per model: `off` when the model advertises it, otherwise its lowest advertised level, otherwise no reasoning control at all. A model that keeps thinking has its reasoning output discarded — never assembled, stored, or displayed — while the provider still bills it, which the panel states before the choice is saved.

The fragment, the fixed literal-translation instruction, and the absence of history and tools are unchanged from the built-in routes, so one cached translation stays comparable across routes only in form, not in identity: a model-route recipe carries the provider and model id, while both built-in recipes stay byte-identical to the ones shipped before this choice. An upgrade therefore cannot re-bill a saved built-in translation, and a saved translation is never shown for a different model.

## Alternatives considered

**Reuse the conversation's own model route.** Its history, compaction state, and generation controls belong to a different request, and the translator's single-fragment contract would have to be renegotiated per provider. A named route keeps the query one fragment plus one instruction.

**Configure one free-form model name without its provider.** Model ids collide across providers, and the credential and catalog facts that decide eligibility are per provider, so the pair is the smallest honest address.

**Treat any reasoning output as an invalid response.** Gateways that ignore a thinking switch would then fail every fragment on models that cannot disable thinking, which is the majority of the reasoning-capable catalog. Discarding the output and disclosing its cost keeps those routes usable.

**Extend the built-in Flash route to any provider that reports a `deepseek-flash` model.** That would silently move billing from an explicitly chosen DeepSeek credential to whatever route answered, which is the concealment the earlier decision rejected.

**Default to Bing when the configured route is unavailable.** A reader who accepted paid translation for a fragment would get a different receiver's output without asking for it. `availableProviders()` withdraws the choice instead, and saved results stay readable.

## Consequences

A deployment with a configured route pays for it per uncached fragment, and thinking that cannot be disabled is billed unseen; the panel's notice and the per-model recipe are the disclosures. Switching models re-translates, so a retarget costs again. Model-catalog discovery resolves every provider's models, so the panel reads it only while the Host offers `llm`, after the built-in routes, and a slow or failing read withdraws the choice rather than failing the list. Volatile fields cannot keep a schema transform, so an address or route name is validated when a request reads it, not when the document parses. No route falls back to another, and this note supersedes only the rejection of offering more than the two built-in labels; the built-in routes' exact `deepseek-flash` membership, their credential checks, and their exclusion of configured routes from that identity remain as decided.
