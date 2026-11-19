# Releasing

## Preconditions

- `npm ci` has been run, so dev dependencies are present.
- `npm run check` passes locally (type check + 365 tests).
- The working tree is clean: `git status --porcelain` prints nothing.

## Version numbering

Semantic versioning. Before 1.0, a minor bump may change behaviour — say so in the
changelog rather than relying on the reader to infer it.

Update `version` in `package.json`, regenerate `package-lock.json` with
`npm install --package-lock-only --ignore-scripts`, and give the changelog a
matching heading with the release date.

## Build the artifact

```sh
npm pack
```

Produces `dsh-stage-handoff-<version>.tgz`. Inspect it before publishing:

```sh
npm pack --dry-run
```

The artifact contains **exactly** these 26 files and nothing else:

```text
LICENSE
NOTICE.md
README.md
README.en.md
README.zh-CN.md
CHANGELOG.md
cordis.patch.yml
package.json
assets/icon.svg
locale/en.json
locale/zh.json
lib/index.js
lib/prestep-log.js
lib/repeat-scan.js
lib/client.js
lib/config.js
lib/util.js
lib/usage.js
lib/cleanup.js
docs/ANCHOR-POLICY.md
docs/ARCHITECTURE.md
docs/CONFIGURATION.md
docs/PRIVACY.md
docs/RELEASING.md
docs/SECURITY.md
docs/VALIDATION.md
```

Verify the list with `npm pack --dry-run` instead of trusting this page. The page said
"exactly these files" while listing nine of them for several releases, and the
`lib/client.js` incident recorded below is exactly the kind of omission a stale list
lets through.

No `node_modules`, no `test/`, no `tsconfig.json`, no `tools/`. If a development file
shows up, fix the `files` array in `package.json` rather than deleting the file from the
tarball by hand.

## Attach to a GitHub release

The install command in both READMEs depends on one stable URL:

```text
https://github.com/WphiontaS/dsh-stage-handoff/releases/latest/download/dsh-stage-handoff-<version>.tgz
```

That works only if the asset **name stays fixed**. Rename the asset and every
existing install command breaks.

```sh
gh release create "v$(node -p "require('./package.json').version")" \
   dsh-stage-handoff-<version>.tgz \
   --title "dsh-stage-handoff <version>" \
   --notes-file <(sed -n '/^## \[/,/^## \[/p' CHANGELOG.md | head -n -1)
```

Upload the tarball exactly as `npm pack` named it — do not add the version to the
asset name a second time.

## Optional: publish to npm

Not required for installation; the release tarball is enough. If publishing:

```sh
npm publish --access public
```

An npm account with 2FA enabled is required. After publishing, verify that the
name resolves:

```sh
npm view dsh-stage-handoff version
```

Keep the package name in `package.json` and the release asset identical. If a
consumer installs from npm and another from the tarball, they must get the same
code — otherwise bug reports become unreconcilable.

## Re-installing the same version

pnpm resolves a `file:` dependency by path **and version**. If you replace the
tarball at the same path without bumping `version`, `dsh plugin add` prints
`Already up to date` and **does not read the new tarball** — the profile keeps the
old contents. This bit us once: a rebuilt tarball containing a new `lib/client.js`
appeared to install fine while `lib/client.js` was in fact absent, and `dsh.client`
read as `null`.

Always bump `version` for a release. When iterating locally without bumping:

```sh
dsh plugin --profile <name> remove dsh-stage-handoff
dsh plugin --profile <name> add ./dist/dsh-stage-handoff-<version>.tgz
```

Verify the contents actually landed rather than trusting the command's exit code:

```sh
node -e "const p=require('./node_modules/dsh-stage-handoff/package.json');console.log(p.dsh.client, p.exports['./client'])"
```

## Verification after release

Run the install command from the README **as written**, into a throwaway profile:

```sh
dsh plugin --profile scratch add https://github.com/WphiontaS/dsh-stage-handoff/releases/latest/download/dsh-stage-handoff-<version>.tgz
```

Then confirm:

1. `dsh plugin --profile scratch list` shows `dsh-stage-handoff`.
2. `dsh --profile scratch --dump-config` contains a `stage-handoff` entry with the
   documented defaults.
3. The plugin mounts: search the host stderr for the mount line.
4. `stage_handoff` appears among the agent's tools, and `/anchor status` responds.

Point 4 is the one most likely to be skipped and most likely to be broken — a
tarball can install cleanly and still fail to register the tool if the `dsh.bundle`
declaration is wrong. Check it explicitly.

## If a release is bad

- Do **not** delete the release; that breaks `releases/latest/download/` for anyone
  mid-install.
- Publish a patch version and mark the previous one as a pre-release in the GitHub
  UI so it stops being `latest`.
- Note the reason in `CHANGELOG.md` so the next person does not re-introduce it.
