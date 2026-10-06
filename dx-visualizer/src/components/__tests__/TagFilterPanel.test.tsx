// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { TagFilterPanel } from '../TagFilterPanel';
import { useTopologyStore } from '../../store/topology-store';
import { makeTaggedTopology } from '../../engine/__tests__/fixtures/tagged-topology';

beforeEach(() => {
  useTopologyStore.setState(useTopologyStore.getInitialState(), true);
  useTopologyStore.setState({ topologyData: makeTaggedTopology(), tagFilters: [], redactMode: false });
});
afterEach(cleanup);

function pickOption(label: string, option: string) {
  fireEvent.click(screen.getByRole('combobox', { name: label }));
  fireEvent.click(screen.getByRole('option', { name: option }));
}

function addFilter(key: string, value: string | null) {
  pickOption('Tag key', key);
  pickOption('Tag value', value === null ? 'Any value' : value || '(empty)');
  fireEvent.click(screen.getByRole('button', { name: 'Add filter' }));
}

describe('TagFilterPanel', () => {
  it('supports adding, combining, removing and clearing filters', () => {
    render(<TagFilterPanel />);
    expect((screen.getByRole('button', { name: 'Add filter' }) as HTMLButtonElement).disabled).toBe(true);
    addFilter('Environment', 'prod');
    expect(useTopologyStore.getState().tagFilters).toEqual([{ key: 'Environment', value: 'prod' }]);
    expect(screen.getByRole('status').textContent).toBe('1 matching resource');
    fireEvent.click(screen.getByRole('combobox', { name: 'Tag key' }));
    expect(within(screen.getByRole('listbox')).queryByRole('option', { name: 'Environment' })).toBeNull();
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Tag key' }), { key: 'Escape' });

    addFilter('Team', 'support');
    expect(screen.getByRole('status').textContent).toBe('No matching resources');
    fireEvent.click(screen.getByRole('button', { name: 'Remove tag filter Team' }));
    expect(screen.getByRole('status').textContent).toBe('1 matching resource');
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(useTopologyStore.getState().tagFilters).toEqual([]);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('zooms to the matches when the count is clicked', () => {
    render(<TagFilterPanel />);
    addFilter('Environment', 'prod');
    expect(useTopologyStore.getState().tagFitRequest).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: '1 matching resource' }));
    expect(useTopologyStore.getState().tagFitRequest).toBe(1);
  });

  it('keeps the active count visible when collapsed', () => {
    render(<TagFilterPanel />);
    addFilter('Environment', 'prod');
    fireEvent.click(screen.getByRole('button', { name: 'Toggle AWS tag filters' }));
    expect(screen.getByText('1 active')).toBeTruthy();
    expect(screen.queryByLabelText('Tag key')).toBeNull();
    expect(screen.getByRole('button', { name: 'Toggle AWS tag filters' }).getAttribute('aria-expanded')).toBe('false');
  });

  it('distinguishes Any value from an empty tag value', () => {
    render(<TagFilterPanel />);
    addFilter('Environment', null);
    expect(useTopologyStore.getState().tagFilters[0].value).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('3 matching resources');
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    addFilter('Empty', '');
    expect(useTopologyStore.getState().tagFilters).toEqual([{ key: 'Empty', value: '' }]);
    expect(screen.getByRole('status').textContent).toBe('1 matching resource');
  });

  it('can clear a stale filter after refreshed data has no tags', () => {
    render(<TagFilterPanel />);
    addFilter('Environment', 'prod');
    const topology = makeTaggedTopology();
    for (const list of Object.values(topology)) {
      if (Array.isArray(list)) {
        for (const resource of list) {
          if (resource && typeof resource === 'object' && 'tags' in resource) resource.tags = {};
        }
      }
    }
    act(() => useTopologyStore.getState().setTopologyData(topology));
    expect(screen.getByText(/No AWS tags were loaded/)).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('No matching resources');
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(useTopologyStore.getState().tagFilters).toEqual([]);
  });

  it('does not show a filter before topology is loaded', () => {
    useTopologyStore.setState({ topologyData: null });
    expect(render(<TagFilterPanel />).container.firstChild).toBeNull();
  });

  it('supports keyboard selection, typeahead and dismissing without changing the selection', () => {
    render(<TagFilterPanel />);
    const key = screen.getByRole('combobox', { name: 'Tag key' });
    const value = screen.getByRole('combobox', { name: 'Tag value' });
    expect((value as HTMLButtonElement).disabled).toBe(true);
    key.focus();
    fireEvent.keyDown(key, { key: 'E' });
    fireEvent.keyDown(key, { key: 'n' });
    expect(screen.getByRole('option', { selected: true }).textContent).toBe('Environment');
    fireEvent.keyDown(key, { key: 'Enter' });
    expect(key.textContent).toBe('Environment');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.activeElement).toBe(key);
    expect((value as HTMLButtonElement).disabled).toBe(false);

    value.focus();
    fireEvent.keyDown(value, { key: 'ArrowDown' });
    fireEvent.keyDown(value, { key: 'End' });
    fireEvent.keyDown(value, { key: 'Escape' });
    expect(value.textContent).toBe('Any value');
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.keyDown(value, { key: 'ArrowDown' });
    fireEvent.keyDown(value, { key: 'ArrowDown' });
    fireEvent.keyDown(value, { key: 'Tab' });
    expect(value.textContent).toBe('prod');
    fireEvent.click(screen.getByRole('button', { name: 'Add filter' }));
    expect(useTopologyStore.getState().tagFilters).toEqual([{ key: 'Environment', value: 'prod' }]);
  });

  it('closes the popover on an outside click or panel collapse', () => {
    render(<TagFilterPanel />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Tag key' }));
    expect(screen.getByRole('listbox')).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.click(screen.getByRole('combobox', { name: 'Tag key' }));
    fireEvent.click(screen.getByRole('button', { name: 'Toggle AWS tag filters' }));
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});
