import { K8sModel } from '@openshift-console/dynamic-plugin-sdk';

const model = (
  apiGroup: string | undefined,
  apiVersion: string,
  kind: string,
  plural: string,
  namespaced: boolean,
  abbr: string,
): K8sModel => ({
  ...(apiGroup ? { apiGroup } : {}),
  apiVersion,
  kind,
  plural,
  namespaced,
  abbr,
  label: kind,
  labelPlural: `${kind}s`,
});

/** Live interfaces per node, reported by NMState. */
export const NodeNetworkStateModel = model('nmstate.io', 'v1beta1', 'NodeNetworkState', 'nodenetworkstates', false, 'NNS');
/** Desired host network state (VLANs and the public-network shim). */
export const NodeNetworkConfigurationPolicyModel = model('nmstate.io', 'v1', 'NodeNetworkConfigurationPolicy', 'nodenetworkconfigurationpolicies', false, 'NNCP');
/** Per-node result of applying a policy. */
export const NodeNetworkConfigurationEnactmentModel = model('nmstate.io', 'v1beta1', 'NodeNetworkConfigurationEnactment', 'nodenetworkconfigurationenactments', false, 'NNCE');
/** The NMState operator instance (one per cluster, named "nmstate"). */
export const NMStateModel = model('nmstate.io', 'v1', 'NMState', 'nmstates', false, 'NMS');
export const NetworkAttachmentDefinitionModel = model('k8s.cni.cncf.io', 'v1', 'NetworkAttachmentDefinition', 'network-attachment-definitions', true, 'NAD');
/** ODF StorageCluster. Use the full group: Portworx also defines a StorageCluster kind. */
export const StorageClusterModel = model('ocs.openshift.io', 'v1', 'StorageCluster', 'storageclusters', true, 'SC');
export const CephClusterModel = model('ceph.rook.io', 'v1', 'CephCluster', 'cephclusters', true, 'CEPH');
export const CustomResourceDefinitionModel = model('apiextensions.k8s.io', 'v1', 'CustomResourceDefinition', 'customresourcedefinitions', false, 'CRD');
export const NodeModel = model(undefined, 'v1', 'Node', 'nodes', false, 'N');
export const PodModel = model(undefined, 'v1', 'Pod', 'pods', true, 'P');
export const NamespaceModel = model(undefined, 'v1', 'Namespace', 'namespaces', false, 'NS');
export const NetworkConfigModel = model('config.openshift.io', 'v1', 'Network', 'networks', false, 'NET');
export const OperatorGroupModel = model('operators.coreos.com', 'v1', 'OperatorGroup', 'operatorgroups', true, 'OG');
export const SubscriptionModel = model('operators.coreos.com', 'v1alpha1', 'Subscription', 'subscriptions', true, 'SUB');
export const DeploymentModel = model('apps', 'v1', 'Deployment', 'deployments', true, 'D');
export const JobModel = model('batch', 'v1', 'Job', 'jobs', true, 'J');
export const ClusterServiceVersionModel = model('operators.coreos.com', 'v1alpha1', 'ClusterServiceVersion', 'clusterserviceversions', true, 'CSV');

/** For useK8sWatchResource groupVersionKind. */
export const gvk = (m: K8sModel) => ({ group: m.apiGroup, version: m.apiVersion, kind: m.kind });
