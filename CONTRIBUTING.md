# Contributing to ODF Macvlans

Thanks for helping. ODF Macvlans is part of OpenShift Community Tools (OCT), a
community project that is not officially supported by Red Hat. Bug fixes, new
options and docs improvements are all welcome. For larger changes, open an
issue first so we can agree on the approach before you spend time on it.

## Setup

Requirements: Node.js 20 and Corepack (it provides the Yarn version pinned in
`package.json`).

```bash
corepack enable
yarn install
yarn verify    # type check, translation keys, repository rules, unit tests, production build
```

The same checks run in GitHub Actions on every pull request. A pull request
can be merged when they pass and a maintainer has reviewed it.

## Test on your own cluster

Use a lab cluster you can afford to break.
This plugin changes node networking through NMState; a mistake can take a node
off the network. Prefer spare NICs that nothing else uses.

Build your image and push it to a registry you own (make the repository public,
or add a pull secret):

```bash
podman build -t quay.io/<you>/oct-odf-macvlans:dev -f Containerfile .
podman push quay.io/<you>/oct-odf-macvlans:dev
```

**If ODF Macvlans is already installed from the storefront**, swap in your image:

```bash
oc set image deploy/oct-odf-macvlans -n oct-odf-macvlans plugin=quay.io/<you>/oct-odf-macvlans:dev
```

**Otherwise** deploy the YAML in this repo with your image:

```bash
sed 's|quay.io/cjanisze/oct-odf-macvlans:[^ ]*|quay.io/<you>/oct-odf-macvlans:dev|' deploy/install.yaml | oc apply -f -
```

and enable the plugin in the console (skip if the storefront already enabled it):

```bash
oc patch console.operator cluster --type=json \
  -p '[{"op":"add","path":"/spec/plugins/-","value":"oct-odf-macvlans"}]'
```

The page is at **Community Tools → Storage → ODF Macvlans** (`/community-tools/storage/odf-macvlans`). After pushing a new `:dev`
image, restart the plugin pod (`oc rollout restart deploy/oct-odf-macvlans -n oct-odf-macvlans`)
and reload the console.

Not able to test on a cluster? Say so in the pull request and describe what you
checked instead (for example the page's YAML preview, or output of the functions
you changed). A maintainer tests it before the release.

## Rules

- **PatternFly 6** components only. Do not import PatternFly CSS; the console provides it.
- **Translations:** every UI string goes through `t('...')` and has an entry in
  `locales/en/plugin__oct-odf-macvlans.json`. `yarn check-i18n --fix` adds missing ones.
- **No environment-specific values:** no hostnames, IPs, VLAN IDs, NIC names,
  StorageClasses, cluster URLs or tokens in code or docs. Read live cluster state
  and let the user choose.
- ODF is changed only after every node policy is Available and every shim is up; a failed policy stops before ODF is touched.
- There is no revert: ODF does not support moving back from Multus to the pod network. Test only on clusters you can rebuild.
- The shim goes on every schedulable worker (where the ODF CSI node plugin runs), not only storage nodes.
- **Wording:** this is a community project; do not describe it as official Red Hat software.
- [AGENTS.md](AGENTS.md) describes the design in detail. It is also the guide
  for AI coding assistants, which are welcome; please review what they produce.

## Releases (maintainers)

Leave these to the maintainers. Do not change them in a pull request:

- the version in `package.json` (both places), README, AGENTS.md and the deploy YAML
- container images (`<version>-ocp4.22` and `-ocp4.21`; published tags are never overwritten)
- git tags and the storefront catalog rows

## License

By contributing you agree that your contribution is licensed under the
[Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0), the license of this project.
