/**
 * Cluster actions for the ODF Macvlans tool. Everything runs with the
 * logged-in console user's permissions through the Console SDK proxy.
 */
import {
  K8sResourceCommon,
  consoleFetchText,
  k8sCreate,
  k8sDelete,
  k8sGet,
  k8sListItems,
  k8sPatch,
} from '@openshift-console/dynamic-plugin-sdk';

import {
  CephClusterModel,
  ClusterServiceVersionModel,
  DeploymentModel,
  JobModel,
  NMStateModel,
  NamespaceModel,
  NetworkAttachmentDefinitionModel,
  NodeNetworkConfigurationPolicyModel,
  NodeNetworkStateModel,
  OperatorGroupModel,
  PodModel,
  StorageClusterModel,
  SubscriptionModel,
} from './k8s-resources';
import {
  K8sObject,
  MANAGED_BY,
  MANAGED_BY_LABEL,
  ODF_NAMESPACE,
  PUBLIC_NAD,
  Plan,
  SHIM_IFACE,
  osdStoppedItself,
  unsettledChecks,
  validationArgs,
} from './odf-macvlans';

export type Progress = (message: string) => void;

export function errorMessage(err: unknown): string {
  if (!err) return '';
  if (typeof err === 'string') return err;
  const o = err as { message?: string; json?: { message?: string } };
  return o.json?.message || o.message || String(err);
}

export function errorCode(err: unknown): number | undefined {
  const o = err as { json?: { code?: number }; status?: number; code?: number };
  return o.json?.code ?? o.status ?? o.code;
}

export function isMissingCrd(err: unknown): boolean {
  if (errorCode(err) === 404) return true;
  const m = errorMessage(err).toLowerCase();
  return m.includes('could not find the requested resource') || m.includes('no matches for kind');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function poll<T>(what: string, timeoutMs: number, everyMs: number, check: () => Promise<T | undefined>): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await check();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}.`);
    await sleep(everyMs);
  }
}

async function createOrKeep(model: typeof NamespaceModel, data: K8sResourceCommon): Promise<void> {
  try {
    await k8sCreate({ model, data });
  } catch (e) {
    if (errorCode(e) !== 409) throw e;
  }
}

// ------------------------------------------------------- NMState install ---

const NMSTATE_NS = 'openshift-nmstate';

/**
 * One-click install of the Kubernetes NMState operator (redhat-operators,
 * stable channel) and its NMState instance. Idempotent.
 */
export async function installNmstate(progress: Progress): Promise<void> {
  progress('Creating namespace openshift-nmstate');
  await createOrKeep(NamespaceModel, {
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: { name: NMSTATE_NS, labels: { 'openshift.io/cluster-monitoring': 'true' } },
  });
  progress('Creating OperatorGroup and Subscription');
  await createOrKeep(OperatorGroupModel, {
    apiVersion: 'operators.coreos.com/v1',
    kind: 'OperatorGroup',
    metadata: { name: NMSTATE_NS, namespace: NMSTATE_NS },
    spec: { targetNamespaces: [NMSTATE_NS] },
  } as K8sResourceCommon);
  await createOrKeep(SubscriptionModel, {
    apiVersion: 'operators.coreos.com/v1alpha1',
    kind: 'Subscription',
    metadata: { name: 'kubernetes-nmstate-operator', namespace: NMSTATE_NS },
    spec: {
      channel: 'stable',
      name: 'kubernetes-nmstate-operator',
      source: 'redhat-operators',
      sourceNamespace: 'openshift-marketplace',
      installPlanApproval: 'Automatic',
    },
  } as K8sResourceCommon);
  progress('Waiting for the NMState operator to install');
  await poll('the NMState operator', 15 * 60_000, 10_000, async () => {
    const sub = (await k8sGet({ model: SubscriptionModel, name: 'kubernetes-nmstate-operator', ns: NMSTATE_NS })) as {
      status?: { installedCSV?: string };
    };
    const csvName = sub.status?.installedCSV;
    if (!csvName) return undefined;
    try {
      const csv = (await k8sGet({ model: ClusterServiceVersionModel, name: csvName, ns: NMSTATE_NS })) as {
        status?: { phase?: string };
      };
      return csv.status?.phase === 'Succeeded' ? true : undefined;
    } catch {
      return undefined;
    }
  });
  progress('Creating the NMState instance');
  await poll('the NMState API', 5 * 60_000, 5_000, async () => {
    try {
      await createOrKeep(NMStateModel, { apiVersion: 'nmstate.io/v1', kind: 'NMState', metadata: { name: 'nmstate' } });
      return true;
    } catch (e) {
      if (isMissingCrd(e)) return undefined;
      throw e;
    }
  });
  progress('Waiting for nodes to report their interfaces');
  await poll('NodeNetworkState reports', 10 * 60_000, 10_000, async () => {
    try {
      const nns = await k8sListItems({ model: NodeNetworkStateModel, queryParams: {} });
      return nns.length > 0 ? true : undefined;
    } catch {
      return undefined;
    }
  });
}

// ------------------------------------------------------------- applying ---

async function createOrReplace(model: typeof NamespaceModel, obj: K8sObject): Promise<void> {
  try {
    await k8sCreate({ model, data: obj as unknown as K8sResourceCommon });
  } catch (e) {
    if (errorCode(e) !== 409) throw e;
    const cur = (await k8sGet({ model, name: obj.metadata.name, ns: obj.metadata.namespace })) as K8sResourceCommon & {
      spec?: unknown;
    };
    await k8sPatch({ model, resource: cur, data: [{ op: 'replace', path: '/spec', value: obj.spec }] });
  }
}

type Condition = { type?: string; status?: string; reason?: string; message?: string };

/** Creates the host policies and waits until NMState reports each one Available. */
export async function applyPolicies(plan: Plan, progress: Progress): Promise<void> {
  for (const p of plan.policies) {
    progress(`Creating NodeNetworkConfigurationPolicy ${p.metadata.name}`);
    await createOrReplace(NodeNetworkConfigurationPolicyModel, p);
  }
  for (const p of plan.policies) {
    await poll(`policy ${p.metadata.name}`, 10 * 60_000, 5_000, async () => {
      const cur = (await k8sGet({ model: NodeNetworkConfigurationPolicyModel, name: p.metadata.name })) as {
        status?: { conditions?: Condition[] };
      };
      const conds = cur.status?.conditions || [];
      const degraded = conds.find((c) => c.type === 'Degraded' && c.status === 'True');
      if (degraded) {
        throw new Error(`NMState could not apply ${p.metadata.name}: ${degraded.message || degraded.reason}. Nothing was changed in ODF.`);
      }
      const available = conds.find((c) => c.type === 'Available' && c.status === 'True');
      progress(`Waiting for NMState to apply ${p.metadata.name}${available ? ' — done' : ''}`);
      return available ? true : undefined;
    });
  }
}

export async function createNads(plan: Plan, progress: Progress): Promise<void> {
  for (const nad of plan.nads) {
    progress(`Creating NetworkAttachmentDefinition ${nad.metadata.name}`);
    await createOrReplace(NetworkAttachmentDefinitionModel, nad);
  }
}

/** Confirms every node reports the shim with its planned address. */
export async function verifyShims(plan: Plan, progress: Progress): Promise<void> {
  await poll('the public-network shim on every node', 5 * 60_000, 5_000, async () => {
    const missing: string[] = [];
    for (const [node, ip] of Object.entries(plan.shimIps)) {
      const nns = (await k8sGet({ model: NodeNetworkStateModel, name: node })) as {
        status?: { currentState?: { interfaces?: Array<{ name?: string; ipv4?: { address?: Array<{ ip?: string }> } }> } };
      };
      const shim = nns.status?.currentState?.interfaces?.find((i) => i.name === SHIM_IFACE);
      if (!shim?.ipv4?.address?.some((a) => a.ip === ip)) missing.push(node);
    }
    progress(missing.length ? `Waiting for the shim on ${missing.join(', ')}` : 'Shim is up on every node');
    return missing.length ? undefined : true;
  });
}

/** Switches the StorageCluster to Multus (keeps any other spec.network fields). */
export async function patchStorageCluster(name: string, plan: Plan, progress: Progress): Promise<void> {
  progress(`Updating StorageCluster ${name} to use the Multus networks`);
  const sc = (await k8sGet({ model: StorageClusterModel, name, ns: ODF_NAMESPACE })) as K8sResourceCommon & {
    spec?: { network?: Record<string, unknown> };
  };
  const ops = sc.spec?.network
    ? Object.entries(plan.storageClusterNetwork).map(([k, v]) => ({ op: 'add', path: `/spec/network/${k}`, value: v }))
    : [{ op: 'add', path: '/spec/network', value: plan.storageClusterNetwork }];
  await k8sPatch({ model: StorageClusterModel, resource: sc, data: ops });
}

type PodLite = K8sResourceCommon & {
  metadata: { name: string; labels?: Record<string, string>; annotations?: Record<string, string>; creationTimestamp?: string; deletionTimestamp?: string };
  status?: { conditions?: Condition[]; phase?: string };
};

const onMultus = (p: PodLite) => (p.metadata.annotations?.['k8s.v1.cni.cncf.io/networks'] || '').includes(PUBLIC_NAD);
const isReady = (p: PodLite) =>
  !p.metadata.deletionTimestamp && !!p.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True');

async function pods(selector: string, key = 'app'): Promise<PodLite[]> {
  return (await k8sListItems({
    model: PodModel,
    queryParams: { ns: ODF_NAMESPACE, labelSelector: { matchLabels: { [key]: selector } } },
  })) as PodLite[];
}

async function podLog(pod: string, container: string, tailLines: number): Promise<string> {
  return consoleFetchText(
    `/api/kubernetes/api/v1/namespaces/${ODF_NAMESPACE}/pods/${encodeURIComponent(pod)}/log?container=${container}&tailLines=${tailLines}`,
  );
}

/** Waits until Rook has rolled the OSDs onto the public network. */
export async function waitOsdsOnMultus(progress: Progress): Promise<void> {
  await poll('the OSDs to move to the Multus network', 45 * 60_000, 15_000, async () => {
    const osds = await pods('rook-ceph-osd');
    const done = osds.filter((p) => onMultus(p) && isReady(p)).length;
    progress(`OSDs on the public network and Ready: ${done}/${osds.length}`);
    return osds.length > 0 && done === osds.length ? true : undefined;
  });
}

/**
 * MDS pods do not move to the Multus network on their own (Red Hat docs):
 * restart them one at a time, waiting for each replacement to be Ready.
 */
export async function restartMds(progress: Progress): Promise<void> {
  const mds = (await pods('rook-ceph-mds')).filter((p) => !onMultus(p));
  if (mds.length === 0) {
    progress('MDS pods are already on the public network');
    return;
  }
  for (const pod of mds) {
    const readyOnMultus = (await pods('rook-ceph-mds')).filter((p) => isReady(p) && onMultus(p)).length;
    progress(`Restarting ${pod.metadata.name}`);
    await k8sDelete({ model: PodModel, resource: pod });
    // One restart at a time: wait for the old pod to go and one more MDS to
    // be Ready on the public network before touching the next one.
    await poll(`a replacement for ${pod.metadata.name}`, 10 * 60_000, 10_000, async () => {
      const all = await pods('rook-ceph-mds');
      const stillOld = all.some((p) => p.metadata.name === pod.metadata.name);
      const now = all.filter((p) => isReady(p) && onMultus(p)).length;
      return !stillOld && now > readyOnMultus ? true : undefined;
    });
  }
  progress('MDS pods restarted on the public network');
}

// ------------------------------------------------------ settling Ceph ----

/**
 * Restarts OSDs whose ceph-osd process exited after being marked down too
 * often while the networks changed (see osdStoppedItself). One at a time,
 * waiting for each replacement pod to be Ready. Returns how many restarted.
 */
export async function restartStoppedOsds(progress: Progress): Promise<number> {
  const stopped: PodLite[] = [];
  for (const p of await pods('rook-ceph-osd')) {
    if (p.metadata.deletionTimestamp) continue;
    const log = await podLog(p.metadata.name, 'osd', 300).catch(() => '');
    if (osdStoppedItself(log)) stopped.push(p);
  }
  for (const pod of stopped) {
    const id = pod.metadata.labels?.['ceph-osd-id'];
    progress(`Restarting ${pod.metadata.name}: Ceph marked it down too often while the networks changed and it stopped`);
    await k8sDelete({ model: PodModel, resource: pod });
    await poll(`a replacement for ${pod.metadata.name}`, 10 * 60_000, 10_000, async () => {
      const all = id ? await pods(id, 'ceph-osd-id') : [];
      const stillOld = all.some((p) => p.metadata.name === pod.metadata.name);
      return !stillOld && all.some((p) => isReady(p) && onMultus(p)) ? true : undefined;
    });
  }
  return stopped.length;
}

type CephStatus = { status?: { ceph?: { health?: string; lastChecked?: string; details?: Record<string, { message?: string }> } } };

/**
 * Waits until Ceph reports every OSD up and every PG active, restarting OSDs
 * that stopped themselves along the way. Only health reports newer than the
 * last restart count (Rook refreshes them about once a minute).
 */
export async function settleCeph(progress: Progress): Promise<void> {
  let since = Date.now();
  if (await restartStoppedOsds(progress)) since = Date.now();
  let lastRepair = Date.now();
  await poll('Ceph to report all OSDs up and all PGs active', 30 * 60_000, 15_000, async () => {
    const list = (await k8sListItems({ model: CephClusterModel, queryParams: { ns: ODF_NAMESPACE } })) as CephStatus[];
    const ceph = list[0]?.status?.ceph;
    const fresh = !!ceph?.lastChecked && Date.parse(ceph.lastChecked) > since;
    const open = unsettledChecks(ceph?.details);
    if (fresh && open.length === 0) {
      progress(`Ceph: all OSDs up and all PGs active (${ceph?.health})`);
      return true;
    }
    progress(fresh ? `Ceph: ${open.join('; ')}` : 'Waiting for a fresh Ceph health report');
    // An OSD can stop itself late in the rollout: look again every few minutes.
    if (fresh && Date.now() - lastRepair > 3 * 60_000) {
      lastRepair = Date.now();
      if (await restartStoppedOsds(progress)) since = Date.now();
    }
    return undefined;
  });
}

// ------------------------------------------------------- validation ----

type JobStatus = K8sResourceCommon & { status?: { succeeded?: number; failed?: number } };

/**
 * Runs Rook's Multus validation tool (`rook multus validation run`, shipped
 * in the ODF Rook operator image) as a Job with the operator's image and
 * service account. Before ODF uses the networks it runs the full test (a web
 * server and clients on the NADs, plus host checks through the shims); once
 * Ceph is on Multus it runs host checks only, as the tool recommends.
 * Returns the tool's output; throws with the output if the test fails.
 */
export async function runValidation(clusterNetwork: boolean, hostCheckOnly: boolean, progress: Progress): Promise<string> {
  const op = (await k8sGet({ model: DeploymentModel, name: 'rook-ceph-operator', ns: ODF_NAMESPACE })) as {
    spec?: { template?: { spec?: { serviceAccountName?: string; containers?: Array<{ image?: string }> } } };
  };
  const tpl = op.spec?.template?.spec;
  const image = tpl?.containers?.[0]?.image;
  const sa = tpl?.serviceAccountName;
  if (!image || !sa) throw new Error('Could not read the image and service account of deployment rook-ceph-operator.');
  const labels = { [MANAGED_BY_LABEL]: MANAGED_BY };
  progress(hostCheckOnly ? 'Starting the Multus host check' : 'Starting the Multus validation test');
  const job = (await k8sCreate({
    model: JobModel,
    data: {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: { generateName: 'oct-odf-macvlans-validate-', namespace: ODF_NAMESPACE, labels },
      spec: {
        backoffLimit: 0,
        ttlSecondsAfterFinished: 3600,
        template: {
          metadata: { labels },
          spec: {
            serviceAccountName: sa,
            restartPolicy: 'Never',
            containers: [{ name: 'validate', image, command: ['rook'], args: validationArgs(clusterNetwork, hostCheckOnly, sa) }],
          },
        },
      },
    } as K8sResourceCommon,
  })) as JobStatus;
  const jobName = job.metadata?.name as string;
  const output = async () => {
    const [pod] = await pods(jobName, 'job-name');
    return pod ? podLog(pod.metadata.name, 'validate', 400).catch(() => '') : '';
  };
  const ok = await poll(`validation job ${jobName}`, 30 * 60_000, 10_000, async () => {
    const cur = (await k8sGet({ model: JobModel, name: jobName, ns: ODF_NAMESPACE })) as JobStatus;
    if (cur.status?.succeeded) return true;
    if (cur.status?.failed) return false;
    const last = (await output()).trim().split('\n').pop();
    progress(`Validation job ${jobName}${last ? `: ${last}` : ''}`);
    return undefined;
  });
  const log = await output();
  if (!ok) {
    const err = new Error(`The Multus validation test failed (job ${jobName}).${hostCheckOnly ? '' : ' Nothing was changed in ODF.'}`) as Error & { output?: string };
    err.output = log;
    throw err;
  }
  return log;
}
