# DIEM Agent Workers v0.6.0

This release makes the Base mainnet storefront privacy-first and easier for software agents to discover.

## Privacy-safe durable metrics

- Adds atomic lifetime aggregate counters backed by Upstash Redis.
- Publishes reliability, coarse failure, fixed latency-bucket, settlement, revenue, and DIEM counters at `GET /v1/stats`.
- The durable metrics API cannot accept prompts, outputs, payer addresses, transaction hashes, IP addresses, user agents, request identifiers, or timestamps.
- Removes the application-generated timestamp from structured runtime telemetry; Vercel platform logs remain subject to Vercel's own retention.
- Keeps metrics fail-open and latency-bounded so an observability outage cannot alter worker or payment responses.

Production payments now require `AGGREGATE_METRICS_MODE=enabled`. The checked-in default remains `off`, and the mode reuses the existing Upstash credentials.

## Agent discovery

- Upgrades every worker to the full x402 route format with an explicit public resource URL.
- Publishes `DIEM Agent Workers` as the Bazaar service name.
- Adds five bounded topical tags per worker, including `private-ai` and `x402`.
- Adds a stable public service icon at `GET /icon.svg`.
- Links aggregate stats from the root document, catalog, OpenAPI, and `llms.txt`.

## Safety posture

- Keeps input validation, Venice capacity checks, the conservative software budget, and delivery credits ahead of inference or settlement.
- Keeps operator asset management outside the Vercel runtime and signer-free.
- Keeps prompts and outputs out of application logs and durable storage.

## Acceptance target

After deployment, run one bounded mainnet acceptance call for each remaining worker. A successful paid response proves the complete agent path: discovery, validation, x402 authorization, Venice inference, output validation, Base USDC settlement, and privacy-safe aggregate recording.
