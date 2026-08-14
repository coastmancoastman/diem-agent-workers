# DIEM Agent Workers

Privacy-first, machine-discoverable micro-work powered by private Venice inference and paid in USDC through x402.

This repository is a fail-closed, agent-first Base mainnet storefront. It exposes six bounded workers over plain HTTP + x402, publishes them to the CDP Bazaar, and adds A2A 1.0, MCP, OpenAPI, `llms.txt`, and portable-skill discovery surfaces.

Public beta: [diem-agent-workers.vercel.app](https://diem-agent-workers.vercel.app)

| Worker | Bounded outcome | Beta price |
| --- | --- | ---: |
| `extract_text_to_json` | Caller-schema-valid extraction | $0.020 USDC |
| `classify_text` | Exactly one caller-supplied label | $0.010 USDC |
| `summarize_text` | Structured abstract and key points | $0.020 USDC |
| `text_to_speech` | Up to 1,000 characters as MP3 | $0.010 USDC |
| `generate_draft_image` | One safe-mode 1024px WebP | $0.020 USDC |
| `transcribe_audio` | Up to 60 seconds of verified PCM WAV | $0.015 USDC |

These are fixed prices per successful authorization attempt, not estimates. The public deployment uses conservative, fail-closed provider-capacity limits.

## Privacy by design

- Prompts, outputs, payer addresses, transaction hashes, IP addresses, user agents, and request identifiers are excluded from durable metrics.
- Request and provider bodies are not intentionally logged or persisted.
- Public reliability statistics are lifetime aggregates only; there are no timestamps or time buckets that could reveal activity patterns.
- Workers use private Venice models, with web search, scraping, and model tool use disabled.
- Delivery protection stores only HMAC fingerprints and bounded state needed to redeem an interrupted delivery.

The public storefront has no operator wallet signer or private key deployed to Vercel and does not perform automated asset conversion.

## What is implemented

- Three Venice structured-output text workers with post-response JSON Schema validation
- Bounded Venice speech, image, and transcription workers
- Independent provider-side and atomic software capacity ceilings
- An environment-backed storefront kill switch checked before payment
- Input validation before payment, including exact PCM WAV duration checks
- Pre-payment Venice epoch-access, model-online, private-model, and capability checks
- Free machine-readable catalog and per-worker fixed-price quotes
- OpenAPI 3.1, `llms.txt`, A2A 1.0 Agent Card, JSON-RPC `SendMessage`, and Streamable HTTP MCP discovery
- x402 exact-price USDC payment gating through the CDP Facilitator
- Rich per-worker x402 Bazaar schemas, service name, topical tags, and service icon
- Official MCP Registry metadata for the public Streamable HTTP server
- Privacy-preserving runtime telemetry plus durable lifetime aggregate reliability, settlement, revenue, latency-bucket, and DIEM counters
- Durable, idempotent paid-delivery credits backed by atomic Upstash Redis state
- Published machine-readable terms linked from every response and discovery surface
- Payments sent directly to the configured Base settlement address
- Installable agent skill and local/stdio MCP adapter

The service is not affiliated with or endorsed by Venice.ai.

## Local start

Requirements: Node.js 22+ and pnpm.

```bash
cp .env.example .env
pnpm install
pnpm test
pnpm dev
```

Add a server-side Venice key to `.env`:

```dotenv
VENICE_API_KEY=...
VENICE_TEXT_MODEL=venice-uncensored-1-2
VENICE_IMAGE_MODEL=venice-sd35
VENICE_TTS_MODEL=tts-kokoro
VENICE_ASR_MODEL=openai/whisper-large-v3
```

Configure a native Venice `EPOCH` limit for the server key. Before issuing a 402, the service checks current epoch access and the configured model's online, private, and capability state.

The development server binds to `127.0.0.1:8402`.

```bash
curl http://127.0.0.1:8402/health
curl http://127.0.0.1:8402/v1/catalog
curl -X POST http://127.0.0.1:8402/v1/quote/classify_text
```

With `PAYMENTS_MODE=off`, the worker is callable without payment for local testing:

```bash
curl -X POST http://127.0.0.1:8402/v1/jobs/extract-json \
  -H 'Content-Type: application/json' \
  -d '{
    "source": "The Acme Trail Mug is drinkware and costs $18.50.",
    "schema": {
      "type": "object",
      "properties": {
        "name": {"type": ["string", "null"]},
        "category": {"type": ["string", "null"]},
        "price_usd": {"type": ["number", "null"]}
      },
      "required": ["name", "category", "price_usd"],
      "additionalProperties": false
    }
  }'
```

Production refuses to start unless payments, durable delivery protection, the global compute budget, and aggregate-only metrics are configured consistently. Checked-in and local defaults keep payment and operator-only functionality disabled.

## Add x402 payments

Import a downloaded CDP Secret API Key without printing its values:

```bash
pnpm credentials:import-cdp /absolute/path/to/cdp_api_key.json
```

The command tightens both the downloaded key file and `.env` to owner-only permissions. It refuses to overwrite configured credentials and does not enable payments.

Start on Base Sepolia:

```dotenv
PAYMENTS_MODE=development
TREASURY_ADDRESS=0xYourDedicatedEvmAddress
CDP_API_KEY_ID=...
CDP_API_KEY_SECRET=...
```

The server uses the address form of the CDP configuration, so payments settle directly to `TREASURY_ADDRESS`; CDP does not provision or control that wallet. An unpaid request to the worker should return HTTP 402 and a `PAYMENT-REQUIRED` header.

### Paid-delivery protection

Mainnet is fail-closed unless durable delivery credits are enforced. Provision an
Upstash Redis database through the Vercel Marketplace and use the checked-in
environment template for the required settings.

Agents should generate one unpredictable `Idempotency-Key` per logical job and
reuse it only with the identical request and payment authorization. Signed paid
attempts without the header fail before settlement. The Redis record contains
only HMAC fingerprints, worker ID, state, lease, and expiry—never request bodies,
provider responses, payer addresses, payment headers, or transaction hashes.

Normal successful delivery consumes the key. If the process is interrupted after
settlement but before delivery completes, the same authorization, key, worker, and
request may redeem one retry without another settlement. Conflicting reuse is
rejected, and storage outages return `503` before settlement.

### Mainnet compute budget and kill switch

Production also requires a reviewed atomic global compute budget and an
independent storefront kill switch.

The service reserves a conservative amount equal to the job's USDC price after x402 verification but before Venice inference. Delivery retries reserve again because they can consume provider capacity even when the buyer is not charged again. A Redis outage or exhausted budget aborts new payment settlement and blocks inference. Set `STOREFRONT_ENABLED=false` and redeploy to disable all paid work before payment.

Run the guarded local Base Sepolia settlement test with:

```bash
pnpm test:sepolia
```

This is an actual testnet transaction: it creates an ephemeral in-memory buyer,
requests faucet USDC, validates the exact quote before signing, pays one worker
call, and reconciles the treasury's test-USDC increase. It refuses to run unless
the saved payment and operator-only modes are disabled. Local HTTP
tests are not published to Bazaar; a public HTTPS deployment is required.

Mainnet launch checklist:

1. Use a dedicated, low-balance settlement account—not a personal wallet.
2. Verify the address and Base network.
3. Deploy behind public HTTPS.
4. Validate the x402 endpoint with the CDP validation API.
5. Publish and review [TERMS.md](TERMS.md); every API response links to `/terms`.
6. Enable durable delivery credits and a conservative atomic software budget.
7. Enable production payments while keeping operator-only asset management disabled.
8. Complete one real low-value payment so Bazaar can index the Base mainnet resource.

Maintainer-only mainnet acceptance tooling is fail-closed, spending-bounded, and
omits wallet addresses, transaction hashes, request bodies, and provider
responses from its output. Production operator procedures are maintained
separately and are not part of this public interface.

## Machine discovery

- `GET /v1/catalog` — capabilities, schemas, constraints, price
- `GET /v1/stats` — lifetime aggregate reliability and settlement counters with no caller identities or time series
- `GET /.well-known/agent-catalog.json` — crawler-friendly catalog alias
- `GET /openapi.json` — OpenAPI 3.1 contract
- `GET /llms.txt` — concise agent-readable index
- `GET /.well-known/agent-card.json` — A2A 1.0 Agent Card
- `POST /a2a` — A2A 1.0 JSON-RPC `SendMessage` adapter at a fixed $0.020 USDC price
- `POST /mcp` — stateless Streamable HTTP MCP server with free catalog, quote, and call-preparation tools
- `skills/extract-text-to-json/` — portable agent skill
- `GET /icon.svg` — stable service icon used by x402 Bazaar metadata
- x402 Bazaar metadata — schemas, service name, five topical tags, and icon automatically attached when payments are enabled

The MCP adapter intentionally does not accept wallet keys. Agents execute prepared calls with their own x402-capable client or use Coinbase's Bazaar MCP server, which can discover indexed x402 resources.

The remote MCP server is described by [`server.json`](server.json) under the `io.github.coastmancoastman/diem-agent-workers` namespace for publication to the official MCP Registry.

## Private storefront telemetry

Production emits one-line JSON events to the server runtime log. The schema is an explicit allowlist: route category, HTTP status, latency, worker, coarse error class, model, exact settled price, and estimated DIEM cost/margin. Cost estimates use Venice's public model-pricing catalog and do not query account balances or billing history.

Telemetry never includes prompts, outputs, prompt length, token counts, raw URLs, request IDs, IP addresses, user agents, headers, payer identities, transaction hashes, provider request IDs, or credentials. Telemetry failure never blocks a worker response.

Create a local aggregate report from a saved JSONL file:

```bash
pnpm telemetry:report /absolute/path/to/runtime-logs.jsonl
```

Or report recent production logs from the linked Vercel project:

```bash
vercel logs --environment production --since 24h --no-branch --json --limit 1000 \
  | pnpm telemetry:report
```

The report contains request and payment counts, settled USDC revenue, estimated DIEM cost and gross margin, latency percentiles, and coarse failure counts. It cannot reconstruct individual customer content or identity.

Because serverless runtime logs are not a durable business ledger, production also writes atomic lifetime aggregate counters to the same Upstash database used for safety state. `GET /v1/stats` publishes completed/failed runs, coarse failure classes, fixed latency buckets, settlements, revenue, and DIEM estimates by worker. The counter key contains no dates or timestamps, and the write API accepts no free-form customer or request fields.

## Security and legal notes

Use of the service is governed by [TERMS.md](TERMS.md), also published at `/terms`. Read [SECURITY.md](SECURITY.md) and [docs/END_USER_TERMS_CHECKLIST.md](docs/END_USER_TERMS_CHECKLIST.md) before accepting third-party work. AI output matching a schema is not proof that its contents are correct. Do not use this worker for high-stakes decisions.

## Verification

The current production acceptance evidence, including all six Base Sepolia settlement transactions, is recorded in [`docs/BASE_SEPOLIA_ACCEPTANCE.md`](docs/BASE_SEPOLIA_ACCEPTANCE.md).

```bash
pnpm check
pnpm test
pnpm build
pnpm generate:openapi
ALLOW_VENICE_EVAL=1 VENICE_EVAL_MODELS=venice-uncensored-1-2 pnpm eval:text
```

The live evaluation is opt-in because it consumes Venice capacity. It prints aggregate accuracy and latency only; it does not persist prompts or provider responses.
