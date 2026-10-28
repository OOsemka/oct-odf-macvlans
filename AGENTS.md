# ODF Macvlans — OCT extension

This is a **standalone ConsolePlugin** (`oct-odf-macvlans`). It is **OpenShift Community Tools (OCT)**, a **community project, not officially supported by Red Hat**. Do not describe it as official Red Hat software.

Do not add Community Tools category nav here. Users open this page from the storefront Storage hub (**Open** / `/community-tools/storage/odf-macvlans`).

## Identifiers

| | Value |
| --- | --- |
| Plugin ID / ConsolePlugin / `package.json` `consolePlugin.name` | **`oct-odf-macvlans`** |
| Image | `quay.io/cjanisze/oct-odf-macvlans:<semver>-ocp<major.minor>` |
| i18n | `plugin__oct-odf-macvlans` |

Display name is **ODF Macvlans**. No PVC, no sidecar, no RBAC in the bundle: every API call runs as the logged-in console user (cluster-admin) through the Console SDK proxy.

**Current version:** `0.1.0` (package.json / consolePlugin.version).

## What it does

Moves OpenShift Data Foundation (Ceph) traffic from the pod network onto dedicated macvlan networks, following Red Hat's "Enabling Multus support on an existing OpenShift Data Foundation cluster" (ODF **4.21+**). The user picks a node interface and gives a VLAN ID (optional) and a CIDR for the public network and, optionally, the cluster network. The tool:

1. Creates one `NodeNetworkConfigurationPolicy` per worker node (`oct-odf-macvlans-<node>`): VLAN interfaces `<iface>.<vlan>` plus a macvlan shim `odf-pub-shim` (mode bridge, promiscuous) with a static IP on the public network, so the host (CSI node plugin) can reach Ceph pods. Waits for each policy to be Available.
2. Creates NADs `openshift-storage/odf-public-network` and `odf-cluster-network`: macvlan bridge + whereabouts (the only supported CNI/IPAM).
3. Verifies every node reports the shim with its planned IP.
4. Runs Rook's Multus validation tool (optional, on by default): a Job with the image and service account of `deploy/rook-ceph-operator` running `rook multus validation run`. It pulls `quay.io/nginx/nginx-unprivileged`.
5. Patches the ODF `StorageCluster` (`ocs.openshift.io/v1`): `spec.network.provider: multus`, `selectors.{public,cluster}`, `addressRanges.{public,cluster}`.
6. Waits until every OSD pod is Ready on the public network.
7. Settles Ceph. While Rook rolls the OSDs, OSDs on the old and new networks can't heartbeat each other. Some get marked down more than `osd_max_markdown_count` times and their `ceph-osd` exits, but the pod stays Ready (Rook's wrapper sleeps). The tool finds them by their log, restarts them one at a time, and waits for a fresh CephCluster health report with no `OSD_DOWN` / `PG_AVAILABILITY`.
8. Restarts MDS pods that are not on the public network, one at a time.

Once the StorageCluster uses this tool's NADs, the page shows a status card instead of the form. From there the user can re-run steps 6-8 (for example after a page reload) or run the validation tool in `--host-check-only` mode. Stale `osd_failure` slow ops on a mon after the switch only clear when that mon restarts. The tool does not do this.

**Address plan:** each CIDR is split in half. The lower half is for node shims (first node `.11`, then `+1` per node, sorted by name), the upper half is the whereabouts pod range (`exclude` = lower half). The same layout is used by existing hand-built Multus clusters.

If NMState is missing, the page offers a one-click install (Subscription `kubernetes-nmstate-operator`, channel `stable`, `redhat-operators`, plus the `NMState` instance).

## Exposed modules

| Module | Route | Description |
| --- | --- | --- |
| `OdfMacvlansPage` | `/community-tools/storage/odf-macvlans` | Prerequisites, form, review (shim IPs + YAML), apply with progress, inventory. |

## Code layout

| File | Role |
| --- | --- |
| `src/utils/odf-macvlans.ts` | Pure planning logic: CIDR math, validation, NNCP/NAD/StorageCluster builders, interface discovery. Unit tested (`yarn test`). |
| `src/utils/odf-actions.ts` | Cluster actions (Console SDK): NMState install, apply policies, NADs, shim check, validation Job, StorageCluster patch, OSD wait, Ceph settle (stopped-OSD restart), MDS restart. |
| `src/utils/k8s-resources.ts` | K8s models. ODF `StorageCluster` must use the full group `ocs.openshift.io`: Portworx also defines a `StorageCluster` kind. |
| `src/components/OdfMacvlansPage.tsx` | The page. |

## Safety rules

- ODF is changed only after every node policy is Available and every shim is up; a failed policy stops before ODF is touched.
- There is no "revert": ODF does not document moving back from Multus to the pod network.
- Never hardcode interfaces, VLANs, CIDRs or StorageCluster names (`oct-no-env-hardcoding.mdc`); everything comes from the form or the live cluster.
- The shim goes on every schedulable worker (where the ODF CSI node plugin runs), not only storage nodes.

## Verify

```bash
yarn install
yarn test
yarn build
```

Do not `oc apply` or push images unless asked.
