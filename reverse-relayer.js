const { ethers } = require("ethers");
const { execSync, spawnSync } = require("child_process");
const fs = require("fs");

const MONAD_RPC        = "https://monad-mainnet.g.alchemy.com/v2/Uwb7T0DbXMQHjiJBNf9_b005qYjLmJqk";
const USDCC_ADDRESS    = "0x85822c2c6F2924Bb211e0eaC24C592e7b7412036";
const POLL_INTERVAL_MS = 10_000;
const BLOCKS_PER_POLL  = 9;

const ABI = [
  "event BridgeToNear(address indexed from, string nearRecipient, uint256 amount, uint256 bridgeId)"
];

const STATE_FILE = "./processed_reverse.json";
function loadProcessed() {
  try { return new Set(JSON.parse(fs.readFileSync(STATE_FILE))); }
  catch { return new Set(); }
}
function saveProcessed(set) {
  fs.writeFileSync(STATE_FILE, JSON.stringify([...set]));
}

async function mintOnNear(nearRecipient, amount18, bridgeId) {
  const amount6 = (BigInt(amount18) / BigInt(10 ** 12)).toString();
  console.log(`[NEAR MINT] bridge_id=${bridgeId} → ${nearRecipient} amount=${amount6}`);
  
  const args = [
    "contract", "call-function", "as-transaction",
    "usdcc-token.gemsrock-nft.near", "mint",
    "json-args", JSON.stringify({ account_id: nearRecipient, amount: amount6 }),
    "prepaid-gas", "30.0 Tgas",
    "attached-deposit", "0 NEAR",
    "sign-as", "usdcc-token.gemsrock-nft.near",
    "network-config", "mainnet",
    "sign-with-keychain", "send"
  ];

  // Retry up to 3 times
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = spawnSync("near", args, { encoding: "utf8", timeout: 60000 });
    const output = result.stdout + result.stderr;
    if (output.includes("succeeded") || output.includes("Transaction ID")) {
      const txMatch = output.match(/Transaction ID: (\S+)/);
      console.log(`[NEAR MINT] tx: ${txMatch?.[1] || "ok"}`);
      return true;
    }
    if (output.includes("expired") || output.includes("timeout")) {
      console.log(`[RETRY] attempt ${attempt}/3 - transaction expired, retrying...`);
      await new Promise(r => setTimeout(r, 2000));
      continue;
    }
    console.error(`[NEAR MINT ERROR] attempt ${attempt}:`, output.slice(-300));
    if (attempt < 3) await new Promise(r => setTimeout(r, 2000));
  }
  return false;
}

async function main() {
  const provider = new ethers.JsonRpcProvider(MONAD_RPC);
  const contract = new ethers.Contract(USDCC_ADDRESS, ABI, provider);
  const processed = loadProcessed();

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
          const nearRecipient = e.args.nearRecipient;
          const amount = e.args.amount.toString();
          if (processed.has(bridgeId)) { console.log(`[SKIP] bridge_id=${bridgeId}`); continue; }
          console.log(`[FOUND] bridge_id=${bridgeId} from=${e.args.from} → ${nearRecipient} amount=${amount}`);
          const ok = await mintOnNear(nearRecipient, amount, bridgeId);
          if (ok) {
            processed.add(bridgeId);
            saveProcessed(processed);
            console.log(`[OK] bridge_id=${bridgeId} minted on NEAR`);
          }
        }
      }
      lastBlock = latest;
    } catch (err) {
      console.error(`[LOOP ERROR] ${err.message}`);
    }
  }
}

main();
