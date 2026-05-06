const { ethers } = require("ethers");

const NEAR_RPC          = "https://near.lava.build";
const MONAD_RPC         = "https://monad-mainnet.g.alchemy.com/v2/Uwb7T0DbXMQHjiJBNf9_b005qYjLmJqk";
const USDCC_ADDRESS     = "0x85822c2c6F2924Bb211e0eaC24C592e7b7412036";
const BRIDGE_CONTRACT   = "monad-bridge.gemsrock-nft.near";
const POLL_INTERVAL_MS  = 10_000;

const MINT_ABI = ["function mint(address to, uint256 amount) external"];

const fs = require("fs");
const STATE_FILE = "./processed.json";
function loadProcessed() {
  try { return new Set(JSON.parse(fs.readFileSync(STATE_FILE))); }
  catch { return new Set(); }
}
function saveProcessed(set) {
  fs.writeFileSync(STATE_FILE, JSON.stringify([...set]));
}

async function nearRpc(method, params) {
  const res = await fetch(NEAR_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
  const json = await res.json();
  if (json.error) throw new Error(`NEAR RPC error: ${JSON.stringify(json.error)}`);
  return json.result;
}

async function getContractLogs(fromBlock, toBlock) {
  const logs = [];
  try {
    const result = await nearRpc("block", { block_id: toBlock });
    const chunks = result.chunks;
    for (const chunk of chunks) {
      try {
        const chunkDetail = await nearRpc("chunk", { chunk_id: chunk.chunk_hash });
        for (const tx of (chunkDetail.transactions || [])) {
          try {
            const outcome = await nearRpc("EXPERIMENTAL_tx_status", [tx.hash, tx.signer_id]);
            for (const receipt of (outcome.receipts_outcome || [])) {
              for (const log of (receipt.outcome.logs || [])) {
                if (log.includes("USDCC_BRIDGE_TO_MONAD")) {
                  logs.push({ txHash: tx.hash, log });
                }
              }
            }
          } catch { }
        }
      } catch { }
    }
  } catch { }
  return logs;
}

function parseBridgeLog(log) {
  try {
    const data = JSON.parse(log);
    if (data.event !== "USDCC_BRIDGE_TO_MONAD") return null;
    if (!data.recipient || !data.amount || !data.bridge_id) return null;
    return { recipient: data.recipient, amount: data.amount, bridge_id: String(data.bridge_id) };
  } catch { return null; }
}

async function mintOnMonad(signer, recipient, amount, bridge_id) {
  const contract = new ethers.Contract(USDCC_ADDRESS, MINT_ABI, signer);
  console.log(`[MINT] bridge_id=${bridge_id} → ${recipient} amount=${amount}`);
  const tx = await contract.mint(recipient, BigInt(amount) * BigInt(10 ** 12));
  console.log(`[MINT] tx sent: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`[MINT] confirmed block=${receipt.blockNumber}`);
  return tx.hash;
}

async function getLatestBlockHeight() {
  const status = await nearRpc("status", []);
  return status.sync_info.latest_block_height;
}

// Fast catch-up: directly fetch known missed tx hashes
async function processTx(txHash, signer, signerAddr, processed) {
  try {
    const outcome = await nearRpc("EXPERIMENTAL_tx_status", [txHash, signerAddr]);
    for (const receipt of (outcome.receipts_outcome || [])) {
      for (const log of (receipt.outcome.logs || [])) {
        const parsed = parseBridgeLog(log);
        if (!parsed) continue;
        const key = parsed.bridge_id;
        if (processed.has(key)) { console.log(`[SKIP] bridge_id=${key}`); continue; }
        console.log(`[FOUND] bridge_id=${key} tx=${txHash}`);
        const monadTx = await mintOnMonad(signer, parsed.recipient, parsed.amount, key);
        processed.add(key);
        saveProcessed(processed);
        console.log(`[OK] bridge_id=${key} monad_tx=${monadTx}`);
      }
    }
  } catch (err) {
    console.error(`[ERROR] processTx: ${err.message}`);
  }
}

async function main() {
  if (!process.env.OWNER_PRIVATE_KEY) { console.error("ERROR: set OWNER_PRIVATE_KEY in .env"); process.exit(1); }
  const provider = new ethers.JsonRpcProvider(MONAD_RPC);
  const signer   = new ethers.Wallet(process.env.OWNER_PRIVATE_KEY, provider);
  console.log(`[RELAYER] Monad signer: ${signer.address}`);

  const processed = loadProcessed();
  console.log(`[RELAYER] Already processed: ${[...processed].join(", ") || "none"}`);

  // Catch up missed transactions manually
  const missedTxs = [
    { hash: "BbAizw6pPEchnxcJzt8Xsk3DtCS2kXDnbwbhj7CwaDq", signer: "gemsrock-nft.near" }, // bridge_id:5
    { hash: "D9yf9qXtdvtL1Ryx5bCuFheLRdS5z4ckha3WS4vZDpfD", signer: "gemsrock-nft.near" }, // bridge_id:6
    { hash: "FCVpHovgxXVZDEVapT68sxDV7TBdp7utLxLd72mt9vWv", signer: "gemsrock-nft.near" }, // bridge_id:7
    { hash: "2xU3RdYHVrUL3E8vB6nTVN3353kgMWJzCbRy7jb3wkMt", signer: "gemsrock-nft.near" }, // bridge_id:8
  ];
  console.log("[RELAYER] Processing missed transactions...");
  for (const tx of missedTxs) {
    await processTx(tx.hash, signer, tx.signer, processed);
  }

  // Now scan new blocks
  let lastScannedBlock = await getLatestBlockHeight();
  console.log(`[RELAYER] Now watching from block ${lastScannedBlock}`);

  while (true) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    try {
      const latestBlock = await getLatestBlockHeight();
      for (let h = lastScannedBlock + 1; h <= latestBlock; h++) {
        const entries = await getContractLogs(h, h);
        for (const { txHash, log } of entries) {
          const parsed = parseBridgeLog(log);
          if (!parsed) continue;
          const key = parsed.bridge_id;
          if (processed.has(key)) { console.log(`[SKIP] bridge_id=${key}`); continue; }
          console.log(`[FOUND] bridge_id=${key} tx=${txHash}`);
          try {
            const monadTx = await mintOnMonad(signer, parsed.recipient, parsed.amount, key);
            processed.add(key);
            saveProcessed(processed);
            console.log(`[OK] bridge_id=${key} monad_tx=${monadTx}`);
          } catch (err) {
            console.error(`[ERROR] mint failed bridge_id=${key}: ${err.message}`);
          }
        }
      }
      lastScannedBlock = latestBlock;
    } catch (err) {
      console.error(`[LOOP ERROR] ${err.message}`);
    }
  }
}

main();
