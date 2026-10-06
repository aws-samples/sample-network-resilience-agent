import { useMemo, useState } from 'react';
import { getTagMatchIds, getTaggedResources, getTagOptions } from '../engine/tag-filter';
import { useTopologyStore } from '../store/topology-store';
import { useIsLight } from '../hooks/useTheme';
import { useRedact } from '../utils/redact';
import { COLORS } from '../utils/colors';
import { TagFilterSelect } from './TagFilterSelect';
import { ViewOptionsBadge, ViewOptionsSection } from './ViewOptionsPanel';

export function TagFilterPanel() {
  const light = useIsLight();
  const r = useRedact();
  const topology = useTopologyStore((s) => s.topologyData);
  const filters = useTopologyStore((s) => s.tagFilters);
  const setFilters = useTopologyStore((s) => s.setTagFilters);
  const requestTagFit = useTopologyStore((s) => s.requestTagFit);
  const [expanded, setExpanded] = useState(true);
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const resources = useMemo(() => topology ? getTaggedResources(topology) : [], [topology]);
  const options = useMemo(() => getTagOptions(resources), [resources]);
  const available = options.filter((option) => !filters.some((f) => f.key === option.key));
  const selected = available.find((option) => option.key === key);
  const selectedValue = selected?.values.some((v) => JSON.stringify(v) === value) ? value : '';
  // Same predicate the canvas markers use, so the count and the markers agree.
  const matchCount = useMemo(() => topology ? getTagMatchIds(topology, filters).size : 0, [topology, filters]);
  const active = filters.length > 0;

  if (!topology) return null;

  return (
    <ViewOptionsSection
      title="AWS tags"
      toggleLabel="Toggle AWS tag filters"
      expanded={expanded}
      onToggle={() => setExpanded(!expanded)}
      badge={active ? <ViewOptionsBadge>{filters.length} active</ViewOptionsBadge> : undefined}
    >
      <div className="space-y-3">
        <p className="leading-relaxed">
          Show matching resources and their network paths.
        </p>
        {active && (
          <ul className="space-y-1" aria-label="Active tag filters">
            {filters.map((filter) => (
              <li key={filter.key} className={`flex items-center gap-2 rounded px-2 py-1 ${
                light ? 'bg-violet-100 text-violet-800' : 'bg-violet-500/15 text-violet-200'
              }`}>
                <span className="min-w-0 flex-1 break-all">
                  <span className="font-semibold">{r(filter.key)}</span>
                  {' = '}{filter.value === null ? 'Any value' : r(filter.value) || '(empty)'}
                </span>
                <button
                  type="button"
                  onClick={() => setFilters(filters.filter((f) => f.key !== filter.key))}
                  aria-label={`Remove tag filter ${r(filter.key)}`}
                  className="shrink-0 rounded px-1 text-base hover:bg-black/10 focus-visible:ring-2 focus-visible:ring-violet-500"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        {options.length > 0 ? (
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (!selected) return;
              setFilters([...filters, {
                key: selected.key,
                value: selectedValue === '' ? null : JSON.parse(selectedValue) as string,
              }]);
              setKey('');
              setValue('');
            }}
          >
            <TagFilterSelect
              label="Tag key"
              value={selected?.key ?? ''}
              disabled={available.length === 0}
              placeholder={available.length ? 'Select a tag key' : 'All tag keys selected'}
              options={available.map((option) => ({ value: option.key, label: r(option.key) }))}
              onChange={(nextKey) => { setKey(nextKey); setValue(''); }}
            />
            <TagFilterSelect
              label="Tag value"
              value={selectedValue}
              disabled={!selected}
              options={[
                { value: '', label: 'Any value' },
                ...(selected?.values.map((v) => ({ value: JSON.stringify(v), label: r(v) || '(empty)' })) ?? []),
              ]}
              onChange={setValue}
            />
            <button
              type="submit"
              disabled={!selected}
              className="w-full rounded px-2 py-1.5 text-white font-semibold disabled:opacity-40 disabled:cursor-not-allowed hover:brightness-110 focus-visible:ring-2 focus-visible:ring-violet-500"
              style={{ backgroundColor: COLORS.existing.border }}
            >
              Add filter
            </button>
          </form>
        ) : (
          <p className={light ? 'text-gray-500' : 'text-slate-400'}>
            No AWS tags were loaded. Refresh AWS data or import a snapshot that includes tags.
          </p>
        )}
        {active && (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <p role="status" className={matchCount === 0 ? light ? 'text-amber-700' : 'text-amber-300' : ''}>
                {matchCount === 0 ? 'No matching resources' : (
                  <button
                    type="button"
                    onClick={requestTagFit}
                    title="Zoom to the resources that carry these tags (marked with a tag icon)"
                    className="underline decoration-dotted underline-offset-2 hover:opacity-75 focus-visible:ring-2 focus-visible:ring-violet-500 rounded"
                  >
                    {`${matchCount} matching ${matchCount === 1 ? 'resource' : 'resources'}`}
                  </button>
                )}
              </p>
              <button
                type="button" onClick={() => setFilters([])}
                className="shrink-0 underline underline-offset-2 hover:opacity-75"
              >
                Clear all
              </button>
            </div>
            <p className={`text-[10px] leading-relaxed ${light ? 'text-gray-500' : 'text-slate-400'}`}>
              All tags must match the same resource. Assessment and snapshot data include the full topology.
            </p>
          </div>
        )}
      </div>
    </ViewOptionsSection>
  );
}
