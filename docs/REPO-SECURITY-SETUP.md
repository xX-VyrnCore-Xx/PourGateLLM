# Repository security: the settings only you can switch on

The repository ships with Dependabot, CodeQL, dependency review and hardened workflows, but a few protections are
**GitHub settings** that cannot be changed from code. Do these once (about five minutes), in *Settings* of the repository.

## Code security (Settings → Code security)

| Setting | Why |
|---|---|
| **Dependency graph** — on | Needed by Dependabot and the dependency review. |
| **Dependabot alerts** — on | Tells you when a dependency has a known vulnerability. |
| **Dependabot security updates** — on | Opens a fix PR immediately (the auto-merge workflow then merges it when CI is green). |
| **Private vulnerability reporting** — on | Lets people report a problem privately, as SECURITY.md promises. |
| **Secret scanning** and **Push protection** — on | Blocks pushes that contain API keys or tokens. |
| **Code scanning** — leave "Default setup" off | The CodeQL workflow in the repo already does it; two setups would conflict. |

## Actions (Settings → Actions → General)

- **Workflow permissions**: *Read repository contents and packages permissions* (the workflows ask for more only where needed).
- **Allow GitHub Actions to create and approve pull requests**: **on** (Dependabot auto-merge needs to enable auto-merge on pull requests).
- **Fork pull request workflows**: *Require approval for all outside collaborators*.
- **Actions permissions**: *Allow GitHub, and select non-GitHub, actions* → allow actions created by GitHub and Marketplace verified creators (the workflows use `actions/*`, `github/codeql-action`, `docker/*`, `pnpm/action-setup`, `dtolnay/rust-toolchain`, `dependabot/fetch-metadata`).

## Branch protection (already configured, check it still reads like this)

On `main`: require a pull request, require the **`check`** status check to pass, require linear history, and keep
**Allow auto-merge** on (Settings → General → Pull Requests) together with **Automatically delete head branches**.

## Packages

*Packages → pourgatellm → Package settings*: visibility **Public** (so installs work without a login), and link the package to the repository.

## Verify it worked

- *Security* tab shows "Dependabot alerts", "Code scanning" and "Secret scanning" as enabled.
- A Dependabot pull request appears within a day and merges itself once `check` is green (major updates stay open for you).
- After the next release, the Releases page lists only the three newest versions.
