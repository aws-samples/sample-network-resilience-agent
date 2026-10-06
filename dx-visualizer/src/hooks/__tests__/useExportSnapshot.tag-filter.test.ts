// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';
import { useExportSnapshot } from '../useExportSnapshot';
import { useTopologyStore } from '../../store/topology-store';
import { makeTaggedTopology } from '../../engine/__tests__/fixtures/tagged-topology';
import { filterTopologyByTags } from '../../engine/tag-filter';
import { deserializeTopologyData, validateSnapshot, type SnapshotFile } from '../../utils/snapshot';

let blob: Blob | undefined;

beforeEach(() => {
  useTopologyStore.setState(useTopologyStore.getInitialState(), true);
  useTopologyStore.setState({
    topologyData: makeTaggedTopology(), useMock: true, credentials: null,
    tagFilters: [{ key: 'Environment', value: 'prod' }, { key: 'Team', value: null }],
  });
  blob = undefined;
  vi.spyOn(URL, 'createObjectURL').mockImplementation((value) => {
    blob = value as Blob;
    return 'blob:snapshot-test';
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function exportFile(sanitize: boolean): Promise<SnapshotFile> {
  const { result } = renderHook(() => useExportSnapshot());
  await result.current({ sanitize });
  return validateSnapshot(JSON.parse(await blob!.text()));
}

describe('snapshot tag filters', () => {
  it.each([false, true])('round-trips filters with the full topology (sanitize=%s)', async (sanitize) => {
    const file = await exportFile(sanitize);
    const topology = deserializeTopologyData(file.topology);
    expect(topology.vpcs).toHaveLength(3);
    const filtered = filterTopologyByTags(topology, file.view.tagFilters!);
    expect(filtered.vpcs).toHaveLength(1);
    expect(filtered.vpcs[0].tags.Environment).toBe(file.view.tagFilters![0].value);
    expect(file.view.tagFilters![1].value).toBeNull();
    if (sanitize) {
      expect(file.view.tagFilters![0].value).not.toBe('prod');
      expect(JSON.stringify(file)).not.toContain('payments');
    }
    useTopologyStore.getState().loadSnapshot(file);
    expect(useTopologyStore.getState().tagFilters).toEqual(file.view.tagFilters);
    useTopologyStore.getState().setTagFilters([]);
    expect(useTopologyStore.getState().topologyData?.vpcs).toHaveLength(3);
  });

  it('keeps an imported filter pinned through sign-out and clears it on exit', async () => {
    const file = await exportFile(false);
    useTopologyStore.getState().loadSnapshot(file);
    useTopologyStore.getState().setCredentials(null);
    useTopologyStore.getState().resetTopology();
    expect(useTopologyStore.getState().tagFilters).toEqual(file.view.tagFilters);
    useTopologyStore.getState().clearImportedSnapshot();
    expect(useTopologyStore.getState().tagFilters).toEqual([]);
  });

  it('defaults old snapshots to an unfiltered view', async () => {
    const file = await exportFile(false);
    delete file.view.tagFilters;
    file.schemaVersion = 1;
    useTopologyStore.getState().loadSnapshot(validateSnapshot(file));
    expect(useTopologyStore.getState().tagFilters).toEqual([]);
  });

  it.each([
    null,
    {},
    [{ key: '', value: 'prod' }],
    [{ key: 'Environment' }],
    [{ key: 'Environment', value: 1 }],
    [{ key: 'Environment', value: 'prod' }, { key: 'Environment', value: 'stage' }],
  ])('rejects malformed filters: %j', async (tagFilters) => {
    const file = await exportFile(false);
    expect(() => validateSnapshot({ ...file, view: { ...file.view, tagFilters } })).toThrow(/invalid AWS tag filters/);
  });
});
