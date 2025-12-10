const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const StellarSdk = require('@stellar/stellar-sdk');

// 🔑 Load environment variables from .env (for local dev)
require('dotenv').config();

// Stellar Config from environment
const NETWORK_PASSPHRASE = process.env.NETWORK_PASSPHRASE || "Test SDF Network ; September 2015";
const HORIZON_URL = process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org';
const server = new StellarSdk.Horizon.Server(HORIZON_URL, {
  allowHttp: true,
  networkPassphrase: NETWORK_PASSPHRASE
});

// DB Setup
const DB_FILE = path.join(__dirname, 'healthstash-db.json');
if (!fs.existsSync(DB_FILE)) {
  fs.writeFileSync(DB_FILE, JSON.stringify({ wallets: {} }, null, 2));
}

function loadDB() { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
function saveDB(data) { fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2)); }

// 🔑 Get issuer from environment variable (required for Render)
function getOrCreateIssuer() {
  const issuerSecret = process.env.ISSUER_SECRET;
  if (!issuerSecret) {
    throw new Error('ISSUER_SECRET environment variable is required');
  }
  try {
    return StellarSdk.Keypair.fromSecret(issuerSecret);
  } catch (e) {
    throw new Error('Invalid ISSUER_SECRET: ' + e.message);
  }
}

// 🏥 Create dedicated pharmacy wallet
async function getOrCreatePharmacy() {
  const db = loadDB();
  
  if (!db.wallets['pharmacy']) {
    const pharmacy = StellarSdk.Keypair.random();
    db.wallets['pharmacy'] = {
      stellarPubkey: pharmacy.publicKey(),
      stellarSecret: pharmacy.secret(),
      type: 'provider'
    };
    saveDB(db);
    
    // Fund pharmacy
    await fetch(`https://friendbot.stellar.org?addr=${pharmacy.publicKey()}`).catch(() => {});
    await new Promise(r => setTimeout(r, 3000));
    
    // Create trustline to HEALTH asset
    const issuer = getOrCreateIssuer();
    const asset = new StellarSdk.Asset('HEALTH', issuer.publicKey());
    
    try {
      let issuerAcc = await server.loadAccount(issuer.publicKey());
      const tx = new StellarSdk.TransactionBuilder(issuerAcc, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE
      })
      .addOperation(StellarSdk.Operation.changeTrust({
        asset: asset,
        source: pharmacy.publicKey(),
        limit: '1000000'
      }))
      .setTimeout(30)
      .build();
      
      tx.sign(issuer);
      tx.sign(pharmacy);
      await server.submitTransaction(tx);
    } catch (e) {
      if (!e.message.includes('already exists')) {
        console.error('Pharmacy trustline error:', e.message);
      }
    }
  }
  
  return StellarSdk.Keypair.fromSecret(db.wallets['pharmacy'].stellarSecret);
}

// 💰 Hardcoded employee from your successful transaction
const EMPLOYEE_PUBLIC = "GB55CHFS6VY35HML3LRVZYUSMVCCKF2EZTFMCT4OEY7AQCYDMYBMNYGY";
const EMPLOYEE_SECRET = "SDQT5G3RFIDCBEBZY44XABQ23B3FUAYQARAJ5F3DBKTTZ753TXFP445O";

// Get REAL balance from Stellar
async function getRealBalance(stellarPubKey, assetIssuer) {
  try {
    const account = await server.loadAccount(stellarPubKey);
    const bal = account.balances.find(b => 
      b.asset_code === 'HEALTH' && b.asset_issuer === assetIssuer
    );
    return bal ? parseFloat(bal.balance) : 0;
  } catch (e) {
    return 0;
  }
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// MINT → Uses your exact employee key
app.post('/api/mint', async (req, res) => {
  try {
    const { amount } = req.body;
    if (!amount) return res.status(400).json({ error: 'Amount required' });

    const issuer = getOrCreateIssuer();
    const asset = new StellarSdk.Asset('HEALTH', issuer.publicKey());

    // Ensure employee in DB
    const db = loadDB();
    db.wallets['EMP001'] = {
      stellarPubkey: EMPLOYEE_PUBLIC,
      stellarSecret: EMPLOYEE_SECRET
    };
    saveDB(db);

    // Build transaction
    let issuerAcc = await server.loadAccount(issuer.publicKey());
    const tx = new StellarSdk.TransactionBuilder(issuerAcc, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE
    })
    .addOperation(StellarSdk.Operation.changeTrust({
      asset: asset,
      source: EMPLOYEE_PUBLIC,
      limit: '1000000'
    }))
    .addOperation(StellarSdk.Operation.payment({
      destination: EMPLOYEE_PUBLIC,
      asset: asset,
      amount: amount.toString()
    }))
    .setTimeout(30)
    .build();

    tx.sign(issuer);
    tx.sign(StellarSdk.Keypair.fromSecret(EMPLOYEE_SECRET));
    const result = await server.submitTransaction(tx);

    res.json({
      success: true,
      txHash: result.hash,
      explorerUrl: `https://horizon-testnet.stellar.org/transactions/${result.hash}`
    });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message || 'Mint failed' });
  }
});

// SPEND → Uses your exact employee key + real pharmacy
app.post('/api/spend', async (req, res) => {
  try {
    const { amount } = req.body;
    if (!amount) return res.status(400).json({ error: 'Amount required' });

    const issuer = getOrCreateIssuer();
    const asset = new StellarSdk.Asset('HEALTH', issuer.publicKey());
    const empKey = StellarSdk.Keypair.fromSecret(EMPLOYEE_SECRET);
    const pharmacy = await getOrCreatePharmacy();

    // Get real balance
    const realBal = await getRealBalance(EMPLOYEE_PUBLIC, issuer.publicKey());
    if (realBal < amount) return res.status(400).json({ error: 'Insufficient balance' });

    let empAcc = await server.loadAccount(EMPLOYEE_PUBLIC);
    const tx = new StellarSdk.TransactionBuilder(empAcc, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE
    })
    .addOperation(StellarSdk.Operation.payment({
      destination: pharmacy.publicKey(),
      asset: asset,
      amount: amount.toString()
    }))
    .setTimeout(30)
    .build();

    tx.sign(empKey);
    const result = await server.submitTransaction(tx);

    res.json({
      success: true,
      txHash: result.hash,
      explorerUrl: `https://horizon-testnet.stellar.org/transactions/${result.hash}`
    });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message || 'Spend failed' });
  }
});

// BALANCE → Reads from your exact employee key
app.get('/api/balance/:employeeId', async (req, res) => {
  try {
    const issuer = getOrCreateIssuer();
    const balance = await getRealBalance(EMPLOYEE_PUBLIC, issuer.publicKey());
    res.json({ balance });
  } catch (err) {
    res.json({ balance: 0 });
  }
});

// PROVIDER → Reads from dedicated pharmacy
app.get('/api/provider', async (req, res) => {
  try {
    const pharmacy = await getOrCreatePharmacy();
    const issuer = getOrCreateIssuer();
    const balance = await getRealBalance(pharmacy.publicKey(), issuer.publicKey());
    res.json({ total: balance, transactions: [] });
  } catch (err) {
    res.json({ total: 0, transactions: [] });
  }
});

// HISTORY
app.get('/api/history/:employeeId', (req, res) => {
  res.json([]);
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: '✅ HealthStash POC Running' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 HealthStash POC running at http://localhost:${PORT}`);
});
