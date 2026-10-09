// Copy of the simulator's route_nodes.json (organizers' VDA 5050 simulator). Used when the UI runs without the Java core
// (demo mode) or when GET /api/fleet/map cannot be reached. With the real core the map always comes from the core.
export interface SimRouteNode { node_id: string; x: number; y: number; charging_station?: boolean; neghbour_nodes: string[]; }
export const SIM_ROUTE_NODES: SimRouteNode[] = [
  { node_id: 'OR_1_Hallway', x: 15.0, y: 21.5, neghbour_nodes: ['Waypoint_Hallway_Northwest', 'Waypoint_Hallway_Southwest', 'OR_2_Hallway'] },
  { node_id: 'OR_2_Hallway', x: 15.0, y: 18.0, neghbour_nodes: ['Waypoint_Hallway_Northwest', 'Waypoint_Hallway_Southwest', 'OR_1_Hallway'] },
  { node_id: 'Pharmacy_Hallway', x: 19.7, y: 27.2, neghbour_nodes: ['Waypoint_Hallway_Northwest', 'Waypoint_Hallway_North', 'Ward1_Hallway'] },
  { node_id: 'Ward1_Hallway', x: 26.0, y: 28.0, neghbour_nodes: ['Waypoint_Hallway_Northwest', 'Waypoint_Hallway_North', 'Pharmacy_Hallway'] },
  { node_id: 'Ward2_Hallway', x: 26.0, y: 11.0, neghbour_nodes: ['Waypoint_Hallway_Southwest', 'Waypoint_Hallway_South'] },
  { node_id: 'Storage_Hallway_North', x: 44.3, y: 27.2, neghbour_nodes: ['Waypoint_Hallway_North', 'Waypoint_Hallway_Northeast'] },
  { node_id: 'Storage_Hallway_South', x: 44.3, y: 12.1, neghbour_nodes: ['Waypoint_Hallway_South', 'Waypoint_Hallway_Southeast'] },
  { node_id: 'Kitchen_Hallway_North', x: 54.3, y: 27.0, neghbour_nodes: ['Waypoint_Hallway_Northeast', 'Waste_Hallway'] },
  { node_id: 'Kitchen_Hallway_West', x: 49.0, y: 21.0, neghbour_nodes: ['Waypoint_Hallway_Northeast', 'Waypoint_Hallway_Southeast', 'Laundry_Hallway_West'] },
  { node_id: 'Laundry_Hallway_West', x: 49.0, y: 18.0, neghbour_nodes: ['Waypoint_Hallway_Northeast', 'Waypoint_Hallway_Southeast', 'Kitchen_Hallway_West'] },
  { node_id: 'Laundry_Hallway_South', x: 54.3, y: 12.1, neghbour_nodes: ['Check-In_Hallway', 'Waypoint_Hallway_Southeast'] },
  { node_id: 'Waste_Hallway', x: 54.0, y: 29.0, neghbour_nodes: ['Waypoint_Hallway_Northeast', 'Kitchen_Hallway_North'] },
  { node_id: 'Check-In_Hallway', x: 55.5, y: 10.0, neghbour_nodes: ['Waypoint_Hallway_Southeast', 'Laundry_Hallway_South'] },
  { node_id: 'Charging_Station1_Hallway', x: 33.0, y: 21.5, charging_station: true, neghbour_nodes: ['Waypoint_Hallway_North', 'Waypoint_Hallway_South', 'Charging_Station2_Hallway', 'Charging_Station3_Hallway', 'Charging_Station4_Hallway'] },
  { node_id: 'Charging_Station2_Hallway', x: 31.0, y: 21.5, charging_station: true, neghbour_nodes: ['Waypoint_Hallway_North', 'Waypoint_Hallway_South', 'Charging_Station1_Hallway', 'Charging_Station3_Hallway', 'Charging_Station4_Hallway'] },
  { node_id: 'Charging_Station3_Hallway', x: 31.0, y: 18.0, charging_station: true, neghbour_nodes: ['Waypoint_Hallway_North', 'Waypoint_Hallway_South', 'Charging_Station2_Hallway', 'Charging_Station1_Hallway', 'Charging_Station4_Hallway'] },
  { node_id: 'Charging_Station4_Hallway', x: 33.0, y: 18.0, charging_station: true, neghbour_nodes: ['Waypoint_Hallway_North', 'Waypoint_Hallway_South', 'Charging_Station2_Hallway', 'Charging_Station3_Hallway', 'Charging_Station1_Hallway'] },
  { node_id: 'Waypoint_Hallway_Northwest', x: 16.0, y: 28.0, neghbour_nodes: ['Waypoint_Hallway_North', 'Waypoint_Hallway_Southwest', 'OR_1_Hallway', 'OR_2_Hallway', 'Ward1_Hallway', 'Pharmacy_Hallway'] },
  { node_id: 'Waypoint_Hallway_North', x: 32.0, y: 28.0, neghbour_nodes: ['Waypoint_Hallway_Northwest', 'Waypoint_Hallway_Northeast', 'Waypoint_Hallway_South', 'Pharmacy_Hallway', 'Ward1_Hallway', 'Storage_Hallway_North', 'Charging_Station1_Hallway', 'Charging_Station2_Hallway', 'Charging_Station3_Hallway', 'Charging_Station4_Hallway'] },
  { node_id: 'Waypoint_Hallway_Northeast', x: 48.0, y: 28.0, neghbour_nodes: ['Waypoint_Hallway_North', 'Waypoint_Hallway_Southeast', 'Waste_Hallway', 'Kitchen_Hallway_West', 'Kitchen_Hallway_North', 'Storage_Hallway_North', 'Laundry_Hallway_West'] },
  { node_id: 'Waypoint_Hallway_Southwest', x: 16.0, y: 11.0, neghbour_nodes: ['Waypoint_Hallway_South', 'Waypoint_Hallway_Northwest', 'OR_1_Hallway', 'OR_2_Hallway', 'Ward2_Hallway'] },
  { node_id: 'Waypoint_Hallway_South', x: 32.0, y: 11.0, neghbour_nodes: ['Waypoint_Hallway_Southwest', 'Waypoint_Hallway_Southeast', 'Waypoint_Hallway_North', 'Ward2_Hallway', 'Storage_Hallway_South', 'Charging_Station1_Hallway', 'Charging_Station2_Hallway', 'Charging_Station3_Hallway', 'Charging_Station4_Hallway'] },
  { node_id: 'Waypoint_Hallway_Southeast', x: 48.0, y: 11.0, neghbour_nodes: ['Waypoint_Hallway_South', 'Waypoint_Hallway_Northeast', 'Check-In_Hallway', 'Storage_Hallway_South', 'Laundry_Hallway_South', 'Laundry_Hallway_West', 'Kitchen_Hallway_West'] },
];
