# DIEM Agent Workers v0.2.0

The first public beta of a machine-discoverable x402 storefront powered by Venice AI.

## Included workers

- Structured data extraction — 0.01 USDC
- Text classification — 0.005 USDC
- Compact summarization — 0.01 USDC
- Speech generation — 0.02 USDC
- Image generation — 0.03 USDC
- Audio transcription — 0.015 USDC

## Agent discovery

- Coinbase x402 Bazaar discovery
- A2A agent card and JSON-RPC task endpoint
- MCP server and hosted tool catalog
- OpenAPI specification and `llms.txt`
- GitHub skill package for agent installation

## Safety posture

- Payments remain on Base Sepolia with faucet-only test USDC.
- Mainnet payments and the automated treasury remain disabled by default.
- Worker inputs are bounded, schema-validated, rate-limited, and treated as untrusted data.
- Venice inference is capped at 1.69 DIEM per epoch.
- Wallet and API credentials remain outside the repository in macOS Keychain or deployment secrets.

## Verification

- Type checking, 36 automated tests, production build, OpenAPI freshness, and dependency audit passed before release.
- All six paid workers completed live Base Sepolia x402 settlement tests.
- Seven acceptance calls transferred 0.09 faucet-only test USDC in total; public transaction evidence is recorded in `docs/BASE_SEPOLIA_ACCEPTANCE.md`.
