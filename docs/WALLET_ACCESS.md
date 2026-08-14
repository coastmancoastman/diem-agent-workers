# Accessing the treasury wallet

The treasury is a standard Base-compatible EVM account. Its public address is stored in `.env`; its private key is stored in your Mac login Keychain under the label **DIEM Agent Workers Treasury**.

## Import a seed-backed account

For recoverability, create a new, dedicated wallet in a trusted wallet app and record its seed phrase offline. Never put the seed phrase in this project, Keychain item, terminal, or chat.

In the wallet app, export the private key for the one dedicated treasury account. Then, from an interactive Terminal window in this project directory, run:

```bash
pnpm wallet:import
```

If Terminal reports `pnpm: command not found`, use the locally installed project command instead:

```bash
/opt/homebrew/bin/npx --no-install tsx scripts/import-treasury-wallet.ts
```

Paste that one account private key into the command's hidden prompt. The command derives and displays the public address before making changes. Compare it character-for-character with the account in your wallet app, then enter the requested confirmation. The command stores the private key in Keychain, updates only the public address in `.env`, and removes the previous empty Keychain item after the replacement succeeds.

The command cannot determine whether a private key was derived from a seed phrase. You must verify the displayed address in the wallet app and keep that dedicated wallet's seed phrase offline.

## Verify access without revealing the key

From the project directory, run:

```bash
pnpm wallet:verify
```

Without `pnpm`, use:

```bash
/opt/homebrew/bin/npx --no-install tsx scripts/verify-treasury-wallet.ts
```

This reads the Keychain item locally, derives its public address, confirms it matches `.env`, and displays Base ETH, USDC, and DIEM balances. It never prints the private key.

## Reveal the key locally for wallet import

Only do this when you are ready to import the account into a trusted wallet application.

1. Open **Keychain Access** on your Mac using Spotlight.
2. Select the `login` keychain and the Passwords category.
3. Search for **DIEM Agent Workers Treasury**.
4. Open the matching item. Confirm its account field equals the public treasury address shown by `pnpm wallet:verify`.
5. Select **Show password** and authenticate with your Mac password or Touch ID.
6. Copy the revealed `0x` private key directly into the trusted wallet application's **Import account** flow.
7. Clear the clipboard immediately and close Keychain Access.

Never paste the key into ChatGPT, Codex, email, GitHub, a website, a shell command, or a support conversation. The one exception is the hidden prompt opened by `pnpm wallet:import`. Neither Venice nor a wallet provider's support team needs the private key.

## Recovery warning

An account imported from an unrelated private key is not restored by another wallet's seed phrase. For the recommended setup, make sure the treasury address was originally created by the dedicated seed phrase you recorded offline. Before funding the wallet, test that you can access both the wallet app and Keychain item.

## Funding

The wallet requires a small amount of ETH **on Base** for approval and swap gas. Send only a tiny test amount first and verify it with `pnpm wallet:verify`. Do not send ETH on Ethereum mainnet or another network to test the Base balance display.
