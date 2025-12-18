## Claude Behavior Rules

- Do NOT generate skeleton or placeholder code.
- Always produce production-ready, complete implementations.
- Never remove security, encryption, or rate-limiting logic.
- If a change impacts database schema or message flow, explain the impact before modifying code.


# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

WhatsApp SaaS Platform for selling services through AI-powered conversations. The application consists of:
- **Backend**: Express.js API with PostgreSQL (Prisma ORM), Socket.io for real-time updates, Baileys for WhatsApp integration, and multi-provider AI system
- **Frontend**: Next.js 14 dashboard (App Router) with Tailwind CSS, SWR for data fetching, and Socket.io client

## Development Commands

### Backend (from `backend/` directory)

```bash
# Development
npm run dev                 # Start dev server with tsx watch

# Database
npm run db:generate         # Generate Prisma client
npm run db:push            # Push schema to database
npm run db:migrate         # Run migrations
npm run db:seed            # Seed database with initial data

# Build & Production
npm run build              # Compile TypeScript to dist/
npm start                  # Run production server from dist/

# Code Quality
npm run lint               # ESLint check
npm run typecheck          # TypeScript type checking

# Utilities
npm run encrypt-keys       # Encrypt API keys for storage
```

### Frontend (from `frontend/` directory)

```bash
# Development
npm run dev                # Start Next.js dev server (port 3000)

# Build & Production
npm run build              # Build production Next.js app
npm start                  # Run production server

# Code Quality
npm run lint               # Next.js lint
npm run typecheck          # TypeScript type checking
```

## Architecture Overview

### Backend Service Architecture

The backend follows a layered service-oriented architecture:

1. **Entry Point** (`src/index.ts`): Initializes services in this order:
   - Database connection
   - AI service (loads and initializes AI providers)
   - Socket.io server
   - Conversation service (sets up WhatsApp message handlers)
   - WhatsApp accounts reconnection (re-establishes previously connected accounts)

2. **Core Services**:
   - **WhatsAppService** (`services/whatsapp.service.ts`): Manages multiple WhatsApp account instances using Baileys, handles QR code generation, connection state, message sending/receiving, and rate limiting (30 messages/60s per account)
   - **AIService** (`services/ai.service.ts`): Multi-provider AI orchestration with automatic failover, daily limits, and priority-based selection. Supports Claude, Gemini, Groq, and Cohere
   - **ConversationService** (`services/conversation.service.ts`): Processes incoming WhatsApp messages, manages conversation context, handles order creation workflow, and coordinates between WhatsApp and AI services
   - **CloudinaryService** (`services/cloudinary.service.ts`): Handles media uploads (images, documents, payment proofs)
   - **SessionStorageService** (`services/session-storage.service.ts`): Encrypts and stores WhatsApp session data in PostgreSQL

3. **Message Flow**:
   ```
   WhatsApp → WhatsAppService (emits 'message' event)
   → ConversationService.handleIncomingMessage()
   → Saves message to DB
   → Builds conversation context
   → AIService.generateResponse() (tries providers by priority)
   → Sends AI response via WhatsAppService
   → Updates conversation state
   ```

4. **Real-time Updates**: Socket.io broadcasts events for:
   - WhatsApp connection state changes
   - New messages
   - Order status updates
   - QR code generation

### Database Schema Key Relationships

- **WhatsAppAccount** → **Customer** (1:many): Each customer belongs to one WhatsApp account
- **Customer** → **Order** (1:many): Customer order history
- **Customer** → **Conversation** (1:many): Tracks conversation sessions with status (ACTIVE, WAITING_PAYMENT, COMPLETED, ABANDONED)
- **Service** → **Package** (1:many, cascade delete): Services contain multiple pricing packages
- **Package** → **Order** (1:many): Orders reference specific packages
- **Order** → **OrderAction** (1:many): Audit trail of order status changes
- **AIProvider**: Tracks API keys (encrypted), daily usage limits, priority, and active status
- **Message**: Links to Customer, WhatsAppAccount, and optionally Conversation; stores content, media URLs, and AI metadata

### Frontend Architecture

- **App Router Structure** (`src/app/`): Next.js 14 file-based routing
  - Each route has `page.tsx` for the UI
  - Uses Server Components by default, Client Components marked with `'use client'`

- **API Client** (`src/lib/api.ts`): Centralized API calls with JWT auth token management

- **Socket.io Integration** (`src/hooks/useSocket.ts`): Real-time updates hook used across dashboard pages

- **Data Fetching**: Uses SWR for client-side data fetching with automatic revalidation and caching

## Key Configuration

### Environment Variables

Backend requires:
- `DATABASE_URL`: PostgreSQL connection string
- `JWT_SECRET`: For auth tokens (32+ chars recommended)
- `WHATSAPP_SESSION_SECRET`: For encrypting WhatsApp session data
- `CLOUDINARY_*`: Cloud storage credentials
- AI provider API keys (at least one): `CLAUDE_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `COHERE_API_KEY`
- `CORS_ORIGIN`: Comma-separated list of allowed origins
- `ADMIN_EMAIL`, `ADMIN_PASSWORD`: Initial admin credentials (set before first run)

Frontend requires:
- `NEXT_PUBLIC_API_URL`: Backend API endpoint
- `NEXT_PUBLIC_WS_URL`: WebSocket endpoint

### TypeScript Configuration

- Backend uses **strict mode** with NodeNext modules (ES modules, `.js` extensions in imports required)
- Frontend uses Next.js bundler with path alias `@/*` for `src/*`
- Both projects have strict null checks and unused variable detection enabled

## Important Implementation Patterns

### WhatsApp Session Management

- Sessions are encrypted before storage using AES-256-GCM with `WHATSAPP_SESSION_SECRET`
- WhatsApp accounts can be in states: DISCONNECTED, CONNECTING, CONNECTED, BANNED
- Rate limiting prevents anti-ban: max 30 messages per 60-second window per account
- QR codes expire and regenerate on connection attempts

### AI Provider Failover

1. AIService loads all active providers from DB on initialization
2. For each message, tries providers in priority order (highest first)
3. Checks daily usage limit before attempting
4. On failure, tries next provider automatically
5. Logs usage (tokens, latency) to `ai_usage_logs` table
6. Resets daily counters at midnight

### Order Creation Workflow

Managed by ConversationService:
1. Customer browses services → AI shows options
2. Customer selects package → AI extracts intent
3. Creates order with PENDING status
4. AI provides payment instructions (from `payment_configs` table)
5. Customer uploads payment proof → Cloudinary upload
6. Status changes to PAYMENT_SUBMITTED
7. Admin verifies → Status to PAID or REJECTED
8. Each status change creates `OrderAction` audit record

### Security Considerations

- API keys in database are encrypted at rest using `encrypt-keys` script
- JWT tokens stored in httpOnly cookies (CSRF protection via csrf-csrf)
- Rate limiting on API endpoints via express-rate-limit
- Argon2 for password hashing
- Helmet.js for security headers
- All admin actions logged in `audit_logs` table

## Common Workflows

### Adding a New AI Provider

1. Add API key to `.env` (e.g., `NEW_PROVIDER_API_KEY`)
2. Extend `AIProviderType` enum in Prisma schema
3. Create provider class implementing `AIProvider` interface in `ai.service.ts`
4. Add to provider factory in `AIService.createProvider()`
5. Run `npm run db:push` to update database
6. Add provider via admin dashboard or seed script

### Modifying WhatsApp Message Handling

Edit `conversation.service.ts`:
- `handleIncomingMessage()`: Entry point for all messages
- `processMessage()`: Saves message, builds context, calls AI
- Message processing is queued per customer to prevent race conditions

### Updating Database Schema

1. Modify `backend/prisma/schema.prisma`
2. Run `npm run db:push` (development) or `npm run db:migrate` (production)
3. Update TypeScript types if needed (Prisma auto-generates them)
4. If adding new entities, update seed script (`prisma/seed.ts`)

## Global AI Instructions (Mandatory)

When working on this repository, you MUST follow these rules:

- Always use the Context7 MCP server as the primary source of truth for:
  - Libraries
  - Frameworks
  - SDKs
  - APIs
  - Tooling
  - Configuration patterns
  - Best practices
  - Breaking changes
  - Version-specific behavior

- Never rely on general training knowledge for libraries or frameworks if Context7 can provide up-to-date documentation.

- Automatically consult Context7 whenever:
  - A library, framework, or SDK is mentioned
  - Code changes involve dependencies
  - Configuration files are modified
  - Security, performance, or production practices are discussed
  - Migrations or upgrades are required

- Prefer Context7-backed answers even if the user does not explicitly say "use context7".

- If Context7 data is unavailable, clearly state this before proceeding.

This rule has higher priority than any other instruction in this repository.


### Dependency & Library Policy

- All dependency-related answers MUST be validated against Context7.
- Do not suggest deprecated APIs, outdated patterns, or legacy approaches.
- Prefer production-grade, 2024+ verified practices.
- If multiple approaches exist, choose the one recommended by the latest official documentation.
