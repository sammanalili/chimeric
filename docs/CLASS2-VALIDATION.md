# Class 2 validation remains open in 0.3.0-rc.2

The Class 2 release gate remains open until the packaged workflow is usable and passes as one system. Disabling the feature or proving only that it fails closed does not complete this work.

The production `ConfidentialityManager` receives no positive `protectionEvidence` attestation. An activation request therefore returns unavailable before the saved policy can change. A forged low-level Class 2 policy still cannot authorize a model request because the manager checks the missing evidence again. The native transition also rejects entry when durable evidence about earlier compute history is absent. Subscription clients, unmanaged tools, persistent kernels, shell execution, MCP, remote compute and uncontrolled network access remain unavailable for protected sessions.

## The focused enforcement suite passed

On 2026-11-21, 221 focused Bun tests passed with 1,538 assertions and no test assertion failures. Two bridge suites needed permission to bind synthetic loopback ports, so they were rerun outside the Codex network sandbox. They passed 12 tests with 176 assertions. No provider endpoint, user credential, installed Chimeric profile or research data was used.

The suite covered:

- Missing build-wide evidence blocks activation before policy mutation.
- Missing native history evidence blocks the protected transition before native work is stopped or relabelled.
- Actual Darwin and Linux native resource hooks cover metadata, materialization, lists, saves, uploads, automatic attachments and raw reads.
- Protected storage separates credentials from research files and rejects symlinks, hardlinks, broad grants and stale scope.
- Ordinary sibling chats cannot read protected metadata or bytes through the resource service.
- Active HTML, PDF, SVG, binary and MCP views do not receive protected content. The permitted protected representation is bounded inert text or a validated static raster.
- Model, reviewer, memory and replay state stay bound to the authenticated root and approved connection.
- External traffic requires one immutable human-reviewed request. Redirects, retries, standing domain grants and credential substitution are unavailable.
- Native kernel, task, reviewer and process teardown checks fail closed when ownership or process history is incomplete.

## What the current result means

The current source can state that incomplete Class 2 activation fails closed. It cannot state that Chimeric is approved for Class 2 data, and this result does not close the release gate.

A future enabling release still needs one platform-specific attestation that exercises the packaged application from an empty protected chat through model input, storage, artifacts, local compute and reviewed egress. It must also prove durable compute history across restart and repeat the operating-system confinement checks on each supported platform. The detailed unfinished enablement requirements remain in [CLASS2-NATIVE-CONFINEMENT.md](CLASS2-NATIVE-CONFINEMENT.md) and [CLASS2-BROWSER-EGRESS.md](CLASS2-BROWSER-EGRESS.md).
