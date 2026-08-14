# DIEM Agent Workers

Machine-discoverable micro-work powered by Venice inference, paid in USDC through x402, with a treasury that can only reinvest USDC into Venice DIEM on Base.

This repository is a fail-closed, agent-first Base Sepolia storefront. It exposes six bounded workers over plain HTTP + x402, publishes them to the CDP Bazaar, and adds A2A 1.0, MCP, OpenAPI, `llms.txt`, and portable-skill discovery surfaces.

Public beta: [diem-agent-workers.vercel.app](https://diem-agent-workers.vercel.app)

| Worker | Bounded outcome | Beta price |
| --- | --- | ---: |
| `extract_text_to_json` | Caller-schema-valid extraction | $0.020 USDC |
| `classify_text` | Exactly one caller-supplied label | $0.005 USDC |
| `summarize_text` | Structured abstract and key points | $0.005 USDC |
| `text_to_speech` | Up to 1,000 characters as MP3 | $0.010 USDC |
| `generate_draft_image` | One safe-mode 1024px WebP | $0.020 USDC |
| `transcribe_audio` | Up to 60 seconds of verified PCM WAV | $0.015 USDC |

These are fixed prices per successful authorization attempt, not estimates. The public deployment remains on Base Sepolia until durable delivery credits pass public testnet acceptance, per-worker DIEM costs are priced, and independent beta traffic is proven.

## The flywheel

```text
staked DIEM -> renewing Venice API capacity -> paid agent work
            -> USDC revenue -> USDC-to-DIEM purchase -> manual staking
```

Purchased DIEM is not automatically staked in this release. Venice currently directs DIEM staking through its token dashboard and warns users not to send tokens directly to a contract address. Until a documented programmatic DIEM-staking transaction is verified, that final action stays manual.

## What is implemented

- Three Venice structured-output text workers with post-response JSON Schema validation
- Bounded Venice speech, image, and transcription workers
- Native Venice API-key compute ceiling of 1.69 DIEM per EPOCH (daily, resetting at 00:00 UTC)
- Input validation before payment, including exact PCM WAV duration checks
- Pre-payment Venice epoch-access, model-online, private-model, and capability checks
- Free machine-readable catalog and per-worker fixed-price quotes
- OpenAPI 3.1, `llms.txt`, A2A 1.0 Agent Card, JSON-RPC `SendMessage`, and Streamable HTTP MCP discovery
- x402 exact-price USDC payment gating through the CDP Facilitator
- Rich per-worker x402 Bazaar input/output metadata
- Official MCP Registry metadata for the public Streamable HTTP server
- Privacy-preserving operational telemetry and an aggregate margin report
- Durable, idempotent paid-delivery credits backed by atomic Upstash Redis state
- Payments sent directly to a dedicated treasury address
- Quote-only and live USDC-to-DIEM treasury modes
- Hard-coded Base USDC, Venice DIEM, chain ID, and 0x AllowanceHolder
- Exact approvals, per-swap limits, slippage cap, ETH gas reserve, process lock, and owner-only audit log
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
VENICE_DIEM_EPOCH_CAP=1.69
```

`VENICE_DIEM_EPOCH_CAP` publishes the cap in service discovery and must match the native `EPOCH` consumption limit configured on the Venice API key. Venice enforces the hard stop. Before issuing a 402, the service also checks current epoch access and the exact configured model's online/private/capability state; it never estimates DIEM billing from token counts.

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

Production refuses to start unless `PAYMENTS_MODE=production`. The checked-in and local defaults remain `PAYMENTS_MODE=off` and `TREASURY_MODE=disabled`.

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
Upstash Redis database through the Vercel Marketplace, then configure:

```dotenv
DELIVERY_CREDITS_MODE=enforced
DELIVERY_CREDIT_HMAC_SECRET=<at-least-32-random-bytes>
DELIVERY_CREDIT_TTL_SECONDS=86400
DELIVERY_CREDIT_LEASE_SECONDS=180
UPSTASH_REDIS_REST_URL=...
UPSTASH_REDIS_REST_TOKEN=...
```

Agents should generate one unpredictable `Idempotency-Key` per logical job and
reuse it only with the identical request and payment authorization. Signed paid
attempts without the header fail before settlement. The Redis record contains
only HMAC fingerprints, worker ID, state, lease, and expiry—never request bodies,
provider responses, payer addresses, payment headers, or transaction hashes.

Normal successful delivery consumes the key. If the process is interrupted after
settlement but before delivery completes, the same authorization, key, worker, and
request may redeem one retry without another settlement. Conflicting reuse is
rejected, and storage outages return `503` before settlement.

Run the guarded local Base Sepolia settlement test with:

```bash
pnpm test:sepolia
```

This is an actual testnet transaction: it creates an ephemeral in-memory buyer,
requests faucet USDC, validates the exact quote before signing, pays one worker
call, and reconciles the treasury's test-USDC increase. It refuses to run unless
the saved `PAYMENTS_MODE` is `off` and `TREASURY_MODE` is `disabled`. Local HTTP
tests are not published to Bazaar; a public HTTPS deployment is required.

Before mainnet:

1. Use a dedicated, low-balance treasury wallet—not a personal wallet.
2. Verify the address and Base network.
3. Deploy behind public HTTPS.
4. Validate the x402 endpoint with the CDP validation API.
5. Complete a real low-value payment so Bazaar can index it.
6. Change `PAYMENTS_MODE=production` only after testnet behavior is confirmed.
7. Enable the durable delivery-credit store and verify interruption recovery on public testnet.

## Reinvest USDC into DIEM

The treasury is a deterministic one-shot runner, not a prompt-driven wallet agent.

Create a new dedicated wallet on macOS with:

```bash
pnpm wallet:create
```

The command stores the private key in macOS Keychain and writes only the public address and Keychain labels to `.env`. It refuses to replace an existing wallet and requires payments and treasury execution to be disabled.

For seed-phrase recovery, create a dedicated wallet in a trusted wallet app, keep its seed phrase offline, export only its treasury account private key, and import that key through a hidden local prompt:

```bash
pnpm wallet:import
```

Never enter the seed phrase into the project. The import command displays the derived public address for confirmation, stores the account key in macOS Keychain, and replaces the previous disabled treasury configuration only after Keychain readback succeeds.

Verify ownership and read Base balances without revealing the key:

```bash
pnpm wallet:verify
```

See [docs/WALLET_ACCESS.md](docs/WALLET_ACCESS.md) for the macOS-authenticated recovery and wallet-import path. Never send a private key through chat; if you already control a wallet, share only its public `0x` address.

Quote-only mode reads balances and requests an indicative 0x price, but never signs:

```dotenv
TREASURY_MODE=quote
TREASURY_ADDRESS=0xYourDedicatedEvmAddress
BASE_RPC_URL=https://your-base-rpc.example
ZEROX_API_KEY=...
TREASURY_MIN_SWAP_USDC=5
TREASURY_MAX_SWAP_USDC=25
TREASURY_USDC_HOLDBACK=0
TREASURY_MAX_SLIPPAGE_BPS=100
TREASURY_MIN_ETH_RESERVE=0.0005
```

```bash
pnpm treasury:run
```

Live mode additionally requires the matching dedicated key from macOS Keychain (or a production secret manager) and an exact acknowledgement:

```dotenv
TREASURY_MODE=live
TREASURY_LIVE_ACK=BUY_DIEM_ONLY_ON_BASE
```

Use a production secret manager rather than a plaintext `.env` when deployed. The live runner:

- Refuses a key that does not match `TREASURY_ADDRESS`
- Refuses the wrong token pair, chain, allowance target, native value, or excess gas
- Approves only the intended USDC amount
- Refreshes the firm quote after approval
- Records the signed transaction hash before broadcast and reconciles it after a restart
- Verifies that USDC decreased by no more than the authorized amount and DIEM increased
- Writes `0600` JSONL audit records under `data/`

The runner does not sell DIEM, withdraw USDC, bridge assets, select arbitrary tokens, or stake DIEM.

## Machine discovery

- `GET /v1/catalog` — capabilities, schemas, constraints, price
- `GET /.well-known/agent-catalog.json` — crawler-friendly catalog alias
- `GET /openapi.json` — OpenAPI 3.1 contract
- `GET /llms.txt` — concise agent-readable index
- `GET /.well-known/agent-card.json` — A2A 1.0 Agent Card
- `POST /a2a` — A2A 1.0 JSON-RPC `SendMessage` adapter at a fixed $0.020 test-USDC price
- `POST /mcp` — stateless Streamable HTTP MCP server with free catalog, quote, and call-preparation tools
- `skills/extract-text-to-json/` — portable agent skill
- x402 Bazaar metadata — automatically attached when payments are enabled

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

The report contains request and payment counts, settled test-USDC revenue, estimated DIEM cost and gross margin, latency percentiles, and coarse failure counts. It cannot reconstruct individual customer content or identity.

## Security and legal notes

Read [SECURITY.md](SECURITY.md) and [docs/END_USER_TERMS_CHECKLIST.md](docs/END_USER_TERMS_CHECKLIST.md) before accepting third-party work. AI output matching a schema is not proof that its contents are correct. Do not use this worker for high-stakes decisions.

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
