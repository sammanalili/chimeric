# Read usage and prices beside the model picker

The small indicator follows the model selected in that composer. Open it with hover, keyboard focus or a click for details.

For subscriptions, it shows the tightest reported remaining limit, its reset time and when it was observed. Reports are bound to the connection, account session and exact model. Missing reports remain unavailable. Reports become stale after five minutes or their reset time. Reading this display calls Chimeric's local endpoint; it does not send a prompt or poll a provider.

ChatGPT quota currently comes from response headers during an ordinary model request. Other subscription transports show unavailable until a supported quota observation is implemented. Tracked tokens do not imply a remaining subscription allowance.

For API connections, the indicator shows USD input and output prices per million tokens. Provider metadata must state its units. Reviewed published rates apply only to the exact official endpoint and model, so a reseller never inherits an unrelated price. Unknown prices stay unknown. The detail view identifies the price source and review date.

Chimeric's local request totals and estimated token costs are separate from account quota and the provider's bill. Estimates use reported, separate input, output and cache token categories. A request without a required price makes the total incomplete. Tools, image generation, taxes, regional processing, negotiated rates and processing tiers can change the bill. The supplied GPT-6.1 Sol rate includes its documented long-context multiplier, but assumes standard global processing and the listed cache-retention rate.

Reviewed price sources:

- [OpenAI GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol), checked 2026-11-20.
- [Claude Fable 5.2](https://platform.claude.com/docs/en/models/fable-5-2/overview), checked 2026-11-20.

Custom API rates use authenticated `PUT /api/local/usage/pricing`, with `expectedRevision`, the qualified `model` ID, and `pricing` containing `currency: "USD"`, `inputPerMillion`, `outputPerMillion`, and optional cache rates. Setting `pricing: null` restores provider/published lookup. Subscription connections cannot be assigned API prices. The native session and CSRF checks still apply.

Accounting stores counts, rates and keyed request digests locally. It does not store prompts, access tokens, raw account-session identifiers or raw request identifiers. A damaged optional accounting store is preserved and reported as unavailable; it does not stop research or overwrite the original bytes.

The compact badge stays beside the model picker. Its details include **Edit API prices** for custom USD rates per million tokens. Input and output rates are required; cache rates can stay unknown. Saving uses a revision check, so an old edit cannot overwrite a newer price. **Clear custom prices** restores available provider or published metadata. These settings change Chimeric estimates only. They do not change a provider bill or a subscription allowance.
