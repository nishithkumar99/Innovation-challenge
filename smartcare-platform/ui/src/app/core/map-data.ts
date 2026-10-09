import { StationKind, Vec } from './models';
import { SIM_ROUTE_NODES, SimRouteNode } from './sim-route-nodes';

/**
 * The navigation map. Single source of truth is the simulator's route_nodes.json, loaded by the Java core and served
 * at GET /api/fleet/map. In demo mode (no core) the bundled copy of the same file is used.
 * The exports are live bindings: `installMap()` replaces them once, before the application modules are evaluated (see main.ts).
 */
export interface MapNode { id: string; name: string; pos: Vec; kind?: StationKind; }
export interface MapEdge { id: string; a: string; b: string; }
/** Shape of GET /api/fleet/map. */
export interface MapSpec {
  mapId: string; width: number; height: number; background: string | null;
  nodes: { id: string; name: string; x: number; y: number; kind: string; capacity?: number }[];
  edges: { id: string; a: string; b: string; length?: number }[];
}

/** "Charging_Station1_Hallway" → "Charging Station 1" (same rule as the Java core). */
export function prettyName(id: string): string {
  return id.replace('_Hallway', '').replace(/_/g, ' ').replace(/([A-Za-z])(\d)/g, '$1 $2');
}

/** Station kind from the simulator's naming convention (same rule as the Java core). */
export function kindOf(id: string, charging = false): StationKind | 'JUNCTION' {
  const s = id.toLowerCase();
  if (charging || s.startsWith('charging')) return 'CHARGING';
  if (s.startsWith('or_') || s === 'or') return 'OR';
  if (s.startsWith('pharmacy')) return 'PHARMACY';
  if (s.startsWith('ward')) return 'WARD';
  if (s.startsWith('storage')) return 'STORAGE';
  if (s.startsWith('kitchen')) return 'KITCHEN';
  if (s.startsWith('laundry')) return 'LAUNDRY';
  if (s.startsWith('waste')) return 'WASTE';
  if (s.startsWith('check')) return 'CHECKIN';
  if (s.startsWith('lab')) return 'LAB';
  if (s.startsWith('cssd')) return 'CSSD';
  return 'JUNCTION';
}

/** Builds a MapSpec from the simulator's route_nodes format. An edge exists when both nodes list each other. */
export function buildMapSpec(routeNodes: SimRouteNode[], width = 65, height = 40, mapId = 'webots', background: string | null = 'floorplan.png'): MapSpec {
  const nb = new Map(routeNodes.map((n) => [n.node_id, new Set(n.neghbour_nodes)]));
  const edges: MapSpec['edges'] = [];
  const seen = new Set<string>();
  const byId = new Map(routeNodes.map((n) => [n.node_id, n]));
  for (const n of routeNodes) {
    for (const o of nb.get(n.node_id) ?? []) {
      const other = byId.get(o);
      if (!other || o === n.node_id || !nb.get(o)?.has(n.node_id) || seen.has(`${n.node_id}|${o}`)) continue;
      seen.add(`${n.node_id}|${o}`); seen.add(`${o}|${n.node_id}`);
      edges.push({ id: `${n.node_id}-${o}`, a: n.node_id, b: o, length: Math.hypot(n.x - other.x, n.y - other.y) });
    }
  }
  return {
    mapId, width, height, background,
    nodes: routeNodes.map((n) => ({ id: n.node_id, name: prettyName(n.node_id), x: n.x, y: n.y, kind: kindOf(n.node_id, n.charging_station) })),
    edges,
  };
}

export const BUNDLED_MAP: MapSpec = buildMapSpec(SIM_ROUTE_NODES);

export let WORLD = { w: 65, h: 40 };
/** Floorplan image drawn behind the map (served by the UI itself); null = none. */
export let MAP_BACKGROUND: string | null = null;
export let MAP_ID = 'webots';
export let MAP_NODES: MapNode[] = [];
export let MAP_EDGES: MapEdge[] = [];
export let NODE_BY_ID: Record<string, MapNode> = {};
export let STATION_NODES: MapNode[] = [];
export let DESTINATION_NODES: MapNode[] = [];
export let WARD_IDS: string[] = [];

export function installMap(spec: MapSpec): void {
  WORLD = { w: spec.width, h: spec.height };
  MAP_BACKGROUND = spec.background;
  MAP_ID = spec.mapId;
  MAP_NODES = spec.nodes.map((n) => ({ id: n.id, name: n.name, pos: { x: n.x, y: n.y }, kind: n.kind === 'JUNCTION' ? undefined : (n.kind as StationKind) }));
  MAP_EDGES = spec.edges.map((e) => ({ id: e.id, a: e.a, b: e.b }));
  NODE_BY_ID = Object.fromEntries(MAP_NODES.map((n) => [n.id, n]));
  STATION_NODES = MAP_NODES.filter((n) => !!n.kind);
  DESTINATION_NODES = STATION_NODES.filter((n) => n.kind !== 'CHARGING');
  WARD_IDS = MAP_NODES.filter((n) => n.kind === 'WARD').map((n) => n.id);
}
installMap(BUNDLED_MAP);

/** Stations of one kind, in map order. */
export const idsOfKind = (...kinds: StationKind[]): string[] => MAP_NODES.filter((n) => n.kind && kinds.includes(n.kind)).map((n) => n.id);

export const KIND_COLOR: Record<StationKind, string> = {
  PHARMACY: '#4f9cf9', LAB: '#b07cf5', CSSD: '#2fc4b2', WARD: '#8aa0b8', OR: '#f0a35e', CHARGING: '#7d8da1',
  STORAGE: '#c9a227', KITCHEN: '#e0707a', LAUNDRY: '#5bb8e8', WASTE: '#9a8f7a', CHECKIN: '#7ac27a',
};

export function stationName(id: string | null | undefined): string {
  return id ? NODE_BY_ID[id]?.name ?? id : '—';
}

/** Real-core mode: replace the bundled map by the core's map. Silent fallback to the bundled copy when it cannot be loaded. */
export async function loadRuntimeMap(apiBase: string): Promise<void> {
  try {
    const res = await fetch(`${apiBase}/fleet/map`, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(String(res.status));
    const spec = (await res.json()) as MapSpec;
    if (Array.isArray(spec.nodes) && spec.nodes.length && Array.isArray(spec.edges)) installMap(spec);
  } catch (e) {
    console.warn('Could not load /fleet/map from the core, using the bundled simulator map.', e);
  }
}
