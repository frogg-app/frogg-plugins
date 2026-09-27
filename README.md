# Frogg plugin repository

A signed Frogg plugin repository, published to GitHub Pages. Fork this to run a brand's internal
repository. Design reference: `docs/plans/plugins.md` in the Frogg repo.

## Layout

```
categories.json                 category ids shown in the Browse tab
plugins/<category>/<id>/        one plugin; directory name must equal the manifest id
  frogg-plugin.json
  package.json                  must define a `build` script producing the manifest's entry files
  src/
scripts/fetch-frogg.sh          installs the frogg CLI and plugin API types into .frogg/
scripts/build-all.sh            builds and packs every plugin into out/ (needs frogg on PATH)
.github/workflows/publish.yml   main: build, pack, index, sign, verify, deploy to Pages
.github/workflows/pr.yml        PRs: typecheck, build, validate manifests, unsigned index
```

`<category>` must appear in `categories.json`; CI fails otherwise.

## The frogg CLI and plugin API types

Nothing from Frogg comes from npm. `scripts/fetch-frogg.sh` puts the CLI at `.frogg/bin/frogg`
and the API types at `.frogg/plugin-api/index.d.ts`; `tsconfig.base.json` maps
`@frogg/plugin-api` to that file, so plugins import types without a dependency. It reads one of
two repository variables (**Settings → Variables → Actions**):

| Variable        | Effect                                                                                                                                                                                         |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FROGG_VERSION` | Downloads `frogg-<version>-linux-<arch>-daemon.tar.gz` from that `frogg-app/frogg` release, checks its `.sha256`, and takes the types from tag `v<version>`. Preferred; wins when both are set |
| `FROGG_REF`     | Builds the CLI from source at that branch, tag or commit of `frogg-app/frogg`                                                                                                                  |

The release must include the `frogg plugins` commands; the script fails otherwise. Locally:

```bash
FROGG_VERSION=<version> scripts/fetch-frogg.sh   # or FROGG_REF=main
export PATH="$PWD/.frogg/bin:$PATH"
npm ci
scripts/build-all.sh
```

## Fork it for a brand

1. Fork (or copy) this directory into a new repository, e.g. `acme/frogg-plugins`. A private
   repository works as long as its Pages site is reachable by every host that installs from it.
2. Generate the signing keypair locally (never in CI):

   ```bash
   frogg plugins keygen
   ```

   It prints a base64 private key and a base64 public key (raw 32 bytes).

3. In the repository settings:
   - **Secrets → Actions**: `PLUGIN_REPO_SIGNING_KEY` = the private key.
   - **Variables → Actions**: `PLUGIN_REPO_PUBLIC_KEY` = the public key; `FROGG_VERSION` (or
     `FROGG_REF`), see above; optionally `PLUGIN_REPO_NAME` = the display name written into
     `index.json`.
   - **Pages**: source = GitHub Actions.
4. Delete `plugins/examples/` and the `examples` category, add your own plugins, run
   `npm install` to refresh `package-lock.json`, push to `main`.
5. Point the brand at it in `brand.json`:

   ```json
   "plugins": {
     "repos": [
       {
         "name": "Acme internal",
         "url": "https://acme.github.io/frogg-plugins/index.json",
         "publicKey": "<PLUGIN_REPO_PUBLIC_KEY>"
       }
     ],
     "allow": ["acme.*"]
   }
   ```

Store the private key somewhere other than the secret too; losing it means re-keying every
brand build that pins the public key.

## Add a plugin

```bash
cd plugins/<category>
frogg plugins new acme.my-plugin
```

The scaffold builds as generated: it carries its own copy of the API types in
`types/frogg-plugin-api.d.ts`. To share the repo-wide copy instead, delete that folder and make
`tsconfig.json` extend `../../../tsconfig.base.json`, as the examples do.

Develop against a running host with developer mode on: `frogg plugins link plugins/<category>/<id>`.
Bump `version` in `frogg-plugin.json` for every release. Each deploy replaces the Pages site, so
the index lists only the version currently on `main`; hosts on older versions are offered the update.

## What gets published

The Pages site root contains `index.json`, `index.json.sig` (detached ed25519 over the exact bytes
of `index.json`, base64) and one `<id>-<version>.tgz` per plugin version. Hosts reject the index if
the signature fails against the pinned key, and reject a tarball whose sha256 differs from the
index entry.
