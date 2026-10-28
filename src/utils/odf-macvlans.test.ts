import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  PlanInput, buildPlan, interfaceChoices, odfVersionSupported, parseCidr, shimAddresses, splitCidr,
  storageClusterPatch, targetNodes, validatePlan, formatCidr, osdStoppedItself, unsettledChecks, usesToolNetworks,
  validationArgs,
} from './odf-macvlans';

const base: PlanInput = {
  iface: 'bond0',
  nodes: ['node3', 'node1', 'node2'],
  publicNet: { vlan: '2101', cidr: '192.168.20.0/24' },
  clusterEnabled: true,
  clusterNet: { vlan: '2102', cidr: '192.168.21.0/24' },
  reservedCidrs: ['10.128.0.0/14', '172.30.0.0/16', '198.51.100.0/24'],
};

test('CIDR parsing and split', () => {
  assert.equal(parseCidr('192.168.20.1/24'), undefined, 'host bits set');
  const c = parseCidr('192.168.20.0/24')!;
  const s = splitCidr(c);
  assert.equal(formatCidr(s.nodes), '192.168.20.0/25');
  assert.equal(formatCidr(s.pods), '192.168.20.128/25');
});

test('shim IPs are stable, sorted and start at .11', () => {
  assert.deepEqual(shimAddresses(parseCidr('192.168.20.0/24')!, ['node3', 'node1', 'node2']),
    { node1: '192.168.20.11', node2: '192.168.20.12', node3: '192.168.20.13' });
});

test('valid plan has no issues; builds one policy per node and two NADs', () => {
  assert.deepEqual(validatePlan(base), []);
  const plan = buildPlan(base);
  assert.equal(plan.policies.length, 3);
  assert.equal(plan.nads.length, 2);
  const p1 = plan.policies[0] as any;
  assert.equal(p1.metadata.name, 'oct-odf-macvlans-node1');
  assert.deepEqual(p1.spec.nodeSelector, { 'kubernetes.io/hostname': 'node1' });
  const ifs = p1.spec.desiredState.interfaces;
  assert.deepEqual(ifs.map((i: any) => i.name), ['bond0.2101', 'bond0.2102', 'odf-pub-shim']);
  assert.equal(ifs[2]['mac-vlan']['base-iface'], 'bond0.2101');
  assert.deepEqual(ifs[2].ipv4.address, [{ ip: '192.168.20.11', 'prefix-length': 24 }]);
  const pubCfg = JSON.parse((plan.nads[0].spec as any).config);
  assert.equal(pubCfg.type, 'macvlan'); assert.equal(pubCfg.master, 'bond0.2101'); assert.equal(pubCfg.mode, 'bridge');
  assert.deepEqual(pubCfg.ipam, { type: 'whereabouts', range: '192.168.20.0/24', exclude: ['192.168.20.0/25'], routes: [{ dst: '192.168.20.0/24' }] });
  assert.equal(plan.nads[0].metadata.namespace, 'openshift-storage');
  assert.deepEqual(storageClusterPatch(plan), { spec: { network: {
    provider: 'multus',
    selectors: { public: 'openshift-storage/odf-public-network', cluster: 'openshift-storage/odf-cluster-network' },
    addressRanges: { public: ['192.168.20.0/24'], cluster: ['192.168.21.0/24'] },
  } } });
});

test('public-only plan: no cluster NAD, VLAN interface or selector', () => {
  const plan = buildPlan({ ...base, clusterEnabled: false });
  assert.equal(plan.nads.length, 1);
  assert.deepEqual((plan.policies[0] as any).spec.desiredState.interfaces.map((i: any) => i.name), ['bond0.2101', 'odf-pub-shim']);
  assert.deepEqual(Object.keys((plan.storageClusterNetwork as any).selectors), ['public']);
});

test('untagged public network: shim sits directly on the interface', () => {
  const plan = buildPlan({ ...base, clusterEnabled: false, publicNet: { vlan: '', cidr: '192.168.20.0/24' } });
  const ifs = (plan.policies[0] as any).spec.desiredState.interfaces;
  assert.deepEqual(ifs.map((i: any) => i.name), ['odf-pub-shim']);
  assert.equal(ifs[0]['mac-vlan']['base-iface'], 'bond0');
});

test('validation catches the mistakes users make', () => {
  const msgs = (i: PlanInput) => validatePlan(i).map((x) => x.field);
  assert.ok(msgs({ ...base, publicNet: { vlan: '5000', cidr: '192.168.20.0/24' } }).includes('public-vlan'));
  assert.ok(msgs({ ...base, publicNet: { vlan: '2101', cidr: '192.168.20.5/24' } }).includes('public-cidr'));
  assert.ok(msgs({ ...base, publicNet: { vlan: '2101', cidr: '172.30.4.0/24' } }).includes('public-cidr'), 'overlaps service network');
  assert.ok(msgs({ ...base, clusterNet: { vlan: '2101', cidr: '192.168.21.0/24' } }).includes('cluster-vlan'), 'same VLAN');
  assert.ok(msgs({ ...base, publicNet: { vlan: '', cidr: '192.168.20.0/24' }, clusterNet: { vlan: '', cidr: '192.168.21.0/24' } }).includes('cluster-vlan'), 'both untagged');
  assert.ok(msgs({ ...base, clusterNet: { vlan: '2102', cidr: '192.168.20.128/25' } }).includes('cluster-cidr'), 'overlap');
  const many = Array.from({ length: 20 }, (_, i) => `n${i}`);
  assert.ok(msgs({ ...base, nodes: many, publicNet: { vlan: '2101', cidr: '192.168.20.0/27' } }).includes('public-cidr'), 'too small');
  assert.ok(msgs({ ...base, iface: '' }).includes('iface'));
});

test('interface choices: present on all target nodes, bonds first, bond members hidden', () => {
  const nns = (name: string, extra: any[] = []) => ({ metadata: { name }, status: { currentState: { interfaces: [
    { name: 'bond0', type: 'bond', state: 'up', controller: 'br-ex' },
    { name: 'eno1', type: 'ethernet', state: 'up', controller: 'bond0' },
    { name: 'eno3', type: 'ethernet', state: 'up' },
    { name: 'br-ex', type: 'ovs-bridge', state: 'up' },
    ...extra,
  ] } } });
  const choices = interfaceChoices([nns('node1', [{ name: 'eno4', type: 'ethernet', state: 'up' }]), nns('node2')], ['node1', 'node2']);
  assert.deepEqual(choices.map((c) => c.name), ['bond0', 'eno3'], 'eno4 is missing on node2, eno1 is a bond member');
});

test('target nodes and ODF version gate', () => {
  assert.deepEqual(targetNodes([
    { metadata: { name: 'b', labels: { 'node-role.kubernetes.io/worker': '' } } },
    { metadata: { name: 'a', labels: { 'node-role.kubernetes.io/worker': '' } } },
    { metadata: { name: 'infra', labels: { 'node-role.kubernetes.io/infra': '' } } },
    { metadata: { name: 'cordoned', labels: { 'node-role.kubernetes.io/worker': '' } }, spec: { unschedulable: true } },
  ]), ['a', 'b']);
  assert.equal(odfVersionSupported('odf-operator.v4.22.6-rhodf'), true);
  assert.equal(odfVersionSupported('odf-operator.v4.21.14-rhodf'), true);
  assert.equal(odfVersionSupported('odf-operator.v4.20.3-rhodf'), false);
  assert.equal(odfVersionSupported(undefined), false);
});

test('after the switch: own networks, stopped OSDs, Ceph settle checks, validation args', () => {
  assert.equal(usesToolNetworks({ provider: 'multus', selectors: { public: 'openshift-storage/odf-public-network' } }), true);
  assert.equal(usesToolNetworks({ provider: 'multus', selectors: { public: 'openshift-storage/public-net' } }), false);
  assert.equal(usesToolNetworks(undefined), false);
  assert.equal(osdStoppedItself('osd.0 329 _committed_osd_maps marked down 6 > osd_max_markdown_count 5 in last 600.000000 seconds, shutting down'), true);
  assert.equal(osdStoppedItself('osd.0 boot\nosd.0 state: booting -> active'), false);
  assert.deepEqual(unsettledChecks({
    AUTH_INSECURE_KEYS_ALLOWED: { message: 'insecure' },
    OSD_DOWN: { message: '3 osds down' },
    PG_AVAILABILITY: { message: '20 pgs inactive' },
    SLOW_OPS: { message: 'slow' },
  }), ['3 osds down', '20 pgs inactive']);
  assert.deepEqual(unsettledChecks(undefined), []);
  assert.deepEqual(validationArgs(true, false, 'sa'), [
    'multus', 'validation', 'run', '--namespace=openshift-storage', '--service-account=sa',
    '--public-network=openshift-storage/odf-public-network', '--cluster-network=openshift-storage/odf-cluster-network',
  ]);
  assert.ok(validationArgs(false, true, 'sa').includes('--host-check-only'));
  assert.ok(!validationArgs(false, true, 'sa').some((a) => a.startsWith('--cluster-network')));
});
