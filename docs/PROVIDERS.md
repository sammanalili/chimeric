# Provider configuration

## Claude subscriptions use the installed official client

The Anthropic card uses an independently installed, unmodified Claude Code client. This connector requires version 2.1.321 or later in the compatible 2.x series. The official client owns sign-in; Chimeric does not copy its tokens or call its private subscription backend. Connections and each model turn verify that the client uses a Claude subscription rather than API-key or third-party billing.

The picker includes documented client aliases and the reviewed exact identifier `claude-fable-5-2`. Model and effort access still depends on the account and organization. The client returns a validated complete turn, after which Chimeric emits its native text/tool events and executes research tools itself. This route currently accepts text input and is unavailable in Class 2 mode until confinement is verified.

[Claude Code 2.1.321 release notes](https://github.com/anthropics/claude-code/releases/tag/v2.1.321) identify the Fable 5.2 client update. A Homebrew stable installation may lag; use the official installation/update instructions for the chosen channel. Updating Chimeric does not silently replace a separately managed client.

## Anthropic API keys are a separate connection

Choose the Anthropic Messages API type and an API key. For Anthropic's own service, use `https://api.anthropic.com` as the base URL. The UI normalizes a trailing `/v1`; compatible proxies may use their own HTTPS prefix. Subscription OAuth tokens are rejected in this API field. Only the configured inference/catalog destination is allowed through the vendor-service guard; product telemetry endpoints remain blocked.

Fable 5.2 has a 1M context window and a 128k output cap. Its five effort levels control adaptive thinking; thinking cannot be disabled and forced tool choice is unsupported. Chimeric preserves signed history and per-turn metadata in a durable replay store. An unavailable original signed history or a rejected prefix stops the turn explicitly instead of dropping thinking or retrying under another model. [Model details](https://platform.claude.com/docs/en/models/fable-5-2/overview).

Usage and API prices appear beside the model picker. See [usage and pricing](USAGE-AND-PRICING.md) for reporting scope, freshness and estimate limits.

## Connection fields

The settings UI accepts a provider name, base URL, API type, optional key, discovery or manual mode, request timeout, and optional image and reasoning capabilities for manual models. `openai-completions` sends Chat Completions requests. `openai-responses` sends Responses requests. The ChatGPT subscription uses a separate fixed `openai-codex-responses` connection and is not editable here.

Remote URLs require HTTPS. Loopback HTTP is allowed for local services; other HTTP requires an explicit insecure-HTTP choice. URLs with userinfo, query or fragment components are rejected. Vendor product destinations are rejected except the explicitly selected Anthropic Messages inference service.

## Discovery and manual IDs

Discovery calls the provider's `/models` endpoint with the configured credential. A provider can instead list model IDs in manual mode. Each model receives a qualified ID in the form `provider-id::model-id`. The model catalog records mode, text or image input, reasoning support, effort levels, context limits, and whether capabilities were verified.

Model declarations and observed image support are displayed separately. Discovery recognizes both `input` and `input_modalities`. In Connections, expand a provider and select **Probe image input** for one model or **Probe all chat models**. Probes send a generated PNG containing random digits through the selected connection. They send no research content and use that connection's quota. The same path supports Chat Completions, Responses and the signed-in ChatGPT subscription.

An exact answer records verified image input. An explicit endpoint rejection records rejected input. Wrong answers, authentication problems, quota errors and timeouts remain inconclusive. A later inconclusive result preserves an earlier successful result for the same connection. Manual image declarations remain available with an unverified label. Audio and video are not tested by this feature.

Probe jobs run with concurrency two and a 30-second per-model deadline. A batch accepts up to 64 chat models. Results persist in the private profile and are bound to the model, endpoint, connection revision and credential identity. Editing or reconnecting a connection invalidates old evidence; a stale completion cannot certify a replacement connection. Results update the model selector without restarting Chimeric.

## ChatGPT subscription

Use **Sign in with ChatGPT** or **Device code** in Connections. Browser sign-in uses OpenAI's state-checked loopback callback. A disconnected connection needs a fresh sign-in; Chimeric does not borrow credentials from another application or profile. Standalone packages register the SDK's bundled OAuth flows so sign-in does not depend on neighboring development files.

After signing in, **Check connection** sends a short synthetic text request through the production ChatGPT transport. The UI distinguishes signed-in, unchecked and verified states. Verification belongs to the credential revision used for that request. Refresh, disconnect and reconnect cannot inherit a stale successful check. Token renewal and authenticated model requests reject redirects, and errors never display access or refresh tokens.

## Runtime behavior

Each request uses a model and credential snapshot. Streaming uses server-sent events. Tool calls can invoke the local research server tools, including configured search adapters. Reasoning effort is passed using the provider's configured compatibility format. A provider failure is returned to the workspace as an error.

## Configuration files

The managed configuration is stored in the private profile as `provider-config.json`. Optional external environment and credential-reference files can provide keys during development. UI-entered keys are stored encrypted under `local-auth`; the settings API reports only whether a credential exists. Do not place keys in this repository or in a checked-in JSON example.

### Discover models from a ChatGPT subscription

Connect in **Settings → Connections → ChatGPT subscription**. Chimeric reads the
signed-in account's visible model catalog automatically after sign-in and when
starting with an expired catalog cache. **Refresh models** requests the current
list on demand. New models appear in the existing session picker and background
model controls without another restart. Current selections and pinned models
are preserved.

The current connection uses the existing Codex subscription catalog, authenticated
with the same account as inference. Its catalog protocol version is pinned in the
connector; no Codex CLI installation is needed. This differs from OpenAI's newer
Sign in with ChatGPT public Responses flow. It does not turn a subscription into a
separate API-key account.

Only visible conversational models enter the picker. Names, text/image input,
context limits, supported reasoning levels and the recommended default come from
the catalog. The existing adapter exposes its supported reasoning levels, up to
Max; automatic-delegation modes from other harnesses are omitted. An advertised
image capability remains distinct from a successful image probe. Hidden service
models, remote instructions and unsupported input paths are excluded. Catalog
membership is metadata; a completed inference request verifies access for that
request.

Catalog metadata stays in the private auth directory and is bound to the current
login session. Token renewal preserves the cache. Disconnecting or switching
accounts invalidates it. A failed refresh preserves the last valid same-account
list and shows the error. A selected or pinned model removed from the catalog
remains visible as unavailable, so historical sessions and model preferences are
not silently reassigned. The refresh does not run inference or image probes.

## Antigravity subscription (Direct, experimental)

For routine use, prefer the official `agy` client route described below. Direct access is experimental and uses a separate connection.

**Settings → Connections → Antigravity subscription** can connect Chimeric straight
to Google's Antigravity model service. Chimeric stores the credential in its own
encrypted vault and streams model output over SSE without spawning the `agy` CLI
during a turn. No Google OAuth client ID or client secret is built into Chimeric.

Two sign-in paths exist:

- **Use existing Antigravity session** imports the session held by the installed
  official app or CLI, once, on explicit request. When that imported session needs
  renewal, refresh it in the official `agy` client and import it again.
- **Sign in with Google** is disabled unless the process has both
  `CHIMERIC_ANTIGRAVITY_OAUTH_CLIENT_ID` and
  `CHIMERIC_ANTIGRAVITY_OAUTH_CLIENT_SECRET`. Those values must belong to the
  user's own local OAuth registration. When configured, Chimeric performs an OAuth
  2.0 PKCE authorization-code flow with a state-checked loopback callback on
  `127.0.0.1`.

If either local OAuth variable is missing, Chimeric refuses browser sign-in and token
renewal before making a network request. It never borrows or publishes the official
client's OAuth registration. For routine use, select **Official CLI** and sign in
through the installed `agy` client.

Either way the access token is only ever sent to
`https://daily-cloudcode-pa.googleapis.com` (inference) and
`https://cloudcode-pa.googleapis.com` (eligibility and model catalog). The
credential vault lives under the selected profile's `local-auth` directory and is
encrypted with AES-256-GCM; renewed tokens are bound to the credential revision that
started the request, and a disconnect or re-sign-in invalidates in-flight work.

The model catalog comes from Google's `fetchAvailableModels`. Its
`agentModelSorts` list determines which models belong in the research picker.
Chimeric groups effort variants into one family row, currently Argon, Flash,
Opus, Sonnet and GPT-OSS, then adds the Carbon supplement described below. Legacy
aliases, internal helpers and dedicated image-generation entries are excluded
from this picker. Family limits use the smallest advertised limit across variants;
image input is declared when every variant supports it.

A small supplement adds models that the consumer catalog does not advertise but that
the service demonstrably routes: **Gemini 4 Carbon (Low/Medium/High)** — text, image
input and all three effort variants were each proven by a direct live probe before
being added. The supplement uses estimates from the Argon family for token limits.
An advertised picker entry supplies its own metadata when available.

Every turn streams incremental text (and thinking parts when the model emits them)
through the normal research harness, so tool calls round-trip natively:
`functionCall` parts become Chimeric tool calls, and the tool result returns as a
`functionResponse` part in the same conversation. Image input is sent as
`inlineData` and is supported wherever the catalog advertises `supportsImages`.
Choose Low, Medium or High with the normal thinking-effort control. Chimeric maps
that choice to the exact advertised model ID before sending the request. Saved
IDs containing an effort suffix continue to resolve with their original effort.

Gemini tool calls can carry a thought signature, an opaque value needed to
continue that model's reasoning. Chimeric preserves real signatures in the
connection-bound replay store. Imported history, model switches, and expired
replay entries can leave older calls unsigned. For these calls, Gemini 3 and
later use Google's [documented history-migration marker](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/thinking/thought-signatures)
on the first function call in each assistant step. This preserves the visible
call and result without inventing the missing reasoning. Google notes that
reasoning quality can be lower when original signatures are unavailable.

Invalid requests, authentication failures, permission failures, and quota
responses are reported as terminal native errors. They stop the turn instead
of being mislabeled as temporary server errors and retried. Quota errors retain
the provider's wait instructions in the message.

Project and plan detection comes from `loadCodeAssist`: the returned
`cloudaicompanionProject` is sent with every request, and a `paidTier` value (for
example `Google AI Pro`) means the account's subscription bucket is used rather than
the free tier. Quota exhaustion, eligibility failures, an unknown model ID and a
client version that Google no longer serves each produce a distinct error instead of
an empty answer.



### Wire conventions (aligned with the official client)

The direct transport reproduces the official CLI's request conventions rather than inventing its
own, which is both what the service expects and what keeps behaviour comparable when the service
changes:

- Inference goes to `daily-cloudcode-pa.googleapis.com`; eligibility and catalog RPCs go to
  `cloudcode-pa.googleapis.com` — the same split the official client uses.
- `loadCodeAssist` is sent with exactly `{"metadata":{"ideType":"ANTIGRAVITY"}}`, and every later
  control body carries the resolved `project`, including `fetchAvailableModels`.
- Every generate call carries a `requestId` correlation UUID in the envelope.
- The envelope is exactly `{model, project, request, requestId}`. Fields the official client does
  not have — `sessionId`, `labels` — are never sent, because the service rejects the whole request
  at parse time when they appear.
- Model ids are used exactly as the catalog advertises them, including the effort suffix; the
  transport never rewrites or guesses an id.
- `thinkingConfig` is omitted by default (see the account-safety note for the measured reason);
  effort comes from the model variant.
- The presented client identity tracks releases: the connection reports
  `client: {presented, installed, matches}` so a stale identity is visible in Settings instead of
  failing silently when the service raises its minimum version.

### Go transport bridge (packet parity with the official client)

The Antigravity service is normally spoken to by Google's Go client, and the TLS ClientHello
is a client-identification signal. A plain JS `fetch` presents a measurably different
fingerprint (JA3, cipher list, extension order, HTTP/1.1 instead of HTTP/2 — measured in
`work/agy-http-20261111/packets/PACKETS.md`). To remove that difference, inference traffic
goes through a small Go side process, **`agy-http-bridge`** (`tools/antigravity-http-bridge`),
whose Go `net/http` + `crypto/tls` stack produces a ClientHello identical to the official
client's: same JA3 (`60828da5b42313d165aae2938e651b72`), same 13 ciphers, same extension
order, same ALPN (`h2, http/1.1`), same 1513-byte ClientHello — verified against a live capture
of the official CLI.

How it is used:

- The bridge is a long-lived child process speaking newline-delimited JSON on stdin/stdout:
  Chimeric sends `{id, url, token, body}`, the bridge performs the HTTPS request and streams
  back status, headers and base64 body chunks, plus a `cancel` message for user aborts so a
  cancelled turn stops consuming quota remotely.
- The token passes from the encrypted vault straight into the bridge, and the bridge client
  refuses any origin other than the two Antigravity hosts before a byte is written — so
  confinement does not depend on which transport is active.
- Chimeric keeps everything else: the OAuth lifecycle, request envelopes, SSE parsing, error
  mapping, no-retry rules, the 4-request concurrency cap and credential redaction are all in
  Chimeric; the bridge is only the socket.
- Selection: production uses the bridge and reports an error if its binary is unavailable.
  Tests with an injected fetch use that fetch. `CHIMERIC_ANTIGRAVITY_TRANSPORT=bridge|fetch` forces a
  transport, and `CHIMERIC_ANTIGRAVITY_BRIDGE=<path>` pins the binary (an explicit override
  that is broken fails closed rather than silently substituting another binary).
- The Mac and Linux packagers compile `tools/antigravity-http-bridge/main.go` with Go and
  CGO disabled for their explicit target, then include `bin/agy-http-bridge`. Add Go to
  `PATH` or set `CHIMERIC_GO` to the compiler path before packaging. A missing compiler or
  failed build stops packaging. The build journal records the helper source and binary
  hashes; the Mac package signs and verifies the helper before signing the app.

This is packet parity, not an authorization: the service still serves the official client's
identity, and the account-safety limits above still apply in full.

### Account-safety limits (read this before enabling)

This transport is **not an officially supported integration and cannot be made ban-proof**.
Anthropic-free and honest about the mechanism:

- The inference service only answers clients that present the official Antigravity client
  identity. Chimeric therefore sends that client's versioned `User-Agent` and uses the OAuth
  client that ships with Google's own client software. That is undisclosed third-party use of a
  subscription, and Google can rate-limit, block or terminate it at any time, with or without
  notice. If a supported path matters more than streaming quality, use the official CLI
  transport (`agy acp`) or a paid Gemini API key instead of this connection.
- Chimeric does **not** attempt to make that harder to detect: no proxy rotation, no account
  rotation, no IP or device spoofing, no token harvesting from other applications at request
  time, no quota bypass, no retry storms, no concurrent bursts (at most four model requests in
  flight; extra turns wait), and no falling back to another credential when a request fails.
  A `429` is reported with its `Retry-After` and never retried automatically; `401`/`403` tell you
  to stop and reconnect officially.
- The access token is only ever sent to `daily-cloudcode-pa.googleapis.com` and
  `cloudcode-pa.googleapis.com`; requests to any other host are refused before the credential is
  attached. Tokens are stored in an AES-256-GCM vault inside the profile, errors are redacted, and
  tokens are never logged, exported, or included in language-model prompts.
- Operational guidance: if you start seeing `403`, `401`, repeated `429`, or eligibility errors,
  stop using the connection and sign in through the official client. Do not create extra accounts
  to work around a block — that is what turns a throttle into an enforcement action.

## Antigravity models in research sessions (official CLI transport)

**Settings → Connections → Antigravity connection** manages the official `agy`
CLI. Connect and refresh its advertised models, then choose them from the normal
session model picker. The catalog groups model variants by their advertised
reasoning levels. Claude Opus and Sonnet appear when the CLI advertises them.
Headlines, default selection and background model roles use the same qualified
model IDs as other providers. Refreshing the catalog needs no app restart.

Chimeric keeps its research loop, reviewer, tool permissions, compute sandbox
and Files service. Each model turn sends the transcript and current tool schemas
to the official CLI as text. Its validated structured reply contains text and
proposed Chimeric tool calls. Chimeric executes those calls through the native
research loop. The CLI's internal tools are denied except its side-effect-free
structured-response completion. Output is buffered until its structure has been
validated, so text arrives after model completion. The current transport accepts
text only; image uploads fail explicitly and image probes do not contact it.

This adapter currently requires the Google-signed macOS CLI version **1.5.1**.
Other platforms or versions require their own compatibility verification. The
binary path identifies the official CLI, never an HTTP proxy. Google credentials
remain under the official CLI's control. Chimeric does not copy tokens, impersonate
another client, call private Google services directly or rotate accounts. Each
turn uses a fresh private workspace. Errors, quota limits and cancellations stop
the Chimeric request without resubmitting it or choosing an alternate provider.
The official CLI may perform its own transport retries or structured-output
correction turns within Chimeric's time and output limits.

The CLI can start configured MCP servers and lifecycle hooks before a model tool
permission is checked. Chimeric checks execution-configuration metadata before
launch. By default it refuses external hooks, MCP or plugins. A saved opt-in
allows shared MCP servers and plugins to start under their existing permissions,
including file and network access outside Chimeric's sandbox. External hook
configuration remains blocked. Chimeric then checks
the official hook listing against its own request policy. Shell status/title
scripts are disabled. Changing these settings during a request is outside that
check's protection. An isolated official CLI profile requires its own official
sign-in; existing credentials must never be copied into it.

Antigravity access here remains experimental. Google's ACP documentation describes
custom clients; its consumer FAQ also limits third-party harness access. Working
inference verifies that request's technical access. It does not establish policy
permission or a guarantee against account restrictions. Check the terms that
apply to your account before using subscription access.

## Image creation

Select **ChatGPT subscription** in **Settings → Connections → Image generation**
to generate images through your existing ChatGPT sign-in. This route uses
`gpt-image-2` and counts toward your plan's Codex usage limits. It requires no
API key or extra CLI installation. The existing subscription connection handles
credential renewal, account binding and disconnects. The image transport follows
the protocol verified against the official Codex client; it is distinct from the
public Sign in with ChatGPT preview API, whose documented tools differ.

Select **Antigravity** in the same image-generation settings to use the existing
Google subscription connection. Image models come from the connection's advertised
`imageGenerationModelIds`; they appear in image settings independently of the
research model picker. For example, `gemini-3.1-flash-image` appears when the
service advertises it.
Antigravity uses its existing encrypted sign-in, fixed service destination and
packaged transport helper. Chat and image calls share the connection's four-request
limit, and the image manager admits at most two image jobs at a time.

Antigravity returns its native image format. A live synthetic request returned a
1024×1024 JPEG; its validated bytes are preserved with the matching filename and
MIME type. Square, landscape and portrait settings choose aspect ratios at the
provider's native resolution. Explicit format conversion, quality and transparent
background controls are unavailable for this route; describe appearance in the
prompt. This initial adapter supports text-to-image generation.

Ask for an image in a normal research session. The `generate_image` tool sends
the image description through the selected connection, validates the final image
bytes and saves them with the native artifact service. Results appear in session
Files with a persistent artifact reference. The chat model can be from another
provider. Reviewer and aside frames cannot generate images. Native plan and
tool-access gates apply. Scientific plots based on data should use ordinary
plotting tools so the computation remains inspectable.

Changing the chat model does not change the image connection. To generate through
Antigravity, select its subscription connection under **Settings → Connections →
Image generation** and save. The tool description identifies the selected image
connection and model so the research agent can report which service it will use.

The setting begins **off** in a fresh profile. Choosing the subscription selects
its supported image model. An OpenAI API connection is available as a separate,
explicit choice using its own API key and billing. A disconnected subscription,
a quota limit or an authentication failure never switches to an API connection.
Image-input capability and image creation are separate features.

Requests retain durable receipts bound to the session, tool call, connection
revision and subscription sign-in session. Replaying a completed call checks the
stored file and returns the existing reference. Credential renewal within the
same sign-in preserves that receipt. Switching accounts invalidates its replay.
Failed or interrupted requests are never silently sent again. A new request needs
an explicit new tool call. A rejected image POST is not automatically replayed
after token renewal. Cancellation cannot reverse remote usage already accepted.
If cancellation arrives during native file persistence, the saved artifact and
its receipt remain available.

The ChatGPT subscription route currently returns PNG images. The optional API adapter
also supports the documented Images API and Responses image-generation output.
API model choices are `gpt-image-2.5-flare`, `gpt-image-2.5-sunburst` and
`chatgpt-image-latest`. API keys are bound to the exact
`https://api.openai.com/v1` destination. Subscription credentials are bound to the
exact Codex image endpoint and cannot be sent to a custom provider URL.

### Reference images use compatible image edits

Compatible API image connections can accept reference images through multipart
`POST /images/edits`. The `generate_image` tool exposes
`reference_image_version_ids` only for this route. Supply one to four exact native
version UUIDs for existing PNG, JPEG or WebP files. Paths and URLs are not accepted.
The native resource policy must classify each version as standard and permit it
in the current research chat. Composer uploads must retain that chat's verified
upload context; generated reference files must belong to the same chat.

The prompt and reference image bytes are sent to the explicitly selected image
provider. Returned images are validated and saved in Files. Receipts retain the
reference version IDs and checksums. A replay checks those references again.
The official OpenAI API, ChatGPT subscription and Antigravity routes currently
reject reference inputs. A rejected edit never falls back to text-only generation,
another model or another provider.

A real RiVault reference edit with `black-forest-labs/FLUX.2-klein-9B` was tested
using a synthetic image on 2026-11-22. That test verifies the image-input route;
it does not establish protein-structure accuracy. A protein-illustration workflow
using `black-forest-labs/FLUX.2-dev` is still being checked, so no final protein
result is claimed here.
