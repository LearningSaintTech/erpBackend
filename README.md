# ERP Factory — Backend API

Independent Express.js REST API for the Textile Manufacturing ERP.

## Prerequisites

- Node.js 20+
- MongoDB 7+ (local or Atlas)

## Setup

```bash
cd backend
npm install
cp .env.example .env   # or copy from ../.env.example
npm run seed
npm run dev
```

API: http://localhost:3000  
Health: http://localhost:3000/health  
Base path: `/api/v1`

## Environment

| Variable | Default |
|----------|---------|
| PORT | 3000 |
| MONGODB_URI | mongodb://localhost:27017/erpFactory |
| CORS_ORIGIN | http://localhost:5173,https://erp.khushpehno.com |
| JWT_SECRET | (set in production) |

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start with hot reload |
| `npm run seed` | Seed permissions, demo org, materials |
| `npm run smoke-test` | In-memory API smoke test |

## Frontend communication

The React frontend (`../frontend`) calls this API via `VITE_API_URL` (default `http://localhost:3000/api/v1`).  
CORS is enabled for the frontend origin. Send `Authorization: Bearer <token>` and `X-Factory-Id` headers.
