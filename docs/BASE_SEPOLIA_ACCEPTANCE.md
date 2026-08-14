# Base Sepolia acceptance evidence

Verified against `https://diem-agent-workers.vercel.app` on 2026-08-13. These transactions use faucet-only Base Sepolia test USDC; they are not mainnet funds.

## Release gates

- Service version: `0.2.0`
- Payment mode: `development` (`eip155:84532`)
- Saved local payment mode: `off`
- Saved treasury mode: `disabled`
- Venice native API-key ceiling: `1.69 DIEM / EPOCH`
- Unpaid valid requests: HTTP `402` with one exact test-USDC payment option
- Paid requests: HTTP `200` with a successful `PAYMENT-RESPONSE`
- Treasury delta across seven release calls: exactly `0.090000` test USDC (six workers plus one transcription metadata refresh)
- Publishable-file secret scan: no Venice key, CDP secret, EVM private key, or PEM private key found
- Local verification: TypeScript check, 36 tests, build, OpenAPI generation, and high-severity dependency audit passed

## Settled workers

| Worker | Price | Settlement | Output check |
|---|---:|---|---|
| `extract_text_to_json` | $0.020 | [`0xc6ce…e1e82`](https://sepolia.basescan.org/tx/0xc6ce921ed6450270a4b154de6dd3e1c23b57ab948222467d441548c33ecf1e82) | Strict schema-valid JSON |
| `classify_text` | $0.005 | [`0xf8ac…07687`](https://sepolia.basescan.org/tx/0xf8ac923bcb3f467e94fc888c717e3e454db89d05d833792bf47399344cf07687) | Permitted label and validated structured result |
| `summarize_text` | $0.005 | [`0x278d…ba64c`](https://sepolia.basescan.org/tx/0x278d6453fe22b798e4fa8f7b10945aafe6330c5f0ba5a092c5408adfa4eba64c) | Validated abstract and three key points |
| `text_to_speech` | $0.010 | [`0x80b9…e7edc`](https://sepolia.basescan.org/tx/0x80b990846cb75a9c3c55646c25a2c986913bf2ad9459b166a622f7eaa34e7edc) | `audio/mpeg`, 10,989 bytes |
| `generate_draft_image` | $0.020 | [`0x6198…1f0d9`](https://sepolia.basescan.org/tx/0x61980a6e6b14055f5d30aaa311bdee24a4e6dd89e54209c61f93e6350381f0d9) | `image/webp`, 80,132 bytes |
| `transcribe_audio` | $0.015 | [`0xaac9…15836`](https://sepolia.basescan.org/tx/0xaac96df23d24c2ea60cf1f309bf37fe6e87c31dc9211dd188fd96470c4015836) | Validated transcription of a 0.1-second silent PCM WAV; repeated after replacing the discovery placeholder with a runnable WAV example |

The acceptance runner uses a new ephemeral buyer key held only in process memory, verifies chain, asset, recipient, scheme, and exact price before signing, then checks both buyer and treasury token deltas after settlement.

## Discovery evidence

Each direct worker declares the x402 Bazaar discovery extension with a bounded input schema, concrete example, output example, description, exact price, and Base Sepolia network. The production logs returned Bazaar `processing` acknowledgements, and follow-up semantic searches returned all six routes with their exact prices, Bazaar metadata, and `eip155:84532` network.

Re-run the comprehensive acceptance test with compiled JavaScript to avoid development-loader overhead:

```bash
pnpm build
X402_TEST_BASE_URL=https://diem-agent-workers.vercel.app \
  node dist/scripts/test-sepolia-all-workers.js
```
