# DIEM Agent Workers Terms of Service

Effective: August 14, 2026

DIEM Agent Workers is operated by the DIEM Agent Workers project identified at <https://github.com/coastmancoastman/diem-agent-workers>. Security and legal contact is available through a private [GitHub security advisory](https://github.com/coastmancoastman/diem-agent-workers/security/advisories/new).

By accessing, paying for, or using the service, the caller and the person or organization operating it agree to these terms. Automated callers must expose these terms to their operators before spending funds.

## Upstream terms and prohibited uses

Callers and their operators must comply with the current [Venice.ai Terms of Service](https://venice.ai/legal/tos) and applicable policies of the selected model provider.

Do not use the service for unlawful, fraudulent, abusive, exploitative, or excessive activity; child sexual abuse or exploitation; infringement, privacy invasion, impersonation, harassment, or defamation; malware, credential theft, unauthorized system access, or service interference; or any high-stakes use where model failure could cause death, serious injury, or significant physical, financial, or safety harm.

Do not submit credentials, authentication tokens, private keys, seed phrases, or data you lack authority to process. The service may reject or suspend callers that threaten the service or violate these terms.

## Outputs and responsibility

Outputs may be inaccurate, incomplete, offensive, or unsuitable even when they satisfy a JSON schema. Outputs are not medical, legal, financial, tax, accounting, mental-health, or safety advice. Callers are responsible for reviewing outputs and for all decisions and actions based on them.

## Prices, payment, retries, and refunds

Current exact prices and limits are published in the machine-readable `/v1/catalog` endpoint. Payments use x402 exact-scheme USDC on the network advertised by that catalog.

A successfully settled and delivered job is final and non-refundable except where mandatory law requires otherwise. A matching `Idempotency-Key` may provide one bounded retry when a verified or settled payment did not produce a delivered response. The service does not promise automatic cash refunds.

## Privacy and subprocessors

Request bodies and provider response bodies are not intentionally logged or persisted. Privacy-preserving HMAC fingerprints and aggregate operational telemetry may be retained. Service providers include Venice.ai, Coinbase CDP x402 Facilitator, Vercel, and Upstash Redis.

## Availability, warranties, and liability

The service, models, prices, limits, and routes may change, pause, or end without notice. The service is provided as-is and as-available without warranties about outputs, model availability, fitness, merchantability, or non-infringement to the maximum extent permitted by law.

To the maximum extent permitted by law, the operator is not liable for indirect, incidental, special, consequential, or reliance losses arising from use of the service.

These terms are governed by laws applicable to the operator, subject to mandatory rights that cannot lawfully be waived. Continued use after the effective date of updated terms constitutes acceptance of the update.

This document is an operational launch safeguard, not legal advice. Qualified counsel should review it before the service handles material volume.
