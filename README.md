# KiteSpend Guard

AI-assisted spending control dashboard built with OpenServ SERV Reasoning and KITE Agent Passport.

## Features
- AI-assisted purchase evaluation
- Configurable spending limits
- Independent local policy enforcement
- KITE Agent Passport integration
- Approved and blocked transaction history
- x402 API payment history
- Mobile-friendly dashboard

## How it works
1. Submit a purchase request.
2. SERV Reasoning provides an assessment.
3. The local policy engine checks spending limits.
4. The request is approved or blocked.
5. The decision is recorded.

**Note:** Approval does not mean a supplier payment was executed.

## Setup
Requires Node.js and npm.

Run npm install, then npm start.

Open http://localhost:3000 in your browser.

## Security
Never publish API keys, .env files or private credentials.
