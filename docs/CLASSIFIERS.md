# Optional classifier connections

Classifiers are off by default. Adding a connection does not select it, run it,
change chat models, or enable automatic routing. Chat, research, voice input and
image generation do not depend on a classifier being configured.

Connections supports TypeSafe-hosted, self-hosted diffusion and custom System One
services. Enter the full inference URL and the model name registered at that
service. The documented TypeSafe endpoint is
`https://api.typesafe.ai/v1/systemone`. A custom proxy prefix is preserved exactly.
The backend label does not change authentication or imply a confidentiality policy.

The flat format sends `model`, `state` and typed `questions`. Noul, Choice and
Score questions are supported. The separate chat-envelope adapter supports the
documented two-JSON-message Choice format; it is not a general chat model.
Responses are validated against the question IDs, options and scales. Confidence
and probabilities are provider outputs, not proof of calibration or safety.

Save API keys in the password field. They are encrypted in a separate directory
under the private `local-auth` boundary and bound to the exact endpoint URL.
Changing the destination requires a replacement key, explicit reuse, or clearing
the credential. Redirects are refused and failed requests are not retried.

The connection test sends only fixed synthetic text. It verifies a structured
response, not scientific accuracy or confidentiality approval. Test output and
raw provider diagnostics are not stored in the connection settings.

Class 2 eligibility is an explicit operator-policy declaration with evidence.
Changing the endpoint, model, format or backend requires reconfirming that
declaration. A caller supplying a trusted Class 2 execution policy can use only
an eligible, permitted connection. Neither the model's name nor a successful test
establishes eligibility, ZDR, or permission to transmit data.

This update provides connection configuration, synthetic testing and a server-side
evaluation API for future trusted-session integrations. It does not add automatic
research classification or the complete protected-session network broker. Selecting
a preferred classifier alone does not invoke it.

The manager isolates unreadable optional settings from application startup. A
classifier settings error must not stop unrelated research or overwrite the bad
files. Restore the classifier settings or credential backup before editing again.

References: [TypeSafe System One](https://docs.typesafe.ai/api/system-one),
[LiteLLM decision routes](https://docs.litellm.ai/docs/decisions/).
