/**
 * Planning logic for the ODF Macvlans tool: CIDR handling, the per-node
 * NodeNetworkConfigurationPolicies, the two NetworkAttachmentDefinitions and
 * the StorageCluster patch that moves ODF (Ceph) onto Multus.
 *
 * Pure functions only (no Console SDK), so they can be unit tested.
 *
 * Layout follows Red Hat's "Enabling Multus support on an existing OpenShift
 * Data Foundation cluster" (ODF 4.21+): macvlan + whereabouts NADs in
 * openshift-storage, and a macvlan "shim" interface with a static IP on every
 * node so the host (CSI node plugin, kernel RBD/CephFS clients) can reach Ceph
 * pods on the public network. Each CIDR is split in half: the lower half is
 * reserved for the node shims, the upper half is the whereabouts pod range.
 */

export const MANAGED_BY_LABEL = 'app.kubernetes.io/managed-by';
export const MANAGED_BY = 'oct-odf-macvlans';
export const ODF_NAMESPACE = 'openshift-storage';
export const PUBLIC_NAD = 'odf-public-network';
export const CLUSTER_NAD = 'odf-cluster-network';
export const SHIM_IFACE = 'odf-pub-shim';
/** First node shim gets base + SHIM_OFFSET (+1 per node), e.g. .11, .12, ... in a /24. */
export const SHIM_OFFSET = 11;
/** ODF releases that support enabling Multus on an existing cluster. */
export const MIN_ODF = { major: 4, minor: 21 };

// ---------------------------------------------------------------- IPv4 ----

export type Ipv4Cidr = { network: number; prefix: number; size: number };

export function parseIpv4(ip: string): number | undefined {
  const parts = ip.trim().split('.');
  if (parts.length !== 4) return undefined;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return undefined;
    const v = Number(p);
    if (v > 255) return undefined;
    n = n * 256 + v;
  }
  return n;
}

export function formatIpv4(n: number): string {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

/** Parses "a.b.c.d/p"; the address must be the network address. */
export function parseCidr(cidr: string): Ipv4Cidr | undefined {
  const m = cidr.trim().match(/^([\d.]+)\/(\d{1,2})$/);
  if (!m) return undefined;
  const ip = parseIpv4(m[1]);
  const prefix = Number(m[2]);
  if (ip === undefined || prefix > 32) return undefined;
  const size = 2 ** (32 - prefix);
  if (ip % size !== 0) return undefined;
  return { network: ip, prefix, size };
}

export function formatCidr(c: Ipv4Cidr): string {
  return `${formatIpv4(c.network)}/${c.prefix}`;
}

export function cidrsOverlap(a: Ipv4Cidr, b: Ipv4Cidr): boolean {
  return a.network < b.network + b.size && b.network < a.network + a.size;
}

export function cidrContains(c: Ipv4Cidr, ip: number): boolean {
  return ip >= c.network && ip < c.network + c.size;
}

/** Lower half (node shims) and upper half (pods) of a CIDR. */
export function splitCidr(c: Ipv4Cidr): { nodes: Ipv4Cidr; pods: Ipv4Cidr } {
  const half = c.size / 2;
  return {
    nodes: { network: c.network, prefix: c.prefix + 1, size: half },
    pods: { network: c.network + half, prefix: c.prefix + 1, size: half },
  };
}

/** Static shim IPs for the given nodes (sorted by name for stable assignment). */
export function shimAddresses(c: Ipv4Cidr, nodeNames: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  [...nodeNames].sort().forEach((n, i) => {
    out[n] = formatIpv4(c.network + SHIM_OFFSET + i);
  });
  return out;
}

// --------------------------------------------------------------- input ----

export type NetworkInput = { vlan: string; cidr: string };

export type PlanInput = {
  iface: string;
  nodes: string[];
  publicNet: NetworkInput;
  clusterEnabled: boolean;
  clusterNet: NetworkInput;
  /** CIDRs already used by the cluster (machine, pod, service networks). */
  reservedCidrs: string[];
};

export type PlanIssue = { field: string; message: string };

export function parseVlan(v: string): number | undefined | null {
  if (v.trim() === '') return undefined;
  if (!/^\d+$/.test(v.trim())) return null;
  const n = Number(v);
  return n >= 1 && n <= 4094 ? n : null;
}

/** Interface the macvlan sits on for a network: "<iface>.<vlan>" or the interface itself. */
export function parentInterface(iface: string, vlan?: number): string {
  return vlan ? `${iface}.${vlan}` : iface;
}

export function validatePlan(input: PlanInput): PlanIssue[] {
  const issues: PlanIssue[] = [];
  if (!input.iface) issues.push({ field: 'iface', message: 'Select the node interface that carries the ODF networks.' });
  if (input.nodes.length === 0) issues.push({ field: 'iface', message: 'No target nodes found.' });

  const checkNet = (label: string, field: string, net: NetworkInput): Ipv4Cidr | undefined => {
    const vlan = parseVlan(net.vlan);
    if (vlan === null) issues.push({ field: `${field}-vlan`, message: `${label} VLAN ID must be a number from 1 to 4094, or empty for no VLAN.` });
    const c = parseCidr(net.cidr);
    if (!c) {
      issues.push({ field: `${field}-cidr`, message: `${label} CIDR must be an IPv4 network address such as 192.168.20.0/24.` });
      return undefined;
    }
    if (c.prefix < 16 || c.prefix > 27) {
      issues.push({ field: `${field}-cidr`, message: `${label} CIDR must be between /16 and /27.` });
      return c;
    }
    for (const r of input.reservedCidrs) {
      const rc = parseCidr(r);
      if (rc && cidrsOverlap(c, rc)) issues.push({ field: `${field}-cidr`, message: `${label} CIDR overlaps the cluster network ${r}.` });
    }
    return c;
  };

  const pub = checkNet('Public', 'public', input.publicNet);
  if (pub && pub.prefix <= 27) {
    const half = pub.size / 2;
    if (SHIM_OFFSET + input.nodes.length >= half) {
      issues.push({ field: 'public-cidr', message: `Public CIDR is too small: the lower half must hold one address per node (${input.nodes.length}) from .${SHIM_OFFSET}.` });
    }
  }
  if (input.clusterEnabled) {
    const clu = checkNet('Cluster', 'cluster', input.clusterNet);
    if (pub && clu && cidrsOverlap(pub, clu)) issues.push({ field: 'cluster-cidr', message: 'Public and cluster CIDRs must not overlap.' });
    const pv = parseVlan(input.publicNet.vlan);
    const cv = parseVlan(input.clusterNet.vlan);
    if (pv !== null && cv !== null && pv === cv) {
      issues.push({
        field: 'cluster-vlan',
        message: pv === undefined
          ? 'Use VLANs to keep the public and cluster networks apart: both cannot sit untagged on the same interface.'
          : 'Public and cluster networks need different VLAN IDs.',
      });
    }
  }
  return issues;
}

// ------------------------------------------------------------ builders ----

export type K8sObject = {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace?: string; labels?: Record<string, string>; annotations?: Record<string, string> };
  spec: Record<string, unknown>;
};

const labels = () => ({ [MANAGED_BY_LABEL]: MANAGED_BY });

export function nncpName(node: string): string {
  return `oct-odf-macvlans-${node}`.slice(0, 253);
}

function vlanInterface(iface: string, vlan: number, purpose: string): Record<string, unknown> {
  return {
    name: parentInterface(iface, vlan),
    type: 'vlan',
    state: 'up',
    description: `ODF ${purpose} network (VLAN ${vlan}), managed by oct-odf-macvlans`,
    vlan: { 'base-iface': iface, id: vlan },
    ipv4: { enabled: false },
    ipv6: { enabled: false },
  };
}

/** NNCP for one node: optional VLAN interfaces plus the public-network shim. */
export function buildNodePolicy(input: PlanInput, node: string, shimIp: string): K8sObject {
  const pub = parseCidr(input.publicNet.cidr) as Ipv4Cidr;
  const pubVlan = parseVlan(input.publicNet.vlan) || undefined;
  const cluVlan = input.clusterEnabled ? parseVlan(input.clusterNet.vlan) || undefined : undefined;
  const interfaces: Record<string, unknown>[] = [];
  if (pubVlan) interfaces.push(vlanInterface(input.iface, pubVlan, 'public'));
  if (cluVlan) interfaces.push(vlanInterface(input.iface, cluVlan, 'cluster'));
  interfaces.push({
    name: SHIM_IFACE,
    type: 'mac-vlan',
    state: 'up',
    description: 'Shim so the host can reach ODF pods on the public network, managed by oct-odf-macvlans',
    'mac-vlan': { 'base-iface': parentInterface(input.iface, pubVlan), mode: 'bridge', promiscuous: true },
    ipv4: { enabled: true, dhcp: false, address: [{ ip: shimIp, 'prefix-length': pub.prefix }] },
    ipv6: { enabled: false },
  });
  return {
    apiVersion: 'nmstate.io/v1',
    kind: 'NodeNetworkConfigurationPolicy',
    metadata: { name: nncpName(node), labels: labels() },
    spec: { nodeSelector: { 'kubernetes.io/hostname': node }, desiredState: { interfaces } },
  };
}

/** macvlan + whereabouts NAD; pods get the upper half of the CIDR. */
export function buildNad(name: string, parent: string, cidr: string): K8sObject {
  const c = parseCidr(cidr) as Ipv4Cidr;
  const { nodes } = splitCidr(c);
  const config = {
    cniVersion: '0.3.1',
    type: 'macvlan',
    master: parent,
    mode: 'bridge',
    ipam: {
      type: 'whereabouts',
      range: formatCidr(c),
      exclude: [formatCidr(nodes)],
      routes: [{ dst: formatCidr(c) }],
    },
  };
  return {
    apiVersion: 'k8s.cni.cncf.io/v1',
    kind: 'NetworkAttachmentDefinition',
    metadata: { name, namespace: ODF_NAMESPACE, labels: labels() },
    spec: { config: JSON.stringify(config, null, 2) },
  };
}

export type Plan = {
  policies: K8sObject[];
  nads: K8sObject[];
  shimIps: Record<string, string>;
  storageClusterNetwork: Record<string, unknown>;
};

export function buildPlan(input: PlanInput): Plan {
  const pub = parseCidr(input.publicNet.cidr) as Ipv4Cidr;
  const shimIps = shimAddresses(pub, input.nodes);
  const policies = [...input.nodes].sort().map((n) => buildNodePolicy(input, n, shimIps[n]));
  const pubVlan = parseVlan(input.publicNet.vlan) || undefined;
  const nads = [buildNad(PUBLIC_NAD, parentInterface(input.iface, pubVlan), input.publicNet.cidr)];
  const selectors: Record<string, string> = { public: `${ODF_NAMESPACE}/${PUBLIC_NAD}` };
  const addressRanges: Record<string, string[]> = { public: [formatCidr(pub)] };
  if (input.clusterEnabled) {
    const cluVlan = parseVlan(input.clusterNet.vlan) || undefined;
    nads.push(buildNad(CLUSTER_NAD, parentInterface(input.iface, cluVlan), input.clusterNet.cidr));
    selectors.cluster = `${ODF_NAMESPACE}/${CLUSTER_NAD}`;
    addressRanges.cluster = [formatCidr(parseCidr(input.clusterNet.cidr) as Ipv4Cidr)];
  }
  return {
    policies,
    nads,
    shimIps,
    storageClusterNetwork: { provider: 'multus', selectors, addressRanges },
  };
}

/** JSON merge patch for the StorageCluster (keeps other spec.network fields). */
export function storageClusterPatch(plan: Plan): Record<string, unknown> {
  return { spec: { network: plan.storageClusterNetwork } };
}

// ----------------------------------------------------------- discovery ----

export type NmstateInterface = {
  name?: string;
  type?: string;
  state?: string;
  controller?: string;
  mtu?: number;
  'link-aggregation'?: { port?: string[] };
  vlan?: { 'base-iface'?: string; id?: number };
};

export type NodeNetworkStateLite = {
  metadata: { name: string };
  status?: { currentState?: { interfaces?: NmstateInterface[] } };
};

export type InterfaceChoice = {
  name: string;
  type: string;
  nodes: string[];
  /** Set when the interface is enslaved elsewhere (OVS bridge, bond). */
  controller?: string;
};

const CANDIDATE_TYPES = new Set(['ethernet', 'bond']);

/**
 * Interfaces usable as the parent for the ODF networks: physical NICs and
 * bonds that are up, reported per node. Only interfaces present on every
 * target node are selectable.
 */
export function interfaceChoices(nnsList: NodeNetworkStateLite[], targetNodes: string[]): InterfaceChoice[] {
  const byName = new Map<string, InterfaceChoice>();
  for (const nns of nnsList) {
    if (!targetNodes.includes(nns.metadata.name)) continue;
    for (const i of nns.status?.currentState?.interfaces || []) {
      if (!i.name || !CANDIDATE_TYPES.has(i.type || '') || i.state !== 'up') continue;
      // NICs that are bond members are reached through the bond instead.
      if (i.type === 'ethernet' && i.controller && i.controller !== 'br-ex') continue;
      const c = byName.get(i.name) || { name: i.name, type: i.type as string, nodes: [], controller: i.controller };
      c.nodes.push(nns.metadata.name);
      byName.set(i.name, c);
    }
  }
  return Array.from(byName.values())
    .filter((c) => targetNodes.every((n) => c.nodes.includes(n)))
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'bond' ? -1 : 1));
}

/** Node names that need the shim: schedulable workers (the CSI node plugin runs there). */
export function targetNodes(
  nodes: Array<{ metadata: { name: string; labels?: Record<string, string> }; spec?: { unschedulable?: boolean } }>,
): string[] {
  return nodes
    .filter((n) => n.metadata.labels && 'node-role.kubernetes.io/worker' in n.metadata.labels && !n.spec?.unschedulable)
    .map((n) => n.metadata.name)
    .sort();
}

export function odfVersionSupported(csvName: string | undefined): boolean {
  const m = (csvName || '').match(/v(\d+)\.(\d+)\./);
  if (!m) return false;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  return major > MIN_ODF.major || (major === MIN_ODF.major && minor >= MIN_ODF.minor);
}

// ------------------------------------------------------ after the switch ----

/** True when the StorageCluster already points at this tool's public NAD. */
export function usesToolNetworks(network: { provider?: string; selectors?: Record<string, string> } | undefined): boolean {
  return network?.provider === 'multus' && network.selectors?.public === `${ODF_NAMESPACE}/${PUBLIC_NAD}`;
}

/**
 * While Rook rolls OSDs onto the new networks, OSDs on the old and new
 * networks cannot heartbeat each other and keep marking each other down. After
 * osd_max_markdown_count markdowns an OSD exits, but Rook's wrapper keeps the
 * container running, so the pod still looks Ready. Its log shows why.
 */
export function osdStoppedItself(log: string): boolean {
  return /osd_max_markdown_count|shutdown OSD via async signal/.test(log);
}

/** Ceph health checks that mean data is not fully available yet. */
const UNSETTLED_CHECKS = ['OSD_DOWN', 'OSD_HOST_DOWN', 'PG_AVAILABILITY'];

export function unsettledChecks(details: Record<string, { message?: string }> | undefined): string[] {
  return Object.entries(details || {})
    .filter(([k]) => UNSETTLED_CHECKS.includes(k))
    .map(([k, v]) => v.message || k);
}

/** Arguments for Rook's Multus validation tool (`rook multus validation run`). */
export function validationArgs(clusterNetwork: boolean, hostCheckOnly: boolean, serviceAccount: string): string[] {
  const args = [
    'multus', 'validation', 'run',
    `--namespace=${ODF_NAMESPACE}`,
    `--service-account=${serviceAccount}`,
    `--public-network=${ODF_NAMESPACE}/${PUBLIC_NAD}`,
  ];
  if (clusterNetwork) args.push(`--cluster-network=${ODF_NAMESPACE}/${CLUSTER_NAD}`);
  if (hostCheckOnly) args.push('--host-check-only');
  return args;
}
