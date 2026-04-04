# OpenAI Codex GitHub Review Setup

This checklist is for enabling OpenAI Codex pull request review on this repository with the smallest practical GitHub access scope.

## 5-minute checklist
1. Confirm prerequisites.
   You need a ChatGPT plan with Codex access, a GitHub account that can access this repository, and either repo admin access or an org owner/admin who can approve app installation or repository access.
2. Connect GitHub in Codex.
   Open `https://chatgpt.com/codex`, sign in, and connect your GitHub account when prompted.
3. Install or approve repository access.
   In the GitHub authorization flow, prefer `Only select repositories` and grant access only to this repository.
   If the repository belongs to an organization, ask an org owner/admin to approve the OpenAI Codex app or the requested repository access in GitHub.
4. Enable review in Codex settings.
   Open `https://chatgpt.com/codex/settings/code-review` and turn on `Code review` for this repository.
   Turn on `Automatic reviews` as well if you want Codex to review every PR when it becomes ready for review.
5. Smoke test on a pull request.
   Open any PR and comment `@codex review for security regressions, missing tests, and risky behavior changes.`
   Confirm that Codex reacts and posts a GitHub review on the PR.
6. Lock in repository-specific guidance.
   Keep the top-level `AGENTS.md` review guidance up to date so Codex prioritizes security, privacy, and operational regressions correctly for this service.
7. Verify the fix loop.
   If Codex finds a valid issue, reply in the same PR with `@codex fix it` or a more specific follow-up such as `@codex fix the missing tests and update the README`.

## GitHub roles and approvals
- Repo admin: can usually enable Codex review after GitHub is connected and the repository is visible in Codex settings.
- Org owner or GitHub admin: may need to approve the app installation or approve access to selected organization repositories before the repo appears in Codex.
- Security or platform owner: should verify that repository access is restricted to the minimum required repositories.

## Recommended PR workflow
- Let automatic reviews run on every non-draft PR.
- For higher-risk changes, add a manual prompt such as `@codex review for security regressions, missing tests, and risky behavior changes.`
- If Codex flags a real issue, ask for a targeted fix in-thread with `@codex fix it` or a narrower instruction.
- Keep user-facing PR comments in Korean by default so reviewers can read findings and fix summaries without translation overhead.
- Keep `AGENTS.md` severity rules focused on P0 and P1 because GitHub review mode surfaces only those priorities.

## Recommended settings for this repository
- Repository access: `Only select repositories`
- Automatic reviews: on for the main service repository
- Review trigger for manual runs: `@codex review`
- Fix trigger for follow-up tasks: `@codex fix it`
- Review comment language: Korean by default, with code identifiers and commands left as-is
- One-off focus examples:
  - `@codex review for security regressions`
  - `@codex review for missing tests and documentation regressions`
  - `@codex review for AWS IAM and OIDC risks`
  - `@codex review for public dashboard data leaks`

## Severity mapping for this repository
- `P0`: secret exposure, authentication bypass, privilege escalation, private media leakage, or other sensitive data leakage
- `P0`: IAM, OIDC, bucket policy, or access-control weakening that expands access beyond the intended boundary
- `P1`: missing tests or missing manual verification for risky behavior changes
- `P1`: missing documentation when deploy steps, required settings, API fields, or dashboard semantics changed
- `P1`: validation regressions, TTL cleanup regressions, and async pipeline integrity issues
- Only flag high-confidence issues that are directly tied to the changed diff. Do not speculate.
- Ignore routine style nits unless they hide a correctness, security, or operability problem

## Troubleshooting
- If the repository does not appear in Codex settings, wait a few minutes and re-check the GitHub app repository access.
- If the repository is org-owned, verify that the org owner/admin approved the app or the repository request in GitHub.
- If Codex is connected but does not comment on a PR, verify that `Code review` is enabled for the repo and retry with a fresh `@codex review` comment.

## Official references
- Codex GitHub integration: `https://developers.openai.com/codex/integrations/github`
- PR review use case: `https://developers.openai.com/codex/use-cases/github-code-reviews`
