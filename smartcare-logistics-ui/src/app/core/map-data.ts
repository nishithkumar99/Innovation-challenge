import { StationKind, Vec } from './models';

/** Static floor-plan asset. In production this is fetched per site/floor from the map service. */
export const WORLD = { w: 100, h: 62 };

export interface MapNode { id: string; name: string; pos: Vec; kind?: StationKind; }
export interface MapEdge { id: string; a: string; b: string; }

export const MAP_NODES: MapNode[] = [
  { id: 'J1', name: 'Junction 1', pos: { x: 30, y: 30 } },
  { id: 'J2', name: 'Junction 2', pos: { x: 50, y: 30 } },
  { id: 'J3', name: 'Junction 3', pos: { x: 70, y: 30 } },
  { id: 'T1', name: 'North 1', pos: { x: 30, y: 12 } },
  { id: 'T2', name: 'North 2', pos: { x: 70, y: 12 } },
  { id: 'B1', name: 'South 1', pos: { x: 30, y: 48 } },
  { id: 'B3', name: 'South 3', pos: { x: 70, y: 48 } },
  { id: 'PH', name: 'Pharmacy', pos: { x: 10, y: 12 }, kind: 'PHARMACY' },
  { id: 'LAB', name: 'Laboratory', pos: { x: 50, y: 12 }, kind: 'LAB' },
  { id: 'OR', name: 'Operating Room', pos: { x: 92, y: 12 }, kind: 'OR' },
  { id: 'CSSD', name: 'Sterile Services', pos: { x: 10, y: 48 }, kind: 'CSSD' },
  { id: 'WD', name: 'Ward D', pos: { x: 8, y: 30 }, kind: 'WARD' },
  { id: 'WA', name: 'Ward A', pos: { x: 92, y: 30 }, kind: 'WARD' },
  { id: 'WB', name: 'Ward B', pos: { x: 92, y: 48 }, kind: 'WARD' },
  { id: 'WC', name: 'Ward C', pos: { x: 50, y: 48 }, kind: 'WARD' },
  { id: 'CHG', name: 'Charging Dock', pos: { x: 50, y: 58 }, kind: 'CHARGING' },
];

const pairs: [string, string][] = [
  ['WD', 'J1'], ['J1', 'J2'], ['J2', 'J3'], ['J3', 'WA'],
  ['J1', 'T1'], ['J3', 'T2'], ['T1', 'LAB'], ['LAB', 'T2'], ['J2', 'LAB'],
  ['PH', 'T1'], ['T2', 'OR'],
  ['J1', 'B1'], ['J2', 'WC'], ['J3', 'B3'], ['B1', 'WC'], ['WC', 'B3'],
  ['B1', 'CSSD'], ['B3', 'WB'], ['WC', 'CHG'],
];
export const MAP_EDGES: MapEdge[] = pairs.map(([a, b]) => ({ id: `${a}-${b}`, a, b }));

export const NODE_BY_ID: Record<string, MapNode> = Object.fromEntries(MAP_NODES.map((n) => [n.id, n]));
export const STATION_NODES = MAP_NODES.filter((n) => !!n.kind);
export const DESTINATION_NODES = STATION_NODES.filter((n) => n.kind !== 'CHARGING');
export const WARD_IDS = ['WA', 'WB', 'WC', 'WD'];

export const KIND_COLOR: Record<StationKind, string> = {
  PHARMACY: '#4f9cf9', LAB: '#b07cf5', CSSD: '#2fc4b2', WARD: '#8aa0b8', OR: '#f0a35e', CHARGING: '#7d8da1',
};

export function stationName(id: string | null | undefined): string {
  return id ? NODE_BY_ID[id]?.name ?? id : '—';
}
