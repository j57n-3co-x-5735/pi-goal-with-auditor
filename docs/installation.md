# Installation

## Privacy-Conscious Installation (Recommended)

This method avoids unnecessary network requests by using the pre-built artifact directly.

### 1. Clone the repository

```bash
git clone https://github.com/j57n-3co-x-5735/pi-goal-with-auditor.git \
  ~/.pi/agent/git/github.com/j57n-3co-x-5735/pi-goal-with-auditor
```

### 2. Install the runtime dependency

The built artifact externalizes `typebox` (Pi provides the other dependencies at runtime). Install it in the extension directory:

```bash
cd ~/.pi/agent/git/github.com/j57n-3co-x-5735/pi-goal-with-auditor
npm install --ignore-scripts typebox@1.2.8
```

### 3. Register the extension

Add the source to Pi's settings file (`~/.pi/agent/settings.json`):

```json
{
  "packages": [
    "git:github.com/j57n-3co-x-5735/pi-goal-with-auditor"
  ]
}
```

### 4. Restart Pi

The `/goal` command should now appear in autocomplete.

## Standard Installation

```bash
pi install git:github.com/j57n-3co-x-5735/pi-goal-with-auditor
```

This clones the repo, runs `npm install --omit=dev`, and registers the package automatically. It works but fetches dependencies from npm on every install and update.

## Updating

To update without re-fetching dependencies:

```bash
cd ~/.pi/agent/git/github.com/j57n-3co-x-5735/pi-goal-with-auditor
git pull
```

The pre-built `dist/index.js` is committed to the repository, so pulling includes the latest artifact. Restart Pi after pulling.

Do **not** use `pi update` for manual installations — it runs `git clean -fdx` which deletes `node_modules` and then re-downloads everything.

## Building From Source

If you want to modify the extension and rebuild it, use `pnpm` (see `pnpm-workspace.yaml` / `pnpm-lock.yaml`), not `npm`:

```bash
cd ~/.pi/agent/git/github.com/j57n-3co-x-5735/pi-goal-with-auditor
pnpm install --ignore-scripts   # install all deps (dev + runtime)
pnpm build                      # produces dist/index.js
pnpm typecheck                  # verify types
pnpm test                       # run test suite
```

After building, pin any new dependencies to their resolved versions, so later installs and updates don't need to reach the network to fetch them.

### Pre-Commit Hooks

Committing triggers `lefthook` pre-commit hooks (see `lefthook.yml`), scoped by glob to whatever you're changing: `pnpm typecheck` runs when `src/**/*.ts` or `tsconfig.json` are staged, `pnpm test` runs when `src/**/*.ts` or `test/**/*.ts` are staged, and `pnpm build && git add dist/index.js` runs when `src/**/*.ts`, `package.json`, `tsconfig.json`, or `pnpm-lock.yaml` are staged. That last hook rebuilds `dist/index.js` and re-stages it automatically — you don't need to build or `git add` the bundle by hand, but it does mean the committed bundle always reflects your latest source, not whatever you built earlier.

### Continuous Integration

`.github/workflows/ci.yml` runs on every push and pull request to `main`: `pnpm install --frozen-lockfile`, then `typecheck`, `test`, and `build`, in that order. This is a backstop to the local lefthook hooks above — lefthook only runs if you have it installed and don't bypass it with `--no-verify`; CI runs regardless.

## Verifying the Installation

Start Pi and type `/goal`. You should see the command in autocomplete. Run `/goal test the auditor` to set a goal, do some work, then observe the auditor session spawn when the agent calls `update_goal`.
