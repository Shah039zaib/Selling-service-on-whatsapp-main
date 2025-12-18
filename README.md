# WhatsApp SaaS Platform

Production-ready platform for selling services through AI-powered WhatsApp conversations.

## Overview

Multi-tenant WhatsApp service platform with automated AI conversations, order management, payment verification, and real-time admin dashboard. Built for reliability, security, and production deployment.

## Architecture

**Backend Stack:**
- Express.js with TypeScript (strict mode)
- PostgreSQL + Prisma ORM
- Baileys (WhatsApp Web API)
- Multi-provider AI (Claude, Gemini, Groq, Cohere) with automatic failover
- Socket.io for real-time updates
- Cloudinary for media storage

**Frontend Stack:**
- Next.js 14 (App Router)
- React 18 + Tailwind CSS
- SWR for data fetching
- Socket.io client

**Security:**
- Argon2 password hashing
- JWT authentication (httpOnly cookies)
- AES-256-GCM session encryption
- Helmet.js security headers
- Rate limiting (express-rate-limit)
- CSRF protection
- Comprehensive audit logging

## Requirements

- Node.js >= 18.0.0
- npm >= 9.0.0
- PostgreSQL 14+
- Cloudinary account
- At least one AI provider API key (Claude, Gemini, Groq, or Cohere)

## Environment Variables

### Backend (`backend/.env`)

| Variable | Description | Validation | Required |
|----------|-------------|------------|----------|
| `NODE_ENV` | Environment mode | `development` \| `production` \| `test` | Yes (default: `development`) |
| `PORT` | Server port | Number | Yes (default: `3001`) |
| `DATABASE_URL` | PostgreSQL connection string | Non-empty string | Yes |
| `JWT_SECRET` | JWT signing secret | Min 32 characters | Yes |
| `JWT_EXPIRES_IN` | JWT expiration time | String (e.g., `7d`) | Yes (default: `7d`) |
| `WHATSAPP_SESSION_SECRET` | Session encryption key | Min 16 characters | Yes |
| `CLOUDINARY_CLOUD_NAME` | Cloudinary cloud name | Non-empty string | Yes |
| `CLOUDINARY_API_KEY` | Cloudinary API key | Non-empty string | Yes |
| `CLOUDINARY_API_SECRET` | Cloudinary API secret | Non-empty string | Yes |
| `CLAUDE_API_KEY` | Anthropic Claude API key | String | No |
| `GEMINI_API_KEY` | Google Gemini API key | String | No |
| `GROQ_API_KEY` | Groq API key | String | No |
| `COHERE_API_KEY` | Cohere API key | String | No |
| `CORS_ORIGIN` | Allowed CORS origins (comma-separated) | String | Yes (default: `http://localhost:3000`) |
| `RATE_LIMIT_WINDOW_MS` | Rate limit window (ms) | Number | Yes (default: `60000`) |
| `RATE_LIMIT_MAX_REQUESTS` | Max requests per window | Number | Yes (default: `100`) |
| `LOG_LEVEL` | Logging level | `fatal` \| `error` \| `warn` \| `info` \| `debug` \| `trace` | Yes (default: `info`) |
| `ADMIN_EMAIL` | Initial admin email | Valid email address | Yes |
| `ADMIN_PASSWORD` | Initial admin password | Min 12 characters | Yes |

**Note:** Environment variables are validated on startup using Zod. Process exits with descriptive error if validation fails.

### Frontend (`frontend/.env.local`)

| Variable | Description | Required |
|----------|-------------|----------|
| `NEXT_PUBLIC_API_URL` | Backend API endpoint | Yes (default: `http://localhost:3001/api`) |
| `NEXT_PUBLIC_WS_URL` | WebSocket endpoint | Yes (default: `http://localhost:3001`) |

## Installation

### 1. Clone Repository

```bash
git clone <repository-url>
cd Selling-service-on-whatsapp-main
```

### 2. Backend Setup

```bash
cd backend
npm install
```

### 3. Configure Backend Environment

```bash
cp .env.example .env
```

Edit `backend/.env` with your credentials. **Critical:** Set strong `ADMIN_EMAIL` and `ADMIN_PASSWORD` (min 12 characters).

### 4. Database Setup

```bash
# Generate Prisma client
npm run db:generate

# Push schema to database
npm run db:push

# Seed initial data (creates admin user, payment configs)
npm run db:seed
```

### 5. Frontend Setup

```bash
cd ../frontend
npm install
cp .env.example .env.local
```

Edit `frontend/.env.local` to match your backend endpoints.

## Running the Application

### Development Mode

**Backend:**
```bash
cd backend
npm run dev
# Runs on port 3001 with hot reload (tsx watch)
```

**Frontend:**
```bash
cd frontend
npm run dev
# Runs on port 3000
```

**Access Dashboard:**
- URL: http://localhost:3000
- Login with `ADMIN_EMAIL` and `ADMIN_PASSWORD` from backend `.env`

### Production Mode

**Backend:**
```bash
cd backend
npm run build    # Compiles TypeScript to dist/
npm start        # Runs compiled code from dist/index.js
```

**Frontend:**
```bash
cd frontend
npm run build    # Builds optimized Next.js bundle
npm start        # Runs production server
```

## Health Check Endpoints

Health endpoints do **not** require authentication (for orchestrator support).

### `GET /health/live`

**Liveness probe** - Returns 200 if process is running.

**Response (200 OK):**
```json
{
  "status": "alive",
  "timestamp": "2025-12-18T10:30:00.000Z"
}
```

**Use case:** Container orchestrators use this to restart dead containers.

### `GET /health/ready`

**Readiness probe** - Returns 200 only if system is ready to serve traffic.

**Checks:**
- Database connectivity
- WhatsApp service initialized
- At least one AI provider available

**Response (200 OK):**
```json
{
  "status": "ready"
}
```

**Response (503 Service Unavailable):**
```json
{
  "status": "not_ready",
  "reason": "database_unreachable" | "whatsapp_not_initialized" | "ai_no_providers"
}
```

**Use case:** Load balancers route traffic only to ready instances.

## Testing

```bash
cd backend

# Run all tests
npm run test

# Run fast tests (excludes slow integration tests)
npm run test:fast

# Run CI mode (verbose, no color, bail on first failure)
npm run test:ci

# Watch mode
npm run test:watch
```

Tests use Vitest with supertest for HTTP endpoint testing.

## Crash Safety & Process Management

### Graceful Shutdown

Process handles `SIGTERM` and `SIGINT` signals:

1. Stops accepting new requests
2. Shuts down services in reverse initialization order:
   - Conversation service
   - WhatsApp service
   - AI service
   - Socket.io
   - Database connection
3. Closes HTTP server
4. Force exits after 10-second timeout if shutdown hangs

**Logs:**
```
{"level":"info","signal":"SIGTERM","msg":"Received shutdown signal"}
{"level":"info","msg":"Conversation service stopped"}
{"level":"info","msg":"WhatsApp service stopped"}
...
{"level":"info","msg":"HTTP server closed"}
```

### Crash Behavior

**`uncaughtException`:**
- Logs fatal error
- Exits immediately with code 1
- Process state is considered corrupted

**`unhandledRejection`:**
- Logs fatal error with promise details
- Exits immediately with code 1
- Process state may be corrupted

**Philosophy:** Fail-fast approach. Let process manager (PM2, Docker, K8s) restart the process with clean state.

### HTTP Request Timeout

- Global timeout: 30 seconds per request (configurable via `TIMEOUT_CONSTANTS.HTTP_REQUEST`)
- Returns 504 Gateway Timeout if exceeded
- Prevents resource exhaustion from hanging requests

## Deployment

### Docker

**Dockerfile pattern (backend):**
```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY backend/package*.json ./
RUN npm ci --production
COPY backend/ ./
RUN npm run build
CMD ["node", "dist/index.js"]
```

**Health checks:**
```dockerfile
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3001/health/live || exit 1
```

### PM2 (Process Manager)

**ecosystem.config.js:**
```javascript
module.exports = {
  apps: [{
    name: 'whatsapp-saas',
    script: './dist/index.js',
    cwd: './backend',
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production'
    }
  }]
};
```

**Commands:**
```bash
pm2 start ecosystem.config.js
pm2 logs whatsapp-saas
pm2 monit
```

### Kubernetes

**Deployment example:**
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: whatsapp-saas-backend
spec:
  replicas: 2
  template:
    spec:
      containers:
      - name: backend
        image: your-registry/whatsapp-saas:latest
        ports:
        - containerPort: 3001
        env:
        - name: NODE_ENV
          value: "production"
        livenessProbe:
          httpGet:
            path: /health/live
            port: 3001
          initialDelaySeconds: 10
          periodSeconds: 30
        readinessProbe:
          httpGet:
            path: /health/ready
            port: 3001
          initialDelaySeconds: 5
          periodSeconds: 10
```

### Cloud Platform Deployment

**Render:**
- Build command: `cd backend && npm install && npm run build`
- Start command: `cd backend && npm start`
- Add all environment variables from `.env.example`

**Railway/Heroku:**
- Buildpack: Node.js
- Start command: `npm start`
- Ensure `package.json` engines field specifies Node >= 18

**Database Providers:**
- Neon (PostgreSQL, recommended)
- Supabase
- AWS RDS
- Railway Postgres

## Production Checklist

- [ ] Set strong `JWT_SECRET` (min 32 chars, cryptographically random)
- [ ] Set strong `WHATSAPP_SESSION_SECRET` (min 16 chars)
- [ ] Set strong `ADMIN_PASSWORD` (min 12 chars, avoid defaults)
- [ ] Configure `CORS_ORIGIN` to your actual frontend domain (no wildcards in production)
- [ ] Enable HTTPS (mandatory for production WhatsApp usage)
- [ ] Configure `NODE_ENV=production`
- [ ] Set appropriate `LOG_LEVEL` (recommend `info` or `warn`)
- [ ] Configure rate limiting (`RATE_LIMIT_MAX_REQUESTS` per `RATE_LIMIT_WINDOW_MS`)
- [ ] Set up database backups (PostgreSQL dumps)
- [ ] Configure monitoring (health endpoint polling)
- [ ] Set up log aggregation (Datadog, Logtail, CloudWatch)
- [ ] Test graceful shutdown behavior
- [ ] Configure process manager restart policies
- [ ] Review Cloudinary upload limits

## Database Migrations

**Development:**
```bash
npm run db:push  # Push schema changes directly
```

**Production:**
```bash
npm run db:migrate  # Generate and apply migration files
```

**Prisma client regeneration:**
```bash
npm run db:generate  # After schema changes
```

## Troubleshooting

**Database connection fails:**
- Verify `DATABASE_URL` format: `postgresql://user:password@host:5432/dbname?sslmode=require`
- Check network connectivity to database host
- Verify SSL mode requirements (Neon requires `sslmode=require`)

**WhatsApp QR code not appearing:**
- Check Socket.io connection in browser console
- Verify `CORS_ORIGIN` includes frontend URL
- Check backend logs for Baileys errors

**AI responses not working:**
- Ensure at least one AI provider API key is valid
- Check `ai_providers` table has active providers
- Review `ai_usage_logs` for error details

**Process crashes immediately:**
- Check environment variable validation errors in logs
- Verify all required env vars are set
- Check database connectivity
- Review `uncaughtException` / `unhandledRejection` logs

## License

MIT

## Support

For production deployment support, open an issue on GitHub.
