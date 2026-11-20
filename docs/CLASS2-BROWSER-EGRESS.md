# Class 2 must isolate browser content and sibling research chats

The native renderer isolates artifact scripts from the app's origin, but it does not provide Class 2 outbound control. HTML previews can run scripts. MCP widgets can receive tool arguments and results and call server tools. Markdown image permissions can persist across research chats. Separately, project uploads are shared across chats, and ordinary macOS analysis read roots include the workspace base. Protecting only the process that handles a Class 2 request does not prevent an ordinary sibling from reading and sending the same data.

Production Class 2 must remain unavailable while these paths are unresolved. The current [ConfidentialityManager](../src/confidentiality-manager.ts) now requires explicit `protectionEvidence`; missing evidence gives `ready:false`, rejects activation with 503, and denies protected dispatch. Earlier isolated API, WebSocket and UI reports establish partial wiring only. They do not establish Class 2 readiness.

The smallest conservative browser implementation is to display protected artifact content as escaped text or a blocked-preview message, suppress protected remote embeds and external content links, and deny unverified MCP widgets. Do this before fetching a widget resource, creating a viewer, assigning a URL, starting a worker or sending data to an AppBridge. Standard content can keep the native renderer after its source is verified as standard.

This read-only audit inspected source on 2026-11-20. No production code, installed app, running profile, research data, microphone, account or network endpoint was exercised. Synthetic tests execute pure policy builders and a fake pooled-view lifecycle. They do not execute artifact scripts or prove browser or OS confinement.

## The original source exposes exact preview and file boundaries

The locally held original Darwin core fixture has SHA-256 `e3674e221f9079520f014eb2ef93d0ba151934a47fd561594efcb23a86809e0b`. Its original asset archive has SHA-256 `b47f7886d8a0fa29022a765b53d3222e25b81ce16214ec9ffe684e5aaad8f217`. Neither upstream binary is part of the source export.

The frontend chunks are minified. Character offsets below locate original AST nodes. Future patches should check the complete supported node and exactly one match. Linux and browser-engine behavior require separate verification.

| Original source | Exact boundary | Established behavior |
| --- | --- | --- |
| Core line 1352 | `Bg(artifact,version,path)` | Returns artifact `project_id` and `root_frame_id`, version `frame_id`, and artifact `creating_frame_id`. These are distinct relationships. |
| Core line 29699 | `Zfs`, `Hfs`, `Qfs`, `Jfs` | Resolves metadata, authorizes the native user through `lS`, then resolves the safe storage path. `Zfs` can fall back between artifact and version IDs. |
| Core line 30774 | `Mor`, then `ydi` | `GET /api/artifacts/:id` and `/api/artifacts/versions/:vid` serve bytes, including ranges and thumbnails. The group also serves archives, frame bundles and script bundles. |
| Core lines 29699, 30774 | `cms`, `dms`, attachment routes | `/api/attachments/:id` serves an owned attachment; `/metadata` exposes its artifact/version/root metadata. |
| `ArtifactTile-CFbnK3VR.js`, line 4, character 29313 | `xo` | Central preview switch dispatches image, PDF, HTML, MCP app, Markdown, notebook, structure, genome and other viewers. Useful presentation gate; insufficient as a server boundary. |
| `HtmlPreview-CXBwtfOG.js` | `bt`, `ue` | Fetches bounded version text, then sends HTML to `sendSandboxResourceReady` with `allow-scripts allow-forms`. |
| Same chunk | `lt`, `dt`, `Se` | Creates, acquires and destroys a body-level iframe pool keyed by artifact ID. |
| `index-BgpYmw3d.js`, line 366, character 1764264 | `JEt` | Chooses an alternate-host `/_sandbox/mcp_apps`, advertised sandbox origin, development origin or hosted fallback according to configuration. |
| Same chunk, line 366, character 1765512 | `eTt` | Creates the outer iframe with scripts, same-origin and forms; optional download/clipboard permission; no-referrer. |
| Core line 31203 | `JJc`, `QJc` | Builds the proxy document and CSP. The proxy creates an inner iframe and receives HTML by `postMessage`. |
| Core lines 31302, 31409 | `klr`, `eed`, `Mbi`, main registration | Serves `/mcp_apps` on the separate loopback renderer and `/_sandbox/mcp_apps` on the main server for alternate-host use. |
| Core line 31023 | `Csr` | Exposes MCP widget resource, call, register, unregister, claim and resolve routes independently of agent execution. |
| Core line 30135 | `BBl`, `DBl` | Resolves/acquires a connector and calls `readResource`, `listTools` or `callToolRaw`. Neither receives a frame. |
| `index-BgpYmw3d.js`, line 366, character 1773555 | `kan` | Constructs the MCP AppBridge, forwards tool inputs/results and resource handles, and wires `oncalltool` to `mcpApps.callTool`. |
| Same chunk, line 497, character 2404818 | `ha` | Markdown component map supplies image and link renderers. Default `remoteImagePolicy` is `allowlist`. `block` suppresses images before mounting, including data/local images. |
| Same chunk, line 483, character 2383490 | `Pzt` | Image gate accepts one-image Load, host allowlist or browser-session host permission. It has no frame-policy input. |
| `PdfPreview-C1RteAIw.js` | `Wr` | Uses PDF.js with annotation layers and external links. `disableStream` and `disableAutoFetch` configure PDF loading, not all browser egress. |

## The iframe sandbox protects origin access rather than every outgoing channel

The outer iframe retains the proxy origin. The proxy's inner iframe remains opaque: `JJc` clamps requested tokens and does not forward `allow-same-origin` or top-navigation tokens. Its default still permits scripts and forms. Requested popups, downloads and other listed capabilities can also be allowed. Parent-origin and message-source checks constrain who can inject HTML and relay messages.

Those are useful isolation properties. They do not stop a script from sending protected content through allowed resources, parent bridge operations or its own iframe navigation. `connect-src` governs fetch-like connections; it is not a firewall for every navigation. Blocking top navigation does not prevent navigation of the child itself. No-referrer suppresses a referrer, not protected text included in a destination URL or body.

`QJc` permits fixed CDNs for scripts, images, connections, fonts and media, plus inline/evaluated scripts. `selfOrigin:true` adds the proxy's own origin. Query `resource-src` and `connect-src` values pass through an origin allowlist, but not a Class 2 policy. The static proxy has no artifact/version/frame binding.

The SPA's `bmi` policy, where applied, permits HTTP/HTTPS images and HTTP/HTTPS/WS/WSS connections. Its stricter policy is report-only. Native registration calls `bmi` conditionally through `Ice()`; the generic `mvi` hook otherwise supplies only frame-ancestor protection. Do not assume every browser-mode page receives the detailed SPA policy, or that report-only policy blocks traffic.

Raw file disposition is separate. `Yle` returns `attachment` for HTML and SVG, and `inline` for PDF, raster images and selected media/font types. This reduces active-document exposure on raw navigation. It does not prevent fetching HTML as text and inserting it into a preview, or prove that every supported file renderer has no outgoing path. `ydi` adds no resource-specific Class 2 decision.

The limited HTML fallback is stronger than normal preview: `bt` uses `sandbox=""` srcdoc, and `ZXt` prefixes a restrictive CSP without script permission. `JXt` removes speculative resource links and refresh metadata in a separate processing path; calling `ZXt` does not establish that `JXt` ran. Initially, protected content should avoid both general HTML paths. Use escaped React text or `textContent`, without HTML/CSS/URL insertion, iframe, object, embed, SVG DOM, PDF worker or AppBridge. Binary files can show a blocked-preview message. Any future local rasterizer must itself have verified network/file/resource confinement.

## Hiding or unmounting a pooled preview can leave its scripts alive

HTML `dt.release()` removes the slot and hides the wrapper, then schedules `Se` through a reaper. `we` only cancels layout animation. MCP `Tse` similarly hides its wrapper and defers `destroy`; `HRe` only cancels layout work. The iframe is not immediately destroyed.

Class 2 transitions and source-policy changes must destroy the actual pool entry before protected bytes are delivered. An artifact-only pool key must not allow a protected view to reuse a standard view's iframe. A future permitted renderer needs a key bound to exact version, source root, policy revision and render decision, and must cancel pending fetches and queued bridge messages. A React wrapper, hidden tab or later SSE update alone is insufficient.

## MCP widget HTTP requests bypass the agent tool path

`GET /api/mcp-apps/:serverId/resource` reaches `BBl`, which can resolve credentials, acquire a connector and read a remote resource. `POST /api/mcp-apps/:serverId/call` reaches `DBl`, which can list and invoke tools. Native authentication and connector visibility do not identify a Class 2 frame. Current inputs have server/tool/arguments/host-mount fields without trusted source-frame binding.

The browser's `kan` forwards tool input/results, optional same-origin data handles and tool callbacks. An agent tool gate therefore does not cover widget egress. `firstParty`, a read-only tool hint or a model-written flag does not establish confidentiality.

Initially, protected content must not mount a widget or send it HTML, arguments, results, resource handles or context. Server enforcement needs a server-maintained mount binding to the authorized native root and actual resource version. Validate current ownership and policy before connector lookup, credentials or I/O. Cover register/claim/resolve as well as call/read. An optional browser frame header cannot solve the existing ambiguity between missing protected context and a standard request. Preserve standard behavior through an explicit standard mount binding; never use a process-global last-used frame.

## A server must resolve the actual version and owner before deciding render policy

The existing [native frame resolver](../src/native-frame-context.ts) verifies frame ancestry, project ownership metadata, organization layout and ambiguous databases. It does not resolve artifact versions to those frames. Add that lookup on the server:

1. Resolve the actual requested artifact/version in the authenticated tenant. A pinned version must match exactly; `Zfs` fallback can otherwise interpret an artifact ID as its latest version.
2. Read consistent metadata. Join `artifact_versions.artifact_id` to the artifact, retain version `frame_id`, artifact root, creating frame and project, then verify the native principal and organization. Do not infer them from paths, filenames, URL parameters or public metadata.
3. Resolve each relevant source frame through the trusted ancestry/owner checks. Conflicting projects/roots, unavailable ancestry, shared uploads and null frame fields require an explicit policy. They must not silently become standard.
4. Combine source classification with the authorized consuming root. A protected child's output opened in an ordinary pane cannot be downgraded by supplying that pane's frame. Branches and copies must retain the relevant source classification.
5. Bind the decision to exact version ID, checksum/metadata revision and policy revisions. Revalidate before bytes, conversion, cache use and widget I/O. On failure, return a blocked result before creating a renderer.

The public serializer `tKe` omits project/frame authority. Fetching its JSON in a browser cannot establish source scope. Current session mode is also not a durable classification history: turning a root Off or copying a version must not silently declassify retained protected bytes. A durable classification and explicit release rule are needed if Class 2 labels persist with data. This remains an unresolved part of the goal.

## Project uploads are not currently scoped to the active research chat

Three exact original boundaries establish the cross-chat path:

| Source | Boundary | Behavior |
| --- | --- | --- |
| Core line 27879 | `C3` | Returns `projects.uploadsFrameId` or creates one project-level root with `agentName:"UPLOADS"`, `conversationType:"uploads"`, then saves it as `uploadsFrameId`. |
| Core line 29699 | `lms` | Authorizes the project, obtains that shared root with `C3`, and passes it as `root_frame_id` to `save_user_upload_streaming`. It does not tag the active research root. |
| Core line 2500 | `save_user_upload_streaming` | Creates an artifact with project/shared-upload root and `isUserUpload:true`; creates its version with `frameId:null`. |
| Core line 1396 | Repository `listUploadsForProject` | Calls `listForProject(project,{isUserUpload:true})`, with no research-root filter. |
| Core line 2500 | Store `list_uploads_for_project` | Maps those uploads and latest versions through `Bg`. |
| Core line 29730 | `e2n` request preparation | Calls `list_uploads_for_project(s.project_id)` and copies every result into `l._attachments` with artifact ID, filename, type and size. No consuming-root/classification filter appears in this step. |
| Core line 1352 | `kot(root,referencedArtifacts)` | Treats `is_user_upload` as visible even when its root differs from the consuming root. |

The initial automatic attachment includes metadata rather than the complete file bytes at this step. That metadata already crosses the chat boundary. The artifact/attachment read routes then authorize project ownership, not whether the consuming sibling may read classified bytes. A per-chat Class 2 network gate cannot correct content already handed to an ordinary sibling's model or tools.

Required changes are source tagging at upload/creation time, an explicit project-shared classification, filtering **before** automatic attachment/context construction and listing, and policy checks on later materialization, thumbnails, previews and downloads. Merely filtering the Files pane or changing one list result is insufficient. Never infer an upload's classification from its shared `UPLOADS` root. Existing unclassified uploads need an explicit migration/default rule. Explicitly selecting protected content in an ordinary chat must not bypass the same decision; require a deliberate reviewed release or keep the destination protected.

## Ordinary workers can inherit read access to protected sibling workspace paths

`af(frame)` and `VL()` at core line 1433 derive a frame directory and the common configured workspace base. The actual ordinary `fv.analysis` profile uses `macosPinnedRoots:"init"`. Its pinned read roots come from `Q4e` at line 30590, which includes `mH` at line 29954: the whole workspace, artifact storage and tool-result bases, plus shared runtime paths and user grants. `_macosPinnedRootsForProfile` at line 30734 returns those complete initial read roots for the analysis profile. Its separate BYOC/default branch can also add `this._pinnedWorkspaceBase`. `aJn` at line 30578 derives read reallows against pinned roots. `D$l` at line 29996 builds a broad file-read policy with home denies and `homeReadReallows`. A new sibling directory under a permitted workspace subtree is not isolated merely because it did not exist at process start.

Current [native execution patches](../tools/native-execution-policy.ts) narrow the protected `denyNetwork:true` read scope to that invocation's derived roots. Their explicit standard branch remains unchanged. This can protect the Class 2 worker from reading unrelated files, but it does not prevent an ordinary network-capable worker from reading new Class 2 files under the ordinary workspace base. Linux also needs independent analysis: native `hOs` can include the artifact storage base, and project artifact paths can be shared even when workspace directories differ.

A private Class 2 store outside ordinary broad reads is a useful design direction, but its path alone is not enforcement. Do not place it beneath the common workspace base, project artifact grants, temporary/staging paths or another broad ordinary grant. A separate directory in Documents is safe only after all effective read grants are checked. Same-user mode 0700 does not distinguish standard and protected child processes. Putting data outside the home directory can be worse under a policy that broadly allows non-home reads.

The storage design must keep protected workspaces, original uploads, artifacts, extracted text, thumbnails, transcripts, caches, tool results, temporary conversions, indexes and provenance out of ordinary process and daemon read paths. Standard workers need effective denial or capability-limited access to those stores, including already-running processes, shared MCP/official clients and kernel caches. Symlink/hardlink aliases and a common ancestor grant must not reopen them. A trusted daemon file broker can supply explicitly authorized reads, but every route and caller must retain a verified source/consumer context. A daemon with unrestricted storage access cannot forward files based only on project ownership.

This is a noninterference requirement: protected data must not influence an unapproved ordinary model/tool request through automatic context, metadata, filesystem reads or shared caches. Individual channel guards do not establish it. Do not enable Class 2 or describe it as complete until cross-chat and storage isolation are implemented and tested.

## A conservative first implementation needs browser and storage changes together

1. Add server-owned resource/classification resolution and gate raw artifact/version/attachment reads, thumbnails, ranges, archive/frame/script bundles and preview conversion. Check before file access, conversion and cache hits. Protected policy/content should not reuse stale 304/public-cache decisions. Keep verified standard behavior unchanged.
2. Guard `xo` before dispatch, plus direct HTML/MCP/inline mounts that bypass it. Pending, protected or unknown content gets escaped bounded text or a blocked placeholder before any native viewer mounts.
3. Give each Markdown source its actual native owning context. Initially use `remoteImagePolicy="block"` and inert external content links in protected views. Cover inline slots, tool results, notebooks, hover cards and alternate panes. Browser host allowance/Load must not override policy. First-party provider/help navigation is a different flow.
4. Deny unverified MCP UI and bind permitted mounts server-side before connector work. Destroy actual pooled renderers and cancel reads/notifications on policy/source changes.
5. Persist protected source classifications and isolate all retained/derived stores from ordinary siblings. Filter project-wide automatic attachments and enforce the same read decision on all later materialization paths. Keep production protection evidence false until the entire data path is covered.

A global CSP change cannot replace this work. It can break ordinary research/OAuth while still missing own-frame navigation and same-origin bridge calls. New protected rich renderers should be introduced only after their actual permitted paths are verified.

## Same-origin and Tailscale paths must use the same resource policy

[The Tailscale proxy](../tools/tailnet-proxy.mjs) admits one authenticated Serve identity, rejects Funnel, preserves native session/CSRF/WS checks, and translates exact app/sandbox origins. Its sandbox listener exposes `/mcp_apps`, rewrites allowed parents and `frame-ancestors`, and preserves inner-frame opacity.

This controls inbound access. It neither brokers outgoing browser requests nor classifies artifact bytes. Apply the same resource decision on loopback, main-port alternate-host sandbox mounts and both HTTPS Tailscale ports. Referer, Origin, port, path prefix and Serve identity do not identify the root that produced a version.

The original main-port sandbox exemption serves static proxy HTML rather than classified bytes. A new protected content/token endpoint needs its own native authentication and owner checks and must not inherit that exemption. Reachability of the proxy is not permission to send it protected content.

## The goal remains open until synthetic browser and cross-chat tests pass

The new [baseline audit tests](../tests/browser-egress-audit.test.ts) passed with packaged Bun 1.4.3: **10 tests, 99 assertions**. Command: `BUN_BE_BUN=1 /Applications/Chimeric.app/Contents/Resources/bin/chimeric test tests/browser-egress-audit.test.ts`. They exercise the original metadata/owner ordering, dispositions, active sandbox flags, CSP builders, independent MCP dispatch, Markdown host permissions, rich preview dispatch, deferred pool destruction, shared project uploads and broad ordinary read-root construction. They are not tests of an implemented Class 2 browser or storage guard.

After implementation, require these tests before setting protection evidence:

- Protected child/copy/shared/null/conflicting versions cannot obtain a standard raw route or active renderer. Wrong-owner/version/root and stale decisions fail closed.
- Protected Markdown assigns no external image/href/CSS/media URL even after a standard host permission. Verified standard rendering remains unchanged.
- HTML/SVG/PDF/media/MCP data is blocked or converted to the exact verified inert representation before active code receives it. Cover thumbnails, ranges, archives, workers, caches and alternate panes.
- Real pooled iframes are destroyed on revocation; pending fetches and bridge notifications are cancelled; no connector call occurs. Hiding a surviving iframe fails the test.
- A standard sibling in the same project receives neither protected upload metadata nor protected bytes. Explicit attachment, Files, direct API, search/index, copying, previews and model context cannot bypass the rule.
- A standard worker already running before a protected file is created cannot read it through the workspace base, artifact base, a broad user grant, temporary files, alias or shared cache. Test actual macOS/Linux confinement separately; profile string checks alone are insufficient.
- Loopback and equivalent synthetic proxy deployments preserve the same policy. Check WebKit and supported Chrome separately. Any future active-renderer own-frame navigation probe must be benign, synthetic and contain no research data.

No Class 2 completeness or public-release claim follows from the current partial wiring checkpoints.
