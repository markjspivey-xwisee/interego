## 2026-11-20 — Practice Evidence: the bridge's own model may be OpenAI's

The bridge's own model route (the other person in typed practice, a judgment, a
scenario draft) spoke only to Anthropic's Messages API. The owner chose OpenAI
for judging saved live calls, having an OpenAI account for the voice already.

`PEV_LLM_PROVIDER=openai` makes that route OpenAI's Responses API, with
`PEV_LLM_API_KEY` and `PEV_LLM_MODEL` as before. Unset, it is Anthropic, as it
was. Any other value and the bridge does not start: the provider is not guessed
from a key or a model's name, because a key sent to the other provider is a key
disclosed. For the same reason `ANTHROPIC_API_KEY` is read only for Anthropic
and the speech key is never used for this route.

The request is `{model, instructions, input, max_output_tokens, store: false}`:
no sampling or reasoning parameters and no fallback, as with Anthropic, and the
provider is asked not to keep the response. A judgment or turn discloses
`provider: openai` and the model the provider says ran. A response cut off at
the token cap, filtered, or declined is reported in the words the bridge already
acts on, and nothing is recorded. An exhausted OpenAI quota, which arrives as a
429, is reported as a billing problem and not as a rate limit.

The HTTP handling the two providers share (retries, timeouts, the budget, key
scrubbing) is now one function; what is sent to Anthropic and read back is
unchanged.

Not changed: a per-request key is still used with Anthropic. Not tested:
anything against OpenAI; the shapes are from its API reference as read on
2026-11-20. The README says the hosted service sets no model key for this
route; whether it now does is the operator's decision and is not made here.
