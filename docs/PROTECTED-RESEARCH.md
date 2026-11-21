Class 2 activation is disabled in the current production wiring. Release validation passed by proving that the feature fails closed, not by approving protected operation. Browser egress, durable native-compute history and every packaged platform still need one complete confinement attestation before a future release can enable it. See [CLASS2-VALIDATION.md](CLASS2-VALIDATION.md).

# Class 2 controls apply to a saved research chat

This page describes the source candidate on 2026-11-21. It does not establish that the installed Mac app can process Class 2 data. It cannot in this release.

Class 2 is selected explicitly for each saved chat. Connection permissions belong to the workspace. A provider name, model description, classifier result or model-written instruction cannot grant permission. The optional classifier can remain Off.

## Choose the allowed connections before sending sensitive content

In **Settings → Connections**, allow Class 2 model processing for each intended connection. In the saved chat's composer options, choose its main and reviewer models, then enable **Class 2 confidentiality**. Only available, approved HTTPS API connections are eligible. Subscription clients and other unverified transports remain unavailable for this mode.

The current control requires a saved native frame, which is the stored record for a research chat. An unsaved new draft cannot enable Class 2. An empty saved frame must exist before the first sensitive message. Do not send sensitive content merely to create that frame. A complete first-message workflow still needs verification.

The main model receives the original conversation and supplied files through its approved connection. The reviewer uses its selected approved model. Other scoped model work, including memory, compaction and auxiliary calls, uses the protected main route. Unrelated saved chats keep their own settings.

The server checks the native frame, root, project, workspace owner and current connection binding. Browser flags and ordinary metadata are not proof of ownership. Private signed scope information stays on the local bridge. Replay caches are partitioned by the verified root and provider session, so identical visible answers do not restore another chat's hidden reasoning.

## An external tool request waits for one human decision

The protected model can propose a redacted or decontextualized copy through `request_external_access`. This means removing identifying details or reducing the surrounding context. The proposing model already has access to the original data through its approved model connection. Chimeric does not certify that the proposed copy is anonymous.

The tool pauses while the user reviews the purpose, destination, method, query, headers, body and uploads. The review includes full file bytes or a local download, plus account, IP address, approximate location and transport disclosures. Payload text and file contents are shown without translation or rewriting.

**Send once** applies to the immutable request held by the server. It cannot authorize different bytes, a different destination, a whole skill or standing network access. Permission is consumed before dispatch. Duplicate sends fail. Denial, expiry, cancellation or a relevant permission change stops the pending operation.

The current outgoing transport sends one public HTTPS request. It pins the checked DNS result, rejects private or reserved addresses, attaches no account credential or browser cookie, follows no redirects and performs no automatic retries. Identifiers can still be present in the reviewed URL, headers or content. A redirect needs a new review. Text responses return to the protected model; binary responses are saved as session artifacts when the native artifact service is available.

## Speech has its own explicit permission

Outside Class 2, speech recognition runs on the computer hosting Chimeric. A browser on another device sends its audio to that computer. In Class 2, choose a ready HTTPS speech model in **Settings → Connections → Speech recognition**. Saving that selection grants only the speech purpose. It does not approve the connection for chat-model processing.

For the saved main composer, the server resolves the frame and policy before reporting the recording destination. The browser waits for that destination before opening the microphone and displays it beside the microphone control. During recording, the browser sends PCM audio to Chimeric, which buffers it in memory. **Stop** submits one WAV recording to the selected speech endpoint. This uses the existing speech permission, without a second Send once review.

Class 2 speech is not anonymized before transcription. The selected service receives the recording, model and language fields, its authentication and network metadata. Use a speech connection that is permitted to receive the original audio.

The transport does not switch to local recognition, another provider or separate API billing after a failure. Changing the chat, policy, selected speech model or relevant connection cancels the affected capture. Cancel before upload discards the recording. Cancellation after upload begins cannot recall bytes already received by the service; it aborts further work and suppresses late transcripts.

## Several execution paths remain blocked or unverified

Persistent scientific kernels, shell execution, provisioning, binary document converters, MCP, remote compute and other unverified native tool paths remain blocked in protected chats. Plain text and local image input can reach the approved model. Remote attachment URLs require reviewed retrieval. A passing test of one Mac subprocess wrapper does not verify every kernel, child, converter or Linux/WSL path.

Artifact viewers, active browser content and their complete outgoing network paths still need separate end-to-end verification. The Class 2 selector is not an operating-system firewall for arbitrary processes or browser pages. These open paths prevent a claim that the full native protected-research workflow is ready.

User approval is separate from institutional authorization and retention evidence. Chimeric does not verify or guarantee anonymity, zero data retention (ZDR), a provider's contractual commitments or compliance with an institution's Class 2 rules.

The supporting checks use synthetic data and mocked providers. This document makes no claim of a new app installation, public Git push, live microphone verification or completed release readiness. See [CLASS2-NATIVE-CONFINEMENT.md](CLASS2-NATIVE-CONFINEMENT.md) for the native execution boundaries and remaining confinement work.
