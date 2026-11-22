# Changelog

## 0.3.0-rc.8 - 2026-11-22

This source prerelease collects the fixes made after the public 0.3.0-rc.2 release. The original runtime and private profiles are excluded.

- Fixed Anthropic subscription connection checks and sign-in. Dedicated official-client authentication commands avoid inference-option parsing, and Connect reuses an existing subscription sign-in before starting a new one.
- Restricted installer process matching to the exact Chimeric executable and workspace, so unrelated terminal commands are never stopped.
- Fixed credential binding for session and background model copies. In-flight requests keep their original endpoint and credential together when connection settings change; new requests use the updated connection.
- Restored normal Markdown rendering in chat messages and kept artifact image examples literal inside code, protected previews and editable text.
- Added native reference-image input for compatible OpenAI-style image-edit connections, including the verified RiVault route. The image tool accepts one to four PNG, JPEG or WebP Files versions, checks chat ownership and current access before dispatch, and sends multipart requests to the selected connection's `/images/edits` endpoint.
- Included the generated-image artifact resolver and macOS startup/update repairs from internal candidates rc.3 through rc.6.
- Updated app-owned Connections routing, displayed instructions and help links while retaining upstream provenance and compatibility identifiers.
- Published the four standalone scientific communication skills as [skill-pack version 1.0.0](https://github.com/sammanalili/chimeric/releases/tag/scientific-skills-v1.0.0), with individual importable ZIPs and an Apache-2.0 license.

## 0.3.0-rc.6 - Internal candidate

- Fixed the macOS native launch path so it waits on the daemon's local control socket instead of repeatedly starting helper runtimes during startup. This prevents a slow sandbox initialization from being starved and falsely reported as a port conflict.
- Extended the native helper guard to 210 seconds. The launcher still has a bounded three-minute readiness timeout and stops only the daemon it started if that limit is reached.

## 0.3.0-rc.5 - Internal candidate

- Repaired generated-image messages that displayed raw artifact handles. Existing local Markdown image handles now resolve through the checked same-origin image route.

## 0.3.0-rc.4 - Internal candidate

- Fixed ordinary local artifact and inline-image rendering after Class 2 had been used elsewhere. Confirmed Class 2 artifacts and Class 2 chats remain protected.
- Added a checked same-origin raster route and Markdown artifact-handle resolver so existing generated-image messages surface their saved local image instead of displaying a raw `{{artifact:…}}` handle.

## 0.3.0-rc.3 - Internal candidate

- Repaired native macOS update behavior: an update now stops the matching daemon before replacement, prevents a failed new daemon from lingering, and redirects both Connections routes to the Chimeric settings surface.
- The packaged installer now relocates a workspace stored under Desktop, Documents or Downloads into Application Support before native launch. It preserves the original workspace and any prior default profile.

## 0.3.0-rc.2 - Source prerelease

- Continued the Class 2 implementation across protected storage, browser resources, reviewed egress and native execution. The packaged Class 2 workflow remains unapproved for protected data until validation passes.
- Kept the final source-release audit open until Class 2 and its exact packaged evidence are frozen.

## 0.3.0-rc.1 - 2026-11-20

This release candidate prepared the provider-neutral integration source and local platform candidates. See release-status.json for the remaining platform and distribution gates.

- Added official-client Claude subscription integration, separate Anthropic API connections, and Fable 5.2 request compatibility.
- Added compact subscription usage and API token-price indicators beside the model picker. Provider quota is observed from responses when available; unknown quota and prices remain unavailable.
- Added shared explicit image model choices and connection-bound multimodal probes.
- Added Google connection opt-in, official-client prerequisites, selected-transport enforcement and cancellation after revocation.
- Removed the captured Google OAuth client pair from source and packages. Direct browser sign-in now requires an explicit local OAuth registration; the installed official client remains the recommended path.
- Made the checked frontend asset extraction build on the system Python 3.9 while retaining path, link and file-type validation.
- Added optional classifiers and four generic scientific communication skills without private examples or source media.
- Wired protected-session policy, one-shot outbound request review, native model leases, host-call scope checks, protected storage and resource-policy services into daemon startup. Class 2 remains fail-closed until every browser, resource, credential and native execution boundary passes as one system.
- Mounted the protected-resource endpoint and all six checked native preview consumers. Version-backed artifacts carry the displayed research frame to the daemon for verification. The one checked Files-tab URL call receives a temporary ordinary-mode lease that carries no path or bytes and closes permanently after protected history. Exact preview reads reject traversal, symlinks, file replacement, oversize input and cancellation before browser delivery.
- Added local ClamAV/Gitleaks scan tooling and strict source export resource checks.

## 0.2.0-rc.1 - 2026-11-11

This prerelease packages the Chimeric integration source. The original runtime and private profiles are excluded.

- Added Antigravity support through the official `agy` client and an experimental Direct connection. Prefer the `agy` client route for routine use.
- Added Gemini 4 Argon and Gemini 4 Carbon model support, with reasoning-effort selection.
- Added Gemini image generation and OpenAI GPT Image generation, saving results in session Files. Subscription connections use their selected account and do not fall back to API billing.
- Fixed model discovery, catalog filtering and saved reasoning-effort routing.
- Improved ChatGPT subscription discovery, memory handling and source-release checks.

Gemini image generation currently supports text-to-image. Model access depends on the connected account. Direct Antigravity access remains experimental.

Feature evidence is recorded in the reviewed AGY image and catalog verification artifacts. The AGY focused regression evidence reports 239 tests and 1,460 assertions across 15 files. The catalog-fix evidence reports 118 tests and 806 assertions, with one browser OAuth test skipped. These are feature-scope measurements, not a claim that every release gate is closed.

## Historical integration

The integrated research runtime remains version 0.1.71. Its original release history and notices belong to that component and are not reproduced here.
