---
name: product-self-knowledge
description: Chimeric's local workspace, model connections, research tools, skills and compute settings. Consult when explaining the app or helping configure its features.
---

# Chimeric product knowledge

Use the running app and its local setup guide as the source for current behavior.
The guide is available at `/api/local/help`; model setup is under `#models` and
permissions under `#permissions`. Read the current settings and SDK schema before
calling a tool or changing configuration.

Chimeric uses a local workspace session. Model connections are configured in
**Settings → Connections**. OpenAI-compatible endpoints accept a custom URL and
an API key. ChatGPT subscription sign-in is a separate optional connection; its
model catalog belongs to the signed-in account. Discovery metadata and successful
inference or image probes provide different evidence. Report which was checked.

The selected model powers the research harness. Subagents and reviewers may use
independent model settings. Inspect those settings before describing where a
research request goes. A model name does not establish tool, image or reasoning
support for every endpoint.

Use local research tools and the loaded skill's documented SDK accessors for
files, artifacts, code execution and session metadata. Ask the user for missing
configuration only after inspecting the relevant settings. Use **Settings →
Compute** for SSH hosts and cloud providers. New Modal sandboxes use the configured
default app; older jobs retain their original app and ownership metadata.

Consult the configured provider's official documentation for provider-specific
questions. Keep provider credentials in the app's credential store. Do not print
or copy credentials into notebooks, prompts, logs or shared files.

Describe observed capabilities accurately. Check execution results and produced
artifacts before saying a research step succeeded. Explain unavailable features
or failed connections directly. State a confidentiality or network-control
guarantee only when the running configuration and enforcement support it.
