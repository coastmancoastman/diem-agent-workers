# Security policy

## Secrets

Never commit `.env`, provider credentials, payment credentials, wallet private keys, or seed phrases. Operator wallet credentials and recovery procedures belong in private, managed storage—not source control, public documentation, issues, or support conversations. No operator signer is deployed with the public storefront.

## Operator asset management

Operator asset management is not part of the public storefront runtime and must remain disabled by default. Review any future asset-moving change privately as security-critical work using dedicated, narrowly funded accounts. Do not publish wallet-access procedures, signing controls, recovery details, or operational thresholds.

## Input handling

Source text is untrusted data. It is bounded, placed inside explicit delimiters, and sent with web search, scraping, X search, and tool use disabled. Media inputs are bounded; transcription accepts only locally parsed PCM WAV data of at most 60 seconds. The service does not intentionally persist request bodies. Avoid logging bodies, payment identities, or provider error bodies.

Operational telemetry is rebuilt from an explicit field allowlist. Never add prompts, outputs, raw paths, prompt lengths, token counts, request IDs, network addresses, headers, user agents, payer identities, transaction hashes, provider request IDs, balances, or billing-history records. Durable storefront metrics are lifetime counters only: do not add timestamps, time buckets, caller identifiers, or request/response content. Aggregate cost estimates may use the public model-pricing catalog, but telemetry must remain non-blocking and must not weaken a worker response when pricing is unavailable.

## Payment boundary

Every paid route validates its request and provider readiness before returning x402 payment instructions. Base mainnet also requires durable delivery protection, an atomic compute-capacity reservation, and an independent pre-payment kill switch. Readiness or safety-state failures block settlement and inference. Exact production settings are operator-only.

The MCP server never requests or receives buyer private keys. A2A and MCP inputs are subject to the same worker parsers as direct calls.

## Reporting

Until a public security contact is selected, open a GitHub security advisory rather than a public issue. Do not include live secrets or exploitable wallet details in reports.
