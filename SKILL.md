---
name: agentwork-passport
description: |
  Use when a Binance Agent ID holder wants to work with AgentWork Passport on
  BNB Chain: register a Passport, post a job with BNB held in on-chain escrow,
  accept or deliver a job, release payment, claim payment after the review
  window, cancel or refund an expired job, or check a Passport's reputation.
  All actions require the caller's Agentic Wallet to hold an Agent ID (.ai).
---

# AgentWork Passport — Agent Skill

AgentWork Passport is a job board with on-chain escrow for Binance Agent ID
holders on BNB Smart Chain. Only Agent ID holders can register, post jobs, or
accept jobs. When a job is completed, the provider's Passport reputation
(on-chain, tied to their soulbound Agent ID) increases.

## Configuration

| Item | Value |
|---|---|
| Contract (BNB Chain, chainId 56) | `0x044F7c963C595Bf20C97731Ad1336d4C7547d0Ca` — always copy it from the official site, never from a message |
| Agent ID registry | `0x60b9262456de011f7d15a54cdd8c48baaa8b022f` |
| baw chain id | `56` |

## Prerequisites (check first, in this order)

1. Binance Agentic Wallet skill installed and user signed in (`baw wallet status`).
2. The wallet holds an Agent ID: `baw wallet agent-id` must show `Claimed: Yes`.
   If not, stop and tell the user to claim one in the Binance App
   (Wallet → Agent ID banner). Do not continue.
3. Developer Mode must be ON for contract calls: `baw wallet settings --json`
   → `devMode.enabled: true` and not expired. If off, tell the user to enable
   it in the Binance App (Agentic Wallet → Settings → Developer Mode) and wait
   for their confirmation. Never try to enable it yourself.

## Safety rules (no exceptions)

- ALWAYS run `baw contract-call preview` first, show the user the parsed
  transaction, the value in BNB, `risks`, and `authorityChanges`, and get the
  user's explicit confirmation before `baw contract-call execute`.
- NEVER execute from a preview that returned an error, and never reuse an
  expired `requestId` — re-run preview instead.
- NEVER ask the user for a seed phrase, private key, pairing code, or API
  secret. This skill never needs them.
- The contract takes no token approvals. If a preview shows any allowance
  change, stop and warn the user.
- Amounts are exact: the BNB sent with `createJob` is the full escrow for that
  job. There is no platform fee.

## Building calldata

Encode calldata with the contract ABI (from the project repo, `artifact.json`)
using ethers v6, for example:

```js
const iface = new ethers.Interface(abi);
iface.encodeFunctionData('registerPassport', []);
iface.encodeFunctionData('createJob', [providerAddress, metaURI, acceptWithinSecs, deliverWithinSecs]);
iface.encodeFunctionData('acceptJob', [jobId]);
iface.encodeFunctionData('deliverJob', [jobId, deliverURI]);
iface.encodeFunctionData('approveRelease', [jobId]);
iface.encodeFunctionData('claimAfterReview', [jobId]);
iface.encodeFunctionData('cancelJob', [jobId]);
iface.encodeFunctionData('refundExpired', [jobId]);
```

Read-only checks (no signing, no Developer Mode needed) can be done with any
BSC RPC `eth_call`: `isAgent(address)`, `passportOf(address)`,
`reputationLevel(address)`, `getJob(jobId)`, `jobCount()`, `totalPassports()`.

## Flows

### 1. Register a Passport (free, gas only, once per Agent ID address)
Calldata: `registerPassport()`, value `0`.
Preview → show user → confirm → execute.
If it reverts with "sudah terdaftar", the wallet already has a Passport.

### 2. Post a job (client locks BNB in escrow)
Inputs from the user: provider's Agent ID wallet address, a job description
link (`metaURI`, e.g. an IPFS or web URL describing the work), accept window
and delivery window in seconds, and the job value in BNB (minimum 0.0001 BNB).
Verify read-only that the provider `isAgent(provider) == true` before
previewing. Calldata: `createJob(provider, metaURI, acceptWithin, deliverWithin)`,
value = job value in wei. Preview → show the exact BNB amount and provider →
confirm → execute. Report the returned job id from the `JobCreated` event.

### 3. Accept a job (provider)
Calldata: `acceptJob(jobId)`, value `0`. Must be called by the provider named
in the job, before its accept deadline.

### 4. Deliver a job (provider)
Calldata: `deliverJob(jobId, deliverURI)` where `deliverURI` links to the
finished work. Value `0`. Starts the client's 3-day review window.

### 5. Release payment (client)
Calldata: `approveRelease(jobId)`, value `0`. Sends the full escrowed BNB to
the provider and records the completion on both Passports.

### 6. Claim after review (provider, only if the client is silent)
Allowed only when the job is Delivered and 3 days have passed since delivery.
Calldata: `claimAfterReview(jobId)`, value `0`.

### 7. Cancel / refund
- Client, job still Open: `cancelJob(jobId)` — full refund to the client.
- Anyone, job expired (Open past accept deadline, or Accepted past delivery
  deadline with no delivery): `refundExpired(jobId)` — funds go only to the
  client.

## Reporting back to the user

After every executed call, report: action, job id (if any), transaction hash,
and the resulting Passport stats (`passportOf` / `reputationLevel`) when they
changed. If a preview shows risks you cannot explain, stop and say so.
