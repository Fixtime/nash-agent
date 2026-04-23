# Nash Agent

Nash Agent is a local-first product strategy copilot for product managers. It turns a PRD, feature brief, or any other text case into a compact multi-player game model and helps evaluate whether a launch is strategically stable before engineering work begins.

## Value for a Product Manager

- Turns a raw case description into a structured Nash-style analysis without requiring manual game theory setup.
- Infers the most relevant actors, their incentives, and strategy choices from a product brief.
- Estimates payoffs across strategy profiles and highlights stable equilibria, risks, and likely break moves.
- Separates `Nash score` from `confidence`, so the PM can distinguish a strong position from an incomplete model.
- Makes iteration fast: a finished analysis can be reopened, its conditions adjusted, and relaunched as a new case.
- Works with a local LLM through LM Studio, so sensitive product strategy can stay on the PM's machine.

## What the App Does

- Case wizard for entering a product strategy or feature case.
- Automatic player and strategy generation from case description and context.
- Multi-player Nash analysis with recommended equilibrium, payoff views, and risk signals.
- Streaming LLM progress during analysis.
- History of completed, failed, and cancelled cases.
- Ability to inspect the original case inputs and relaunch a modified version.

## Architecture

The project is organized as a single full-stack TypeScript app:

- `client/`
  - React app with Wouter routing.
  - Tailwind CSS + shadcn/ui components.
  - Recharts-based result visualizations.
  - Pages:
    - `NewAnalysis.tsx` for creating and relaunching cases.
    - `AnalysisView.tsx` for result dashboards and source-case inspection.
    - `History.tsx` for saved analyses, stop, and delete flows.

- `server/`
  - Express server and API routes.
  - SSE streaming for analysis progress.
  - OpenAI SDK integration targeting either OpenAI-compatible APIs or LM Studio.
  - Local fallback debug mode for end-to-end UI testing without a real model.

- `shared/`
  - Shared Drizzle schema and TypeScript types used by both server and client.

- `SQLite + Drizzle`
  - Local analysis persistence with `better-sqlite3`.
  - Drizzle schema for analyses and result storage.

## Analysis Flow

1. The PM describes a case and adds optional strategic context.
2. The server asks the LLM to infer the compact set of core players and strategies.
3. The backend generates a bounded strategy-profile space.
4. The LLM evaluates payoffs and returns strategic interpretation.
5. The backend computes equilibria, confidence, verdict, pairwise views, and dashboard output.
6. The frontend renders the result and stores it in local history.

## Stack

- Express
- React
- Tailwind CSS
- shadcn/ui
- Drizzle ORM
- SQLite
- OpenAI SDK
- Recharts
- Wouter
- TanStack Query

## Local Run

### 1. Install dependencies

```bash
npm install
```

### 2. Create local environment

Copy `.env.example` to `.env` and adjust values if needed.

Default configuration is already aligned with LM Studio:

```env
DEBUG_LOCAL_LLM=false
OPENAI_BASE_URL=http://127.0.0.1:1234/v1
OPENAI_API_KEY=lm-studio
LLM_MODEL=auto
LLM_TIMEOUT_MS=900000
PORT=5000
HOST=127.0.0.1
```

### 3. Start an LLM

You can run the app in either mode:

- `LM Studio mode`
  - Start LM Studio.
  - Load any OpenAI-compatible local model.
  - Keep the local server exposed at `http://127.0.0.1:1234/v1`.

- `Debug mode`
  - Set `DEBUG_LOCAL_LLM=true` in `.env`.
  - This is useful for UI and workflow debugging when no real model is available.

### 4. Start the app

```bash
npm run dev
```

Then open:

- `http://127.0.0.1:5000/#/`
- if loopback is blocked in an embedded browser, use `http://127.0.0.1.nip.io:5000/#/`

### 5. Type-check

```bash
npm run check
```

## Notes

- The local SQLite database is stored in `nash.db` and is intentionally ignored by git.
- `.env` is ignored by git as well.
- The project currently focuses on local development flow. If you need production build and deployment, add or restore a production `build` pipeline before shipping.
