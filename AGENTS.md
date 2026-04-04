# Repository Guidelines

## Project Structure & Module Organization
This repository is currently unscaffolded: there is no application code, test suite, or build configuration yet. Keep the root limited to docs and project config. When adding the first feature, use this layout:

- `src/` for runtime code
- `tests/` for automated tests
- `assets/` for sample images or other static media
- `scripts/` for repeatable developer utilities

Group code by feature and mirror source names in tests. Example: `src/faceswap/pipeline.js` with `tests/faceswap/pipeline.test.js`.

## Build, Test, and Development Commands
No build or test commands are configured yet. The first contributor who adds tooling should expose a small, stable command set from the repository root and update this file.

Recommended minimum interface:

- `npm run dev` or equivalent for local development
- `npm test` for the full test suite
- `npm run lint` for formatting and static checks

If a different stack is used, keep the same intent and document the exact commands in `README.md` and this file.

## Coding Style & Naming Conventions
Use 2-space indentation for JavaScript or TypeScript and 4 spaces for Python if either language is introduced. Prefer small modules, descriptive file names, and consistent casing:

- `kebab-case` for file names
- `camelCase` for variables and functions
- `PascalCase` for classes and component-like types

Add a formatter and linter with the first code contribution, and commit their config together.

## Testing Guidelines
No test framework is present yet. New behavior should not land without automated coverage once one is added. Use names such as `*.test.js`, `test_*.py`, or the framework default, and keep fixtures in `tests/fixtures/` when needed.

Until automation exists, include clear manual verification steps in each pull request.

## Commit & Pull Request Guidelines
There is no Git history in this directory yet, so no local commit convention can be inferred. Use Conventional Commits, for example `feat: add swap pipeline skeleton` or `fix: handle missing input image`.

Pull requests should include:

- a short problem statement
- a summary of the change
- test results or manual verification steps
- sample inputs or screenshots when UI or image output changes

## Security & Configuration Tips
Do not commit secrets, API keys, or large model weights. Keep environment-specific values in ignored `.env` files, and store large binaries outside Git unless the repository later adopts Git LFS.

## Review guidelines
- Write final pull request reviews, summary comments, and follow-up fix completion messages in Korean by default unless the PR author explicitly requests another language. Keep code identifiers, file paths, API fields, error codes, and commands in their original language.
- Treat secret exposure, authentication bypass, privilege escalation, and any leak of private media or sensitive public data as P0.
- Treat any change that weakens GitHub OIDC deployment boundaries, IAM least privilege, bucket policies, CloudFront or API access controls, WAF protections, or request throttling as P0 when it can expose data or expand access beyond the intended boundary.
- Verify the async job pipeline end to end: uploaded media must stay under `uploads/`, generated media under `results/`, failed enqueue paths must not leave orphaned job state, and worker retry or DLQ behavior must remain safe to repeat.
- Flag missing tests or missing manual verification steps as P1 when a change affects API contracts, job lifecycle state, IAM or deployment behavior, public dashboard calculations, or frontend upload and polling flows.
- Flag missing documentation as P1 when a change alters deployment inputs, required GitHub or AWS settings, API request or response fields, public dashboard semantics, or incident-response and verification steps.
- Flag validation regressions, TTL cleanup regressions, async pipeline integrity issues, and other behavior changes that can break upload, job, retry, DLQ, or result delivery guarantees as P1.
- Flag changes that break the public dashboard privacy contract, especially if they expose `jobId`, upload keys, file names, presigned URLs, raw stack traces, or AWS resource identifiers that are currently kept internal. Treat this as P0 when it leaks private media or other sensitive data, otherwise treat it as P1.
- Only flag high-confidence issues that are directly tied to the changed diff. Do not speculate.
- Ignore minor style or naming issues unless they affect correctness, security, or operability.
