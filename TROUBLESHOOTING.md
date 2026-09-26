# Troubleshooting

Install pitfalls; the README keeps only the install command.

## Bundle auto-mount (since 0.1.1)

The package declares `dsh.bundle`, so `dsh plugin add` and the marketplace one-click install auto-mount it: dsh registers the plugin as a profile layer automatically and no manual `cordis.patch.yml` edits are needed. Restart dsh after installing.

Manual mount (legacy versions or special layouts only): add to the `insert` list of `$DSH_HOME/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-self-improved
      name: dsh-self-improved
```

## GitHub source install prep (only if the install fails)

- Make the pnpm store directory consistent with `node_modules` (pnpm store-dir config), e.g. in a profile-level `.npmrc`.
- Allow prepare builds for git-installed packages (pnpm >= 10 blocks by default); in `pnpm-workspace.yaml`:

```yaml
allowBuilds:
  dsh-self-improved: true
```

## Peer-dependencies double instance (resume fails)

**Symptom**: after install, new sessions work but resuming an old session errors with `deployment:persona already registered`, hinting "register through that agent's agent.ctx instead".

**Root cause** (not a plugin bug): pnpm's default `autoInstallPeers` installs the plugin's `@deepseek-ai/*` peerDependencies as physical copies inside the profile's `node_modules`, creating two independent module instances of the same packages as the ones embedded in the dsh main install (e.g. `dsh-scope`). DSH scoping (preset/persona layers) binds identity via `Symbol("dsh.scope")`; with two instances the persona registration lands in the global layer and collides with the host's `deployment:persona`, so resume fails. New sessions happen to succeed because the global layer is not yet occupied on first registration.

**Fix** (verified):
1. Replace the redundant `@deepseek-ai/*` physical copies in the profile with symlinks to the packages embedded in the dsh main install (dsh's self-healing layout `$DSH_HOME/profiles/node_modules`).
2. Set `auto-install-peers=false` in a profile-level `.npmrc` (or turn off `autoInstallPeers` in `pnpm-workspace.yaml`).

Note for packagers: peerDependencies may be auto-installed as physical copies in the profile; use the dsh self-healing symlink layout, or set `auto-install-peers=false` in the profile's `.npmrc`. The repo lockfile is for development only; profile installs should keep `auto-install-peers=false`.

## Duplicate loader entry id (boot crash)

**Symptom**: dsh fails to start (window flashes and closes), and `dsh --profile web --dump-config` shows the same entry `id` twice.

**Root cause**: packages declaring `dsh.bundle` (this plugin since 0.1.1, `dsh-plugin-marketplace`, etc.) are added to `dsh.profile.bundles` automatically, and their bundled `cordis.patch.yml` inserts one entry; if the profile-level `cordis.patch.yml` also inserts the same id manually, the loader throws `duplicate loader entry id` at boot.

**Fix** (verified): remove the duplicate `dsh-self-improved` entry from the profile-level `cordis.patch.yml`; bundle plugins auto-mount via `dsh.profile.bundles`, so do not manually insert them at the profile layer. Reset the file to `[]` only if it contains nothing else.

**Debug tip**: if dsh crashes at startup, run `dsh --profile web --dump-config` and count each entry id; more than one occurrence is this problem.
