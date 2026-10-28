# ODF Macvlans (OpenShift Community Tools)

**Community project. Not officially supported by Red Hat.**

Console plugin that moves OpenShift Data Foundation (Ceph) traffic from the pod network onto dedicated macvlan networks, the way Red Hat documents for existing clusters ("Enabling Multus support on an existing OpenShift Data Foundation cluster", ODF 4.21 and later).

- **Plugin ID:** `oct-odf-macvlans`
- **Version:** `0.1.0`
- **Route:** `/community-tools/storage/odf-macvlans` (Community Tools → Storage → ODF Macvlans)

## What you provide

- The node interface that carries the storage networks (for example `bond0`)
- **Public network:** VLAN ID (optional) and CIDR
- **Cluster network** (optional, on by default): VLAN ID and CIDR

## What the tool does

1. Configures every worker node with NMState: VLAN interfaces and a macvlan shim `odf-pub-shim` with a static IP on the public network, so the node itself can reach Ceph.
2. Creates the `odf-public-network` / `odf-cluster-network` NetworkAttachmentDefinitions in `openshift-storage` (macvlan + whereabouts).
3. Checks the shim is up on every node.
4. Runs Rook's Multus validation test (recommended, on by default). It uses the tool already in the ODF operator image and needs access to `quay.io/nginx/nginx-unprivileged`.
5. Switches the ODF `StorageCluster` to the Multus networks.
6. Waits for the OSDs to move and for Ceph to settle. OSDs that stopped themselves during the move are restarted one at a time.
7. Restarts the MDS pods one at a time.

Afterwards the page shows the current state, with buttons to re-run steps 6-7 or run the validation tool's host check.

Each CIDR is split in half: node shims use the lower half (from `.11`), ODF pods the upper half. Nothing in ODF changes until every node is ready, and the page shows every object before it is created.

## Requirements

- OpenShift Data Foundation **4.21 or later**, internal mode
- NMState operator (the page can install it with one click)
- VLANs (if used) trunked to the nodes on the chosen interface
- cluster-admin

Switching restarts Ceph daemons one by one, so storage I/O can pause briefly. ODF does not document moving back to the pod network.

## Install

Use the storefront **Add** action, or apply manually (cluster-admin):

```bash
oc apply -f deploy/install.yaml
```

Then enable `oct-odf-macvlans` in `consoles.operator.openshift.io/cluster` `spec.plugins`.

## Build

```bash
yarn install
yarn test
yarn build
```

Images: `quay.io/cjanisze/oct-odf-macvlans:<semver>-ocp<major.minor>`; publish both `-ocp4.21` and `-ocp4.22`.
