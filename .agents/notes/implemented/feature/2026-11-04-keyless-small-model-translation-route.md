# Agent Note: A keyless small-model route refuses rather than serves bad translations

Status: implemented

English | [中文](2026-11-04-keyless-small-model-translation-route.zh.md)

## Problem

The reasoning-translation panel offered three keyless endpoints — Bing, Google, self-hosted DeepLX — and two paid model choices. ChatJimmy is a fourth keyless option: a shared hosted service that answers `POST /api/chat` with plain text and needs no credential. Its default model is a legacy 8B instruction model, measured here at roughly one request per second and about twenty requests per minute before `HTTP 429`. That model fails in ways the other routes never do: it answers an imperative fragment instead of translating it, prefixes a courtesy, wraps the reply in the prompt's own delimiters, switches between Simplified and Traditional glyphs, drops half a sentence, or continues writing past it. A sample run of the naive single-line instruction — the wording the anonymous routes use — left 18 of 71 adversarial sentences untranslated, repeated, or otherwise unusable. Shipping that as a translation option would put leaked prompt text and hallucinations in front of the reader.

## Decision

`chatjimmy` joins the anonymous provider list and calls the upstream endpoint directly: `{ messages, chatOptions, attachment }` in, plain text with a `<|stats|>…<|/stats|>` telemetry trailer out. It does not go through `ctx.llm`, and the OpenAI-compatible wrapper that circulates for this service is not part of the integration. The [anonymous endpoints decision](../architecture/2026-10-05-anonymous-reasoning-translation.md) owns this provider family, its normalization of destination language, its refusal to switch provider after a failure and its disclosure; this record extends only the list of keyless providers that family covers.

Three measured choices make the route usable:

- **Prompt.** Name the destination script, not just the language — `Simplified Chinese (简体中文)` — put the fragment between `<<< >>>`, and end the turn with `Translation:` as a completion cue. Naming the script removed the Traditional glyph drift; the cue is what stops the model from treating the fragment as a request to answer.
- **Decoding.** `topK: 1` with `temperature: 0`. Greedy sampling measured cleaner than warm sampling on the same prompt, and it makes a cached fragment reproducible.
- **Refusal over repair.** The reply is unwrapped of a copied delimiter or label, then refused — `TRANSLATION_INVALID_RESPONSE` — if it is left in the source language, repeats or contains the fragment, repeats itself, mixes Traditional glyphs into a Simplified request, keeps a prompt marker, is materially shorter or longer than the fragment needs, or reports a finish other than `stop`. Every refused fragment shows the reader the original reasoning.

Measured over 561 English sentences: 540 served with no remaining defect, 19 refused by these guards, 2 lost to upstream transport failures, and zero served replies that leaked the prompt, opened with a courtesy, echoed the fragment, continued it, or stayed in English. The prompt, model id, decoding settings and endpoint fingerprint live in the stored recipe, so a wording or sampling change cannot serve results cached under the old semantics.

## Alternatives considered

**Few-shot examples.** Three worked pairs ahead of the fragment made things worse: the model copied the delimiter pattern into 31 of 71 replies, because the examples teach its format more strongly than any instruction forbids it.

**Instructions in `systemPrompt` with the bare fragment as the user turn.** 73.2% clean versus 91.5% for the cue format, with the model explaining terms rather than translating them — a chat turn gives it the chance to answer.

**Warm sampling on the same prompt.** 90.1% of the adversarial sentences came back usable against 91.5% under greedy decoding, and sampling noise makes a cached fragment's quality irreproducible.

**Silent correction of bad replies.** Padding, re-splitting, or guessing the intended translation would hide a route that does not work; a refusal is a claim the reader can act on by choosing another service.

**Registering the service through `dsh-llm-pi-ai`.** That adapter speaks OpenAI- or Anthropic-compatible JSON, which this endpoint does not: it takes `chatOptions` and answers plain text. Modeling it as a chat-completions provider would also offer it as a conversation model, which its quality does not support.

## Consequences

- The route inherits a free shared quota and its operator's availability. Refusals are expected traffic, not defects, and the panel says the service limits requests and its translations can be inaccurate.
- Text sent to ChatJimmy leaves the machine with no credential and no contract. The privacy notice already covering anonymous endpoints applies, and the deployment owns the address through `chatjimmyEndpoint`.
- A refusal costs one request: unlike the paid routes, no result is cached for a refused fragment, so a retry sends the same text again.
- The character-level guards encode this model's failure modes, not a translation protocol. Another model behind the same endpoint is measured against the corpus in `tests/chatjimmy-quality.e2e.ts` before it is trusted.
