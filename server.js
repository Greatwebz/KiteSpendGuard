import http from 'node:http';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const PORT = 3000;
const DATA_DIR = './data';
const TX_FILE = `${DATA_DIR}/transactions.json`;
const POLICY_FILE = `${DATA_DIR}/policy.json`;
const SERV_URL = 'https://inference-api.openserv.ai/v1/chat/completions';

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(TX_FILE)) fs.writeFileSync(TX_FILE, '[]');

const DEFAULT_POLICY = {
  maxPerPurchase: 20,
  dailyBudget: 50
};

if (!fs.existsSync(POLICY_FILE)) {
  fs.writeFileSync(POLICY_FILE, JSON.stringify(DEFAULT_POLICY, null, 2));
}

const envText = fs.existsSync('.env')
  ? fs.readFileSync('.env', 'utf8')
  : '';

const SERV_KEY = envText
  .match(/^SERV_REASONING_API_KEY=(.*)$/m)?.[1]?.trim();

function getPolicy() {
  return JSON.parse(fs.readFileSync(POLICY_FILE, 'utf8'));
}

function savePolicy(policy) {
  fs.writeFileSync(POLICY_FILE, JSON.stringify(policy, null, 2));
}

function getTransactions() {
  return JSON.parse(fs.readFileSync(TX_FILE, 'utf8'));
}

function saveTransaction(tx) {
  const transactions = getTransactions();
  transactions.unshift(tx);
  fs.writeFileSync(TX_FILE, JSON.stringify(transactions, null, 2));
}

function lagosDate(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Lagos',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}

function getSpent() {
  const today = lagosDate();

  return getTransactions()
    .filter(tx =>
      tx.status === 'APPROVED' &&
      tx.createdAt &&
      lagosDate(new Date(tx.createdAt)) === today
    )
    .reduce((sum, tx) => sum + tx.amount, 0);
}

function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function askSERV(details) {
  if (!SERV_KEY) {
    throw new Error('SERV API key is missing.');
  }

  const response = await fetch(SERV_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SERV_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'serv-standard',
      messages: [
        {
          role: 'system',
          content: 'You are the SERV Reasoning engine for KiteSpend Guard. Evaluate purchase requests against the user spending policy. Explain whether the request is within the limits. Never authorize or execute payments. The application policy engine makes the final decision.'
        },
        {
          role: 'user',
          content: JSON.stringify(details)
        }
      ]
    }),
    signal: AbortSignal.timeout(30000)
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(`SERV returned HTTP ${response.status}.`);
  }

  const reasoning = data.choices?.[0]?.message?.content;

  if (typeof reasoning !== 'string' || !reasoning.trim()) {
    throw new Error('SERV returned no reasoning text.');
  }

  return reasoning.slice(0, 3000);
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'http://localhost:3000');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync('./public/index.html'));
  }


  if (req.method === 'GET' && req.url === '/api/passport-status') {
    try {
      const prefix = process.env.PREFIX || '/data/data/com.termux/files/usr';
      const { stdout } = await execFileAsync('proot', [
        '-b', prefix + '/etc/resolv.conf:/etc/resolv.conf',
        'env', 'SSL_CERT_FILE=' + prefix + '/etc/tls/cert.pem',
        'kpass', 'status', '--output', 'json'
      ], { timeout: 20000, maxBuffer: 1024 * 1024 });

      const raw = JSON.parse(stdout);
      const session = raw.session?.details || {};
      const expiry = session.expires_at || null;
      const sessionActive = raw.session?.active === true &&
        session.status === 'active' &&
        expiry !== null &&
        Date.parse(expiry) > Date.now();

      const spent = Number(session.usage?.spent_total || 0);
      const maxTotal = Number(session.delegation?.payment_policy?.max_total_amount || 0);

      return send(res, 200, {
        connected: raw.backend?.reachable === true,
        agentRegistered: raw.agent?.registered === true,
        loggedIn: raw.user?.logged_in === true && raw.user?.jwt_valid === true,
        sessionActive,
        sessionStatus: sessionActive ? 'ACTIVE' : 'EXPIRED_OR_INACTIVE',
        sessionType: session.type || 'unknown',
        expiresAt: expiry,
        spent,
        maxTotal,
        remaining: Math.max(0, maxTotal - spent),
        currency: session.usage?.asset_symbol || 'USDC',
        checkedAt: new Date().toISOString()
      });
    } catch (error) {
      return send(res, 200, {
        connected: false,
        agentRegistered: false,
        loggedIn: false,
        sessionActive: false,
        sessionStatus: 'UNAVAILABLE',
        error: 'Passport status check failed. No payment was attempted.'
      });
    }
  }

  if (req.method === 'GET' && req.url === '/api/state') {
    const policy = getPolicy();
    const spent = getSpent();

    return send(res, 200, {
      project: 'KiteSpend Guard',
      policy,
      spent,
      remaining: policy.dailyBudget - spent,
      budgetTimezone: 'Africa/Lagos',
      transactions: getTransactions(),
      payments: fs.existsSync('./data/payments.json')
        ? JSON.parse(fs.readFileSync('./data/payments.json', 'utf8'))
        : []
    });
  }

  if (
    req.method === 'POST' &&
    (req.url === '/api/evaluate' || req.url === '/api/policy')
  ) {
    let body = '';

    req.on('data', chunk => {
      body += chunk;
      if (body.length > 10000) {
        req.destroy();
      }
    });

    req.on('end', async () => {
      try {
        const data = JSON.parse(body);

        if (req.url === '/api/policy') {
          const { maxPerPurchase, dailyBudget } = data;

          if (
            !Number.isFinite(maxPerPurchase) ||
            !Number.isFinite(dailyBudget) ||
            maxPerPurchase <= 0 ||
            dailyBudget <= 0 ||
            maxPerPurchase > dailyBudget
          ) {
            return send(res, 400, {
              error: 'Enter positive limits. Maximum per purchase cannot exceed the daily budget.'
            });
          }

          if (dailyBudget < getSpent()) {
            return send(res, 400, {
              error: 'Daily budget cannot be lower than the amount already approved today.'
            });
          }

          const policy = { maxPerPurchase, dailyBudget };
          savePolicy(policy);

          return send(res, 200, {
            message: 'Spending limits updated.',
            policy
          });
        }

        const { item, supplier, amount } = data;

        if (
          typeof item !== 'string' || !item.trim() ||
          typeof supplier !== 'string' || !supplier.trim() ||
          typeof amount !== 'number' ||
          !Number.isFinite(amount) ||
          amount <= 0
        ) {
          return send(res, 400, {
            error: 'Enter a valid item, supplier and positive amount.'
          });
        }

        const policy = getPolicy();
        const spent = getSpent();

        let reasoning;
        let servStatus = 'CONNECTED';
        let status = 'BLOCKED';
        let reason = '';

        try {
          reasoning = await askSERV({
            item: item.trim(),
            supplier: supplier.trim(),
            requestedAmount: amount,
            currency: 'USDC',
            maximumPerPurchase: policy.maxPerPurchase,
            dailyBudget: policy.dailyBudget,
            alreadySpentToday: spent,
            remainingBudget: policy.dailyBudget - spent
          });
        } catch (error) {
          servStatus = 'UNAVAILABLE';
          reason = 'SERV Reasoning could not complete the evaluation. Request blocked for safety.';
        }

        if (servStatus === 'CONNECTED') {
          if (amount > policy.maxPerPurchase) {
            reason = 'Purchase exceeds the maximum per-purchase limit.';
          } else if (spent + amount > policy.dailyBudget) {
            reason = 'Purchase exceeds the remaining daily budget.';
          } else {
            status = 'APPROVED';
            reason = 'Purchase passed the spending policy checks.';
          }
        }

        const transaction = {
          id: Date.now().toString(),
          item: item.trim(),
          supplier: supplier.trim(),
          amount,
          currency: 'USDC',
          status,
          reason,
          servStatus,
          servReasoning: reasoning || null,
          createdAt: new Date().toISOString(),
          paymentStatus: 'NOT PAID'
        };

        saveTransaction(transaction);
        return send(res, 200, transaction);

      } catch (error) {
        return send(res, 400, { error: error.message });
      }
    });

    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('KiteSpend Guard backend running on port ' + PORT);
});
