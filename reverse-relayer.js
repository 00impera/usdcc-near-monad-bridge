const { ethers } = require("ethers");
const { connect, keyStores, KeyPair } = require("near-api-js");
const fs = require("fs");

const MONAD_RPC        = "https://monad-mainnet.g.alchemy.com/v2/Uwb7T0DbXMQHjiJBNf9_b005qYjLmJqk";
const USDCC_ADDRESS    = "0x85822c2c6F2924Bb211e0eaC24C592e7b7412036";
const POLL_INTERVAL_MS = 10_000;
const BLOCKS_PER_POLL  = 9;
const NEAR_TOKEN       = "usdcc-token.gemsrock-nft.near";
const NEAR_SIGNER      = "usdcc-token.gemsrock-nft.near";
const NEAR_RPC         = "https://near.lava.build";

const ABI = ["event BridgeToNear(address indexed from, string nearRecipient, uint256 amount, uint256 bridgeId)"];

const STATE_FILE = "./processed_reverse.json";
function loadProcessed() {
  try { return new Set(JSON.parse(fs.readFileSync(STATE_FILE))); }
  catch { return new Set(); }
}
function saveProcessed(set) {
  fs.writeFileSync(STATE_FILE, JSON.stringify([...set]));
}

async function getNearAccount() {
  const nearKey = process.env.NEAR_KEY;
  if (!nearKey) throw new Error("NEAR_KEY env variable not set");
  const keyPair = KeyPair.fromString(nearKey);
  const keyStore = new keyStores.InMemoryKeyStore();
  await keyStore.setKey("mainnet", NEAR_SIGNER, keyPair);
  const near = await connect({ networkId: "mainnet", keyStore, nodeUrl: NEAR_RPC });
  return await near.account(NEAR_SIGNER);
}

async function mintOnNear(account, nearRecipient, amount18, bridgeId) {
  const amount6 = (BigInt(amount18) / BigInt(10 ** 12)).toString();
  console.log(`[NEAR MINT] bridge_id=${bridgeId} → ${nearRecipient} amount=${amount6}`);
  try {
    const result = await account.functionCall({
      contractId: NEAR_TOKEN,
      methodName: "mint",
      args: { account_id: nearRecipient, amount: amount6 },
      gas: "30000000000000",
      attachedDeposit: "0",
    });
    console.log(`[NEAR MINT] tx: ${result.transaction.hash}`);
    return true;
  } catch (err) {
    console.error(`[NEAR MINT ERROR]`, err.message);
    return false;
  }
}

async function main() {
  const provider = new ethers.JsonRpcProvider(MONAD_RPC);
  const contract = new ethers.Contract(USDCC_ADDRESS, ABI, provider);
  const processed = loadProcessed();
  const account = await getNearAccount();
  console.log(`[REVERSE RELAYER] NEAR account: ${account.accountId}`);

  let lastBlock = await provider.getBlockNumber();
  console.log(`[REVERSE RELAYER] Watching Monad from block ${lastBlock}`);

  while (true) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    try {
      const latest = await provider.getBlockNumber();
      for (let from = lastBlock + 1; from <= latest; from += BLOCKS_PER_POLL) {
        const to = Math.min(from + BLOCKS_PER_POLL - 1, latest);
        const events = await contract.queryFilter(contract.filters.BridgeToNear(), from, to);
        for (const e of events) {
          const bridgeId = e.args.bridgeId.toString();
          if (processed.has(bridgeId)) { console.log(`[SKIP] bridge_id=${bridgeId}`); continue; }
          console.log(`[FOUND] bridge_id=${bridgeId} → ${e.args.nearRecipient}`);
          const ok = await mintOnNear(account, e.args.nearRecipient, e.args.amount.toString(), bridgeId);
          if (ok) { processed.add(bridgeId); saveProcessed(processed); console.log(`[OK] bridge_id=${bridgeId}`); }
        }
      }
      lastBlock = latest;
    } catch (err) {
      console.error(`[LOOP ERROR] ${err.message}`);
    }
  }
}
main();

// Keepalive HTTP server for Render
const http = require("http");
http.createServer((req, res) => res.end("USDCC Reverse Relayer Running")).listen(process.env.PORT || 3001);
