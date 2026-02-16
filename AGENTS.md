# Repository Guidelines

## Project Structure & Module Organization
This is an Express-based backend API for a POS system.

- `server.js`: main application entrypoint; registers middleware and API endpoints.
- `routes/`: route modules (for example `routes/ai.js`, `routes/branches.js`).
- `middleware/`: reusable request middleware (`auth`, rate limiting, validators).
- `utils/`: shared helpers (for example encryption utilities).
- `services/`: service-layer modules (expand this for external integrations/business logic).
- `migrate_due_date.js`: one-off migration script.
- `Dockerfile`: container build definition.

Keep new code close to its concern: route handlers in `routes/`, cross-cutting concerns in `middleware/`, pure helpers in `utils/`.

## Build, Test, and Development Commands
- `npm install`: install dependencies.
- `npm run dev`: run the API locally (currently same as `start`).
- `npm start`: start production-style server (`node server.js`).
- `node migrate_due_date.js`: run the due-date migration script.
- `docker build -t pos-backend .`: build the container image.

Note: `package.json` references `test-db` and `test-notify`, but corresponding scripts/files are not currently present in this repository.

## Coding Style & Naming Conventions
- Language/runtime: Node.js (CommonJS `require/module.exports`).
- Indentation: 4 spaces; keep semicolons and single quotes consistent with existing files.
- Naming: `camelCase` for variables/functions, `UPPER_SNAKE_CASE` for env vars, kebab/lowercase filenames (for example `rateLimiter.js`, `crypto.js`).
- Prefer small middleware/helpers over duplicating logic in large route handlers.

## Testing Guidelines
Automated test suites are not yet established (no Jest/Mocha config found). For now:

- Validate endpoints manually with Postman/cURL.
- Add focused test files when introducing critical logic (auth, payments, stock deductions).
- If you add a test framework, include scripts in `package.json` and keep test files near features or under a dedicated `tests/` directory.

## Commit & Pull Request Guidelines
Recent history follows Conventional Commits (`feat:`, `fix:`). Continue that format:

- Example: `feat: add branch-level sales summary endpoint`
- Example: `fix: handle missing x-store-id in auth flow`

PRs should include:
- Clear summary of behavior changes and affected endpoints.
- Linked issue/ticket (if available).
- API request/response examples for new or changed endpoints.
- Notes on env/config changes and migration impact.

## Security & Configuration Tips
- Never commit secrets; `.env` is ignored.
- Required env vars include Supabase keys and Gemini API key (see existing usage in `server.js` and `routes/ai.js`).
- Keep privileged operations on `SUPABASE_SERVICE_ROLE_KEY` paths limited and reviewed.
