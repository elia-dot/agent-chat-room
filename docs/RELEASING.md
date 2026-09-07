# Public release checklist

Publish the **root `agent-chat-room` package**. The four workspace packages are private
implementation details; the root artifact includes their compiled output and the web app.

## Prepare the repository

- Keep source, tests, the lockfile, docs, license and contribution templates tracked.
  Dependencies, build output, `.env` files, logs, tarballs and `.codegraph/` are ignored.
  You do not need to delete local worktrees or installed dependencies to go public.
- Inspect `git status --short` and `git ls-files`. Review tracked content **and Git history**
  for credentials, private code/data, personal paths and third-party assets before exposing
  the repository. Ignore rules do not remove previously committed content. Also review old
  issues, PRs and Actions logs that will become visible. Rotate any exposed credentials.
- Keep the Denly attribution and logo; confirm rights to included third-party material.
- Run the checks below on the final release revision. Do not use `git clean -fdx` as a
  publication step: it deletes ignored local files and is unnecessary.

## GitHub settings (repository administrator)

These are hosted settings; changing files in a checkout cannot enable them.

1. In repository **Settings → General → Danger Zone**, change visibility to **Public** after
   reviewing GitHub's disclosure warning. See [GitHub's visibility guide](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility).
2. Under **Features**, enable **Issues**. The existing bug/feature issue templates and PR
   template will guide contributors. Accept contributions through forks and pull requests
   against `main`; contributors do not need write access to this repository.
3. Enable [private vulnerability reporting](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository)
   so the private reporting link in `SECURITY.md` works.
4. Require passing CI and review on `main` using a branch rule/ruleset. Keep Actions
   permissions read-only for untrusted pull requests and review outside-contributor workflow
   runs before approving them. Confirm the CI workflow runs on a fork PR.
5. Check the README, logo, Issues, contribution guide and security reporting link while
   signed out. Visibility and enabled features must be verified separately from this checklist.

## Validate and inspect the package

Use a supported Node version and the committed lockfile:

```sh
npm ci
npm run build
npm test
npm run typecheck
npm run lint
npm run format:check
npm pack --dry-run
npm pack
```

`prepack` rebuilds the artifact for both `npm pack` and normal directory-based `npm publish`.
Inspect the file list: it should contain the CLI (including `loader.js`), core/server output,
web `dist` including `denly-logo.png`, package manifests, README, LICENSE and NOTICE.
It should not contain credentials, local databases, dependencies or test fixtures.

Install the resulting tarball in a temporary directory outside the repository to avoid
workspace symlinks masking missing package files. This step downloads production dependencies
and may build native SQLite; use an environment where those downloads are approved.

```sh
mkdir /tmp/acr-release-smoke
cd /tmp/acr-release-smoke
npm init -y
npm install /absolute/path/to/agent-chat-room-0.1.0.tgz
./node_modules/.bin/acr --version
./node_modules/.bin/acr --help
./node_modules/.bin/acr doctor --json
./node_modules/.bin/acr serve --port 4399 --no-open
```

Use a fresh temporary path if that directory exists, and substitute the actual versioned
tarball. Missing agent CLIs can make doctor exit nonzero; verify its JSON result. Open the
printed URL and check rooms, doctor, new-room form, light/dark themes and narrow layouts.
Use a disposable Git repository for an actual room; real agent turns consume provider usage.
Stop the smoke server with Ctrl-C. CI also installs the tarball and checks the CLI, health
endpoint and served HTML on macOS and Linux.

## Publish (maintainer)

Confirm that you control the npm name, the version has not been published, and the repository
URLs in `package.json` point to the public repository. Keep root/workspace versions and the
lockfile consistent when preparing a version change. Authenticate with the intended npm
account, then from the repository root:

```sh
npm whoami
npm publish --dry-run
npm publish --access public
```

Only the last command publishes. Follow npm's authentication requirements for that account.
See the [npm publish documentation](https://docs.npmjs.com/cli/v11/commands/npm-publish).
Do not publish all workspaces individually. Verify the published version with a clean
`npx agent-chat-room@<version> --version` and startup smoke test, then create release notes
for that revision through the project's version-control/release process.

A successful local build or pack is not evidence that npm publication, GitHub visibility,
issue settings or private reporting have been enabled.
