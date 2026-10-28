import {
  DocumentTitle,
  K8sResourceCommon,
  ListPageHeader,
  useK8sWatchResource,
} from '@openshift-console/dynamic-plugin-sdk';
import { useTranslation } from 'react-i18next';
import {
  ActionGroup,
  Alert,
  Button,
  Card,
  CardBody,
  CardTitle,
  Checkbox,
  CodeBlock,
  CodeBlockCode,
  DescriptionList,
  DescriptionListDescription,
  DescriptionListGroup,
  DescriptionListTerm,
  ExpandableSection,
  Form,
  FormGroup,
  FormHelperText,
  FormSelect,
  FormSelectOption,
  HelperText,
  HelperTextItem,
  Label,
  List,
  ListItem,
  PageSection,
  Spinner,
  Stack,
  StackItem,
  TextInput,
  Title,
} from '@patternfly/react-core';
import { Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';
import { CheckCircleIcon, ExclamationCircleIcon, InProgressIcon, PendingIcon } from '@patternfly/react-icons';
import React, { FC, useMemo, useState } from 'react';

import CommunityDisclaimer from './CommunityDisclaimer';
import './odf-macvlans.css';
import {
  CephClusterModel,
  ClusterServiceVersionModel,
  CustomResourceDefinitionModel,
  NetworkAttachmentDefinitionModel,
  NetworkConfigModel,
  NodeModel,
  NodeNetworkConfigurationPolicyModel,
  NodeNetworkStateModel,
  PodModel,
  StorageClusterModel,
  gvk,
} from '../utils/k8s-resources';
import {
  MANAGED_BY,
  MANAGED_BY_LABEL,
  NodeNetworkStateLite,
  ODF_NAMESPACE,
  PUBLIC_NAD,
  PlanInput,
  buildPlan,
  formatCidr,
  interfaceChoices,
  odfVersionSupported,
  parseCidr,
  splitCidr,
  storageClusterPatch,
  targetNodes,
  unsettledChecks,
  usesToolNetworks,
  validatePlan,
} from '../utils/odf-macvlans';
import {
  applyPolicies,
  createNads,
  errorMessage,
  installNmstate,
  isMissingCrd,
  patchStorageCluster,
  restartMds,
  runValidation,
  settleCeph,
  verifyShims,
  waitOsdsOnMultus,
} from '../utils/odf-actions';
import { toYaml } from '../utils/yaml';

const NS = 'plugin__oct-odf-macvlans';

type StorageClusterKind = K8sResourceCommon & {
  spec?: {
    network?: { provider?: string; selectors?: Record<string, string>; addressRanges?: Record<string, string[]> };
    externalStorage?: { enable?: boolean };
  };
  status?: { phase?: string };
};
type CephClusterKind = K8sResourceCommon & { status?: { ceph?: { health?: string; details?: Record<string, { message?: string }> } } };
type NodeKind = K8sResourceCommon & {
  metadata: { name: string; labels?: Record<string, string> };
  spec?: { unschedulable?: boolean };
  status?: { addresses?: Array<{ type: string; address: string }> };
};
type PolicyKind = K8sResourceCommon & { status?: { conditions?: Array<{ type?: string; status?: string; message?: string }> } };
type NetworkConfigKind = K8sResourceCommon & {
  status?: { clusterNetwork?: Array<{ cidr: string }>; serviceNetwork?: string[] };
};

type PodKind = K8sResourceCommon & {
  metadata: { labels?: Record<string, string>; annotations?: Record<string, string>; deletionTimestamp?: string };
  status?: { conditions?: Array<{ type?: string; status?: string }> };
};

type StepState = 'pending' | 'running' | 'done' | 'skipped' | 'error';
const STEPS = [
  'Host networks (NMState policies)',
  'Network attachment definitions',
  'Verify the shim on every node',
  'Multus validation test',
  'Switch ODF to the Multus networks',
  'Wait for OSDs to move',
  'Wait for Ceph to settle (restarts OSDs that stopped)',
  'Restart MDS pods',
] as const;
const VALIDATE_STEP = 3;
/** Steps after the StorageCluster patch; they can be re-run, e.g. after a page reload. */
const POST_SWITCH_FROM = 5;

const StepIcon: FC<{ state: StepState }> = ({ state }) => {
  if (state === 'done') return <CheckCircleIcon className="odfm-ok" />;
  if (state === 'error') return <ExclamationCircleIcon className="odfm-error" />;
  if (state === 'running') return <InProgressIcon className="odfm-running" />;
  if (state === 'skipped') return <PendingIcon className="odfm-muted" />;
  return <PendingIcon className="odfm-pending" />;
};

const OdfMacvlansPage: FC = () => {
  const { t } = useTranslation(NS);

  const [scList, scLoaded, scError] = useK8sWatchResource<StorageClusterKind[]>({
    groupVersionKind: gvk(StorageClusterModel), namespace: ODF_NAMESPACE, isList: true,
  });
  const [cephList] = useK8sWatchResource<CephClusterKind[]>({
    groupVersionKind: gvk(CephClusterModel), namespace: ODF_NAMESPACE, isList: true,
  });
  const [csvList] = useK8sWatchResource<K8sResourceCommon[]>({
    groupVersionKind: gvk(ClusterServiceVersionModel), namespace: ODF_NAMESPACE, isList: true,
  });
  const [nnsList, nnsLoaded, nnsError] = useK8sWatchResource<NodeNetworkStateLite[]>({
    groupVersionKind: gvk(NodeNetworkStateModel), isList: true,
  });
  // The console SDK does not report an error for a kind whose CRD does not
  // exist (the watch just never loads), so detect NMState by its CRD.
  const [nnsCrd, nnsCrdLoaded, nnsCrdError] = useK8sWatchResource<K8sResourceCommon>({
    groupVersionKind: gvk(CustomResourceDefinitionModel), name: 'nodenetworkstates.nmstate.io',
  });
  const [nodeList] = useK8sWatchResource<NodeKind[]>({ groupVersionKind: gvk(NodeModel), isList: true });
  const [netConfig] = useK8sWatchResource<NetworkConfigKind>({ groupVersionKind: gvk(NetworkConfigModel), name: 'cluster' });
  const [policies] = useK8sWatchResource<PolicyKind[]>({
    groupVersionKind: gvk(NodeNetworkConfigurationPolicyModel), isList: true,
    selector: { matchLabels: { [MANAGED_BY_LABEL]: MANAGED_BY } },
  });
  const [nads] = useK8sWatchResource<K8sResourceCommon[]>({
    groupVersionKind: gvk(NetworkAttachmentDefinitionModel), namespace: ODF_NAMESPACE, isList: true,
    selector: { matchLabels: { [MANAGED_BY_LABEL]: MANAGED_BY } },
  });
  const [cephPods] = useK8sWatchResource<PodKind[]>({
    groupVersionKind: gvk(PodModel), namespace: ODF_NAMESPACE, isList: true,
    selector: { matchExpressions: [{ key: 'app', operator: 'In', values: ['rook-ceph-osd', 'rook-ceph-mds'] }] },
  });

  const [iface, setIface] = useState('');
  const [pubVlan, setPubVlan] = useState('');
  const [pubCidr, setPubCidr] = useState('');
  const [clusterEnabled, setClusterEnabled] = useState(true);
  const [cluVlan, setCluVlan] = useState('');
  const [cluCidr, setCluCidr] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [validate, setValidate] = useState(true);
  const [validationOutput, setValidationOutput] = useState('');
  const [hostChecking, setHostChecking] = useState(false);
  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<StepState[]>(STEPS.map(() => 'pending'));
  const [stepMessage, setStepMessage] = useState('');
  const [runError, setRunError] = useState('');
  const [nmstateInstalling, setNmstateInstalling] = useState(false);
  const [nmstateMessage, setNmstateMessage] = useState('');
  const [nmstateError, setNmstateError] = useState('');

  const storageCluster = (scList || [])[0];
  const ceph = (cephList || [])[0];
  const odfCsv = (csvList || []).find((c) => c.metadata?.name?.startsWith('odf-operator.'))?.metadata?.name;
  const nmstateMissing = (nnsCrdLoaded && !nnsCrd?.metadata?.name) || (!!nnsCrdError && isMissingCrd(nnsCrdError)) || (!!nnsError && isMissingCrd(nnsError));
  const nmstateReady = nnsLoaded && !nnsError && (nnsList || []).length > 0;
  const scNetwork = storageCluster?.spec?.network;
  const alreadyMultus = scNetwork?.provider === 'multus';
  const ownMultus = usesToolNetworks(scNetwork);
  const external = !!storageCluster?.spec?.externalStorage?.enable;
  const nodes = useMemo(() => targetNodes((nodeList || []) as never), [nodeList]);
  const choices = useMemo(() => interfaceChoices(nnsList || [], nodes), [nnsList, nodes]);

  const reservedCidrs = useMemo(() => {
    const r: string[] = [];
    (netConfig?.status?.clusterNetwork || []).forEach((c) => r.push(c.cidr));
    (netConfig?.status?.serviceNetwork || []).forEach((c) => r.push(c));
    (nodeList || []).forEach((n) =>
      (n.status?.addresses || []).filter((a) => a.type === 'InternalIP' && !a.address.includes(':')).forEach((a) => r.push(`${a.address}/32`)),
    );
    return r;
  }, [netConfig, nodeList]);

  const input: PlanInput = {
    iface,
    nodes,
    publicNet: { vlan: pubVlan, cidr: pubCidr },
    clusterEnabled,
    clusterNet: { vlan: cluVlan, cidr: cluCidr },
    reservedCidrs,
  };
  const issues = validatePlan(input);
  const issueFor = (field: string) => issues.find((i) => i.field === field)?.message;
  const plan = issues.length === 0 ? buildPlan(input) : undefined;

  const blockers: string[] = [];
  if (scLoaded && !storageCluster) blockers.push(t('No ODF StorageCluster found in openshift-storage.'));
  if (external) blockers.push(t('This StorageCluster uses external Ceph; its network is not managed here.'));
  if (odfCsv && !odfVersionSupported(odfCsv))
    blockers.push(t('{{csv}} cannot switch a running cluster to Multus; ODF 4.21 or later is required.', { csv: odfCsv }));
  if (!nmstateReady) blockers.push(t('The NMState operator is required to configure the node interfaces.'));
  const busy = running || hostChecking;
  const canApply = !!plan && blockers.length === 0 && confirmed && !busy;
  const started = steps.some((st) => st !== 'pending');
  // Once ODF is on Multus the form is replaced by a status card, except while
  // (or right after) this page switched it.
  const showForm = !alreadyMultus || started;

  const setStep = (i: number, st: StepState) => setSteps((prev) => prev.map((v, j) => (j === i ? st : v)));

  const runSteps = async (from: number, actions: Array<(() => Promise<void>) | null>) => {
    setRunning(true);
    setRunError('');
    setSteps(STEPS.map((_, i) => (i < from ? 'skipped' : 'pending')));
    for (let i = from; i < actions.length; i++) {
      const action = actions[i];
      if (!action) {
        setStep(i, 'skipped');
        continue;
      }
      setStep(i, 'running');
      try {
        await action();
        setStep(i, 'done');
      } catch (e) {
        setStep(i, 'error');
        setRunError(errorMessage(e));
        const out = (e as { output?: string }).output;
        if (out) setValidationOutput(out);
        setRunning(false);
        return;
      }
    }
    setStepMessage(t('ODF now uses the macvlan networks.'));
    setRunning(false);
  };

  const postSwitchActions = (): Array<(() => Promise<void>) | null> => [
    null, null, null, null, null,
    () => waitOsdsOnMultus(setStepMessage),
    () => settleCeph(setStepMessage),
    () => restartMds(setStepMessage),
  ];

  const onInstallNmstate = async () => {
    setNmstateInstalling(true);
    setNmstateError('');
    try {
      await installNmstate(setNmstateMessage);
      setNmstateMessage(t('NMState is installed.'));
    } catch (e) {
      setNmstateError(errorMessage(e));
    } finally {
      setNmstateInstalling(false);
    }
  };

  const onApply = () => {
    if (!plan || !storageCluster?.metadata?.name) return;
    setValidationOutput('');
    const post = postSwitchActions();
    runSteps(0, [
      () => applyPolicies(plan, setStepMessage),
      () => createNads(plan, setStepMessage),
      () => verifyShims(plan, setStepMessage),
      validate
        ? async () => setValidationOutput(await runValidation(clusterEnabled, false, setStepMessage))
        : null,
      () => patchStorageCluster(storageCluster.metadata?.name as string, plan, setStepMessage),
      ...post.slice(POST_SWITCH_FROM),
    ]);
  };

  const onFinish = () => runSteps(POST_SWITCH_FROM, postSwitchActions());

  const onHostCheck = async () => {
    setHostChecking(true);
    setValidationOutput('');
    setRunError('');
    try {
      setValidationOutput(await runValidation(!!scNetwork?.selectors?.cluster, true, setStepMessage));
      setStepMessage(t('Host check passed: every node reaches the public network through its shim.'));
    } catch (e) {
      setRunError(errorMessage(e));
      setValidationOutput((e as { output?: string }).output || '');
    } finally {
      setHostChecking(false);
    }
  };

  const osdPods = (cephPods || []).filter((p) => p.metadata?.labels?.app === 'rook-ceph-osd' && !p.metadata?.deletionTimestamp);
  const mdsPods = (cephPods || []).filter((p) => p.metadata?.labels?.app === 'rook-ceph-mds' && !p.metadata?.deletionTimestamp);
  const onPublic = (p: PodKind) => (p.metadata?.annotations?.['k8s.v1.cni.cncf.io/networks'] || '').includes(PUBLIC_NAD);
  const podReady = (p: PodKind) => !!p.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True');
  const openChecks = unsettledChecks(ceph?.status?.ceph?.details);

  const health = ceph?.status?.ceph?.health;
  const pubSplit = parseCidr(pubCidr) ? splitCidr(parseCidr(pubCidr)!) : undefined;

  return (
    <>
      <DocumentTitle>{t('ODF Macvlans')}</DocumentTitle>
      <ListPageHeader title={t('ODF Macvlans')} />
      <PageSection>
        <CommunityDisclaimer />
        <Stack hasGutter>
          {/* Prerequisites */}
          <StackItem>
            <Card>
              <CardTitle>
                <Title headingLevel="h2">{t('OpenShift Data Foundation')}</Title>
              </CardTitle>
              <CardBody>
                {!scLoaded && !scError ? (
                  <Spinner size="md" />
                ) : (
                  <DescriptionList isHorizontal isCompact>
                    <DescriptionListGroup>
                      <DescriptionListTerm>{t('StorageCluster')}</DescriptionListTerm>
                      <DescriptionListDescription>
                        {storageCluster ? (
                          <>
                            {storageCluster.metadata?.name} <Label isCompact>{storageCluster.status?.phase || '—'}</Label>
                          </>
                        ) : (
                          errorMessage(scError) || t('Not found')
                        )}
                      </DescriptionListDescription>
                    </DescriptionListGroup>
                    <DescriptionListGroup>
                      <DescriptionListTerm>{t('ODF version')}</DescriptionListTerm>
                      <DescriptionListDescription>{odfCsv || '—'}</DescriptionListDescription>
                    </DescriptionListGroup>
                    <DescriptionListGroup>
                      <DescriptionListTerm>{t('Ceph health')}</DescriptionListTerm>
                      <DescriptionListDescription>
                        <Label color={health === 'HEALTH_OK' ? 'green' : health === 'HEALTH_WARN' ? 'orange' : 'red'} isCompact>
                          {health || '—'}
                        </Label>
                      </DescriptionListDescription>
                    </DescriptionListGroup>
                    <DescriptionListGroup>
                      <DescriptionListTerm>{t('Current network')}</DescriptionListTerm>
                      <DescriptionListDescription>
                        {alreadyMultus
                          ? t('Multus: public {{p}}, cluster {{c}}', {
                              p: storageCluster?.spec?.network?.selectors?.public || '—',
                              c: storageCluster?.spec?.network?.selectors?.cluster || '—',
                            })
                          : t('Pod network (default)')}
                      </DescriptionListDescription>
                    </DescriptionListGroup>
                    <DescriptionListGroup>
                      <DescriptionListTerm>{t('NMState')}</DescriptionListTerm>
                      <DescriptionListDescription>
                        {nmstateReady ? (
                          <Label color="green" isCompact>{t('Installed')}</Label>
                        ) : (
                          <Stack hasGutter>
                            <StackItem>
                              {nmstateMissing
                                ? t('Not installed. It configures the VLAN and shim interfaces on the nodes.')
                                : t('Installed, but nodes are not reporting their interfaces yet. Finishing the setup creates the NMState instance if it is missing.')}
                            </StackItem>
                            <StackItem>
                              <Button variant="secondary" onClick={onInstallNmstate} isLoading={nmstateInstalling} isDisabled={nmstateInstalling}>
                                {nmstateMissing ? t('Install NMState operator') : t('Finish NMState setup')}
                              </Button>
                            </StackItem>
                            {nmstateMessage && <StackItem className="odfm-muted">{nmstateMessage}</StackItem>}
                            {nmstateError && <StackItem><Alert isInline variant="danger" title={nmstateError} /></StackItem>}
                          </Stack>
                        )}
                      </DescriptionListDescription>
                    </DescriptionListGroup>
                  </DescriptionList>
                )}
              </CardBody>
            </Card>
          </StackItem>

          {/* ODF already on Multus */}
          {alreadyMultus && !ownMultus && !started && (
            <StackItem>
              <Alert isInline variant="info" title={t('ODF already uses Multus networks')}>
                {t('The public network is {{p}}, which was not set up by this tool. There is nothing to do here.', {
                  p: scNetwork?.selectors?.public || '—',
                })}
              </Alert>
            </StackItem>
          )}
          {ownMultus && (
            <StackItem>
              <Card>
                <CardTitle>
                  <Title headingLevel="h2">{t('ODF uses the macvlan networks')}</Title>
                </CardTitle>
                <CardBody>
                  <Stack hasGutter>
                    <StackItem>
                      <DescriptionList isHorizontal isCompact>
                        <DescriptionListGroup>
                          <DescriptionListTerm>{t('Public network')}</DescriptionListTerm>
                          <DescriptionListDescription>
                            {scNetwork?.selectors?.public} {(scNetwork?.addressRanges?.public || []).join(', ')}
                          </DescriptionListDescription>
                        </DescriptionListGroup>
                        <DescriptionListGroup>
                          <DescriptionListTerm>{t('Cluster network')}</DescriptionListTerm>
                          <DescriptionListDescription>
                            {scNetwork?.selectors?.cluster
                              ? `${scNetwork.selectors.cluster} ${(scNetwork?.addressRanges?.cluster || []).join(', ')}`
                              : t('Not used (replication runs on the public network)')}
                          </DescriptionListDescription>
                        </DescriptionListGroup>
                        <DescriptionListGroup>
                          <DescriptionListTerm>{t('OSDs on the public network and Ready')}</DescriptionListTerm>
                          <DescriptionListDescription>
                            {osdPods.filter((p) => onPublic(p) && podReady(p)).length}/{osdPods.length}
                          </DescriptionListDescription>
                        </DescriptionListGroup>
                        <DescriptionListGroup>
                          <DescriptionListTerm>{t('MDS on the public network and Ready')}</DescriptionListTerm>
                          <DescriptionListDescription>
                            {mdsPods.filter((p) => onPublic(p) && podReady(p)).length}/{mdsPods.length}
                          </DescriptionListDescription>
                        </DescriptionListGroup>
                        <DescriptionListGroup>
                          <DescriptionListTerm>{t('Ceph data availability')}</DescriptionListTerm>
                          <DescriptionListDescription>
                            {openChecks.length ? (
                              <span className="odfm-error">{openChecks.join('; ')}</span>
                            ) : (
                              <span className="odfm-ok">{t('All OSDs up, all PGs active')}</span>
                            )}
                          </DescriptionListDescription>
                        </DescriptionListGroup>
                      </DescriptionList>
                    </StackItem>
                    <StackItem>
                      <HelperText>
                        <HelperTextItem>
                          {t('If the page was closed during the switch, run the remaining steps: wait for the OSDs, restart OSDs that stopped, restart MDS pods. The host check runs Rook\'s Multus validation tool in host-check mode.')}
                        </HelperTextItem>
                      </HelperText>
                    </StackItem>
                    <StackItem>
                      <ActionGroup>
                        <Button variant="secondary" onClick={onFinish} isDisabled={busy} isLoading={running}>
                          {t('Run the post-switch steps')}
                        </Button>
                        <Button variant="secondary" onClick={onHostCheck} isDisabled={busy} isLoading={hostChecking}>
                          {t('Run the host check')}
                        </Button>
                      </ActionGroup>
                    </StackItem>
                    {hostChecking && stepMessage && <StackItem className="odfm-muted">{stepMessage}</StackItem>}
                  </Stack>
                </CardBody>
              </Card>
            </StackItem>
          )}

          {/* Form */}
          {showForm && !ownMultus && (
          <StackItem>
            <Card>
              <CardTitle>
                <Title headingLevel="h2">{t('Macvlan networks for ODF')}</Title>
              </CardTitle>
              <CardBody>
                <Form>
                  <FormGroup label={t('Node interface')} isRequired fieldId="odfm-iface">
                    <FormSelect id="odfm-iface" value={iface} onChange={(_e, v) => setIface(v)} isDisabled={!nmstateReady}>
                      <FormSelectOption value="" label={t('Select an interface')} isDisabled />
                      {choices.map((c) => (
                        <FormSelectOption
                          key={c.name}
                          value={c.name}
                          label={`${c.name} (${c.type}${c.controller ? `, in ${c.controller}` : ''})`}
                        />
                      ))}
                    </FormSelect>
                    <FormHelperText>
                      <HelperText>
                        <HelperTextItem>
                          {t('Interfaces present on all {{n}} worker nodes. Each node gets its VLAN interfaces and a shim on this interface.', {
                            n: nodes.length,
                          })}
                        </HelperTextItem>
                      </HelperText>
                    </FormHelperText>
                  </FormGroup>

                  <Title headingLevel="h3">{t('Public network')}</Title>
                  <FormGroup label={t('VLAN ID')} fieldId="odfm-pub-vlan">
                    <TextInput id="odfm-pub-vlan" value={pubVlan} onChange={(_e, v) => setPubVlan(v)} placeholder={t('Empty for untagged')}
                      validated={issueFor('public-vlan') ? 'error' : 'default'} />
                    {issueFor('public-vlan') && <FormHelperText><HelperText><HelperTextItem variant="error">{issueFor('public-vlan')}</HelperTextItem></HelperText></FormHelperText>}
                  </FormGroup>
                  <FormGroup label={t('CIDR')} isRequired fieldId="odfm-pub-cidr">
                    <TextInput id="odfm-pub-cidr" value={pubCidr} onChange={(_e, v) => setPubCidr(v)} placeholder="192.168.20.0/24"
                      validated={pubCidr && issueFor('public-cidr') ? 'error' : 'default'} />
                    <FormHelperText>
                      <HelperText>
                        {pubCidr && issueFor('public-cidr') ? (
                          <HelperTextItem variant="error">{issueFor('public-cidr')}</HelperTextItem>
                        ) : (
                          <HelperTextItem>
                            {pubSplit
                              ? t('Nodes: {{n}} (one shim IP each). ODF pods: {{p}}.', { n: formatCidr(pubSplit.nodes), p: formatCidr(pubSplit.pods) })
                              : t('Lower half for node shims, upper half for ODF pods.')}
                          </HelperTextItem>
                        )}
                      </HelperText>
                    </FormHelperText>
                  </FormGroup>

                  <Checkbox id="odfm-cluster" label={t('Also create a cluster (replication) network')} isChecked={clusterEnabled}
                    onChange={(_e, v) => setClusterEnabled(v)}
                    description={t('Separates OSD replication traffic. Red Hat recommends starting with the public network only.')} />
                  {clusterEnabled && (
                    <>
                      <FormGroup label={t('VLAN ID')} fieldId="odfm-clu-vlan">
                        <TextInput id="odfm-clu-vlan" value={cluVlan} onChange={(_e, v) => setCluVlan(v)} placeholder={t('Empty for untagged')}
                          validated={issueFor('cluster-vlan') ? 'error' : 'default'} />
                        {issueFor('cluster-vlan') && <FormHelperText><HelperText><HelperTextItem variant="error">{issueFor('cluster-vlan')}</HelperTextItem></HelperText></FormHelperText>}
                      </FormGroup>
                      <FormGroup label={t('CIDR')} isRequired fieldId="odfm-clu-cidr">
                        <TextInput id="odfm-clu-cidr" value={cluCidr} onChange={(_e, v) => setCluCidr(v)} placeholder="192.168.21.0/24"
                          validated={cluCidr && issueFor('cluster-cidr') ? 'error' : 'default'} />
                        {cluCidr && issueFor('cluster-cidr') && <FormHelperText><HelperText><HelperTextItem variant="error">{issueFor('cluster-cidr')}</HelperTextItem></HelperText></FormHelperText>}
                      </FormGroup>
                    </>
                  )}
                </Form>
              </CardBody>
            </Card>
          </StackItem>
          )}

          {/* Review + apply */}
          {plan && showForm && !ownMultus && (
            <StackItem>
              <Card>
                <CardTitle>
                  <Title headingLevel="h2">{t('Review and apply')}</Title>
                </CardTitle>
                <CardBody>
                  <Stack hasGutter>
                    <StackItem>
                      <Table aria-label={t('Node addresses')} variant="compact">
                        <Thead>
                          <Tr><Th>{t('Node')}</Th><Th>{t('Shim IP (public network)')}</Th></Tr>
                        </Thead>
                        <Tbody>
                          {Object.entries(plan.shimIps).map(([n, ip]) => (
                            <Tr key={n}><Td>{n}</Td><Td>{ip}</Td></Tr>
                          ))}
                        </Tbody>
                      </Table>
                    </StackItem>
                    <StackItem>
                      <ExpandableSection toggleText={t('Show the objects that will be created')}>
                        <CodeBlock>
                          <CodeBlockCode>
                            {[...plan.policies, ...plan.nads].map((o) => toYaml(o as never)).join('---\n') +
                              `---\n# StorageCluster ${storageCluster?.metadata?.name} (merge)\n` +
                              toYaml(storageClusterPatch(plan) as never)}
                          </CodeBlockCode>
                        </CodeBlock>
                      </ExpandableSection>
                    </StackItem>
                    {blockers.length > 0 && (
                      <StackItem>
                        <Alert isInline variant="warning" title={t('Cannot apply yet')}>
                          <List>{blockers.map((b) => <ListItem key={b}>{b}</ListItem>)}</List>
                        </Alert>
                      </StackItem>
                    )}
                    <StackItem>
                      <Alert isInline variant="info" title={t('What happens')}>
                        {t('Node networks are configured first; ODF is only changed once every node has its shim. Switching ODF restarts Ceph daemons one by one, so storage I/O can pause briefly. Moving back to the pod network is not supported by ODF.')}
                      </Alert>
                    </StackItem>
                    <StackItem>
                      <Checkbox id="odfm-validate" isChecked={validate} onChange={(_e, v) => setValidate(v)} isDisabled={busy}
                        label={t('Run the Multus validation test before switching ODF (recommended)')}
                        description={t('Rook\'s validation tool from the ODF operator image checks that pods on every node reach each other on these networks and that hosts reach them through the shim. It pulls quay.io/nginx/nginx-unprivileged and takes a few minutes.')} />
                    </StackItem>
                    <StackItem>
                      <Checkbox id="odfm-confirm" isChecked={confirmed} onChange={(_e, v) => setConfirmed(v)} isDisabled={busy}
                        label={t('I understand that ODF moves to these networks and Ceph pods restart.')} />
                    </StackItem>
                    <StackItem>
                      <ActionGroup>
                        <Button variant="primary" onClick={onApply} isDisabled={!canApply} isLoading={running}>
                          {t('Apply')}
                        </Button>
                      </ActionGroup>
                    </StackItem>
                  </Stack>
                </CardBody>
              </Card>
            </StackItem>
          )}

          {/* Progress */}
          {(started || validationOutput || (runError && !running)) && (
            <StackItem>
              <Card>
                <CardTitle>
                  <Title headingLevel="h2">{t('Progress')}</Title>
                </CardTitle>
                <CardBody>
                  <Stack hasGutter>
                    {started && (
                      <StackItem>
                        <List isPlain>
                          {STEPS.map((st, i) => (
                            <ListItem key={st} icon={<StepIcon state={steps[i]} />}>
                              {t(st)}
                              {steps[i] === 'skipped' && <span className="odfm-muted"> — {t('skipped')}</span>}
                            </ListItem>
                          ))}
                        </List>
                        {stepMessage && <div className="odfm-muted">{stepMessage}</div>}
                      </StackItem>
                    )}
                    {runError && (
                      <StackItem>
                        <Alert isInline variant="danger" title={t('Stopped')}>{runError}</Alert>
                      </StackItem>
                    )}
                    {validationOutput && (
                      <StackItem>
                        <ExpandableSection toggleText={t('Show the Multus validation output')}>
                          <CodeBlock>
                            <CodeBlockCode>{validationOutput}</CodeBlockCode>
                          </CodeBlock>
                        </ExpandableSection>
                      </StackItem>
                    )}
                  </Stack>
                </CardBody>
              </Card>
            </StackItem>
          )}

          {/* Inventory */}
          {((policies || []).length > 0 || (nads || []).length > 0) && (
            <StackItem>
              <Card>
                <CardTitle>
                  <Title headingLevel="h2">{t('Managed by ODF Macvlans')}</Title>
                </CardTitle>
                <CardBody>
                  <Table aria-label={t('Managed objects')} variant="compact">
                    <Thead>
                      <Tr><Th>{t('Kind')}</Th><Th>{t('Name')}</Th><Th>{t('Status')}</Th></Tr>
                    </Thead>
                    <Tbody>
                      {(policies || []).map((p) => {
                        const conds = p.status?.conditions || [];
                        const st = conds.find((c) => c.type === 'Degraded' && c.status === 'True') ? t('Degraded')
                          : conds.find((c) => c.type === 'Available' && c.status === 'True') ? t('Available') : t('Progressing');
                        return <Tr key={p.metadata?.uid}><Td>NodeNetworkConfigurationPolicy</Td><Td>{p.metadata?.name}</Td><Td>{st}</Td></Tr>;
                      })}
                      {(nads || []).map((n) => (
                        <Tr key={n.metadata?.uid}><Td>NetworkAttachmentDefinition</Td><Td>{`${n.metadata?.namespace}/${n.metadata?.name}`}</Td><Td>—</Td></Tr>
                      ))}
                    </Tbody>
                  </Table>
                </CardBody>
              </Card>
            </StackItem>
          )}
        </Stack>
      </PageSection>
    </>
  );
};

export default OdfMacvlansPage;
