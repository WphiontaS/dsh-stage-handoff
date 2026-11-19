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
npm publish --access public --tag beta
```

`--tag` must be passed **on the command line**. `publishConfig.tag` in
`package.json` is ignored by npm 11.19.1 — the publish still goes out under
`latest`, which would make a pre-release the default install target.

`--access public` is likewise explicit; do not rely on `publishConfig.access`.

### Authentication, and why `--otp` may be impossible

An account whose only second factor is a **WebAuthn security key** has no way to
supply an OTP: the npm CLI accepts `--otp` as a TOTP code only, and it does not
speak WebAuthn. The npm website offers no TOTP enrolment once an account is in
that state — the 2FA page lists security keys, recovery codes, and "disable 2FA",
and nothing else. This is a registry policy, not a misconfiguration.

The working path is a **granular access token with "bypass 2FA" enabled**, set in
the environment for the publish only:

```sh
npm config set //registry.npmjs.org/:_authToken <token> --location=user
npm publish --access public --tag beta
npm config delete //registry.npmjs.org/:_authToken --location=user
```

Bypass-2FA tokens are being narrowed over time: account changes are already
blocked for them, and direct publishing is scheduled to be blocked as well. When
that lands, move to [trusted publishing](https://docs.npmjs.com/trusted-publishers/)
(OIDC from the release workflow) instead of widening the token.

### Verifying a publish — do not trust the first read

Three separate caches sit between the registry and your terminal, and every one of
them has produced a false "the publish failed" during this project's releases:

1. **The registry's own CDN copy of the packument.** `npm view <pkg> dist-tags`
   can answer from a document that predates your upload. Read it with a
   cache-buster before concluding anything:
   `https://registry.npmjs.org/<pkg>?t=<unix-ms>` plus `cache-control: no-cache`.
2. **npm's local `_cacache` packument.** `npm install <pkg>@<tag>` may answer
   `ETARGET: No matching version found` for a tag that exists. Add
   `--prefer-online` and it resolves.
3. **The version-scoped document answers before the package-level one.**
   `https://registry.npmjs.org/<pkg>/<version>` returning 200 proves the tarball
   is in place even while the packument still omits the version.

A `409 Conflict` reading `Cannot publish over previously staged version "<version>"`
is **not** a failed upload. It means that exact version is already on the registry;
re-running the publish is what produces the 409. Confirm with the version-scoped
document, then stop.

### Staged publishing

npm 11.15+ can defer the 2FA proof to a later approval step:

```sh
npm stage publish <version>     # uploads, does not go live
npm stage list                  # may be empty even when a version is staged
npm stage approve <stage-id>    # needs --otp, so needs TOTP
npm stage reject <stage-id>
```

Because `approve` requires an OTP, an account without TOTP can only approve from
the website. Prefer a direct `npm publish` with a bypass-2FA token here.

### Post-publish checks

Compare the published bytes against the artifact you signed off, rather than
checking only that the name resolves:

```sh
node -e "fetch('https://registry.npmjs.org/<pkg>/-/<pkg>-<version>.tgz').then(r=>r.arrayBuffer()).then(b=>console.log(b.byteLength, require('crypto').createHash('sha256').update(Buffer.from(b)).digest('hex')))"
npm install <pkg>@<tag> --prefer-online     # in a throwaway directory
```

The byte length and SHA-256 must equal `npm pack`'s output, and the `lib/index.js`
in the installed tree must hash equal to the working copy. Keep the package name in
`package.json` and the release asset identical. If a consumer installs from npm and
another from the tarball, they must get the same code — otherwise bug reports become
unreconcilable.

### Refresh the plugin market index

`market-index.json` at the repository root is the index source users add under
**Plugins → Discover**. It is generated, never hand-edited:

```sh
node tools/market-index.mjs
```

Run it **after** the npm publish: it reads that version's `publishTimestamp` from the
registry and fails with `version <x> has no publish time yet` if the version is not
there yet. Then commit the regenerated file — the raw URL in both READMEs resolves to
whatever the default branch holds.

A regression test compares the index against `package.json`, so bumping the version
without this step fails `npm test` instead of silently listing the previous release.

Note what the index is and is not. DSH ships no index of its own, and its official
Plugins catalog is a hardcoded `@deepseek-ai/*` list with no submission path, so
publishing an index is the only route into Discover. Index content is also
**unsigned** — the index's `name` and `version` are its own claim, and the installed
manifest is what decides what actually gets installed.

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

### If a published npm version is bad

Expect that you **cannot delete it**. On an account whose only second factor is a
WebAuthn security key, all three deletion routes are closed:

- A bypass-2FA token gets `403 ... may not perform this action` — unpublishing is an
  account change.
- The package **Settings** page offers only *Deprecate package* and *Delete package*;
  the latter removes every version, and npm has no per-version deletion in the UI.
- `npm login --auth-type=web` succeeds, but the following `npm unpublish` still
  returns `EOTP`. The `auth/cli/<id>` URL npm suggests is redacted to `***` in both
  stderr and the debug log, so it cannot be relayed to someone who does have the
  key.

What *does* work is `npm deprecate`, because it writes metadata instead of changing
the account:

```sh
npm deprecate "dsh-stage-handoff@<bad-version>" "Broken; use <good-version>."
```

Verify it landed rather than trusting the exit code — read the `deprecated` field of
that version's document from the registry. Then publish a fixed version and move on.
Deleting the whole package to clean up one bad version is not worth it: npm locks
out re-publishing the same name afterwards.
