import json
import os


def load_route_nodes():
    """Load route nodes from the project directory."""
    base_dir = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(base_dir, "route_nodes.json"), "r", encoding="utf-8") as route_file:
        nodes = json.load(route_file)

    return nodes


def load_route_definition():
    """Load Commander route nodes and edges from the project directory."""
    base_dir = os.path.dirname(os.path.abspath(__file__))
    nodes = load_route_nodes()
    with open(os.path.join(base_dir, "route_edges.json"), "r", encoding="utf-8") as route_file:
        edges = json.load(route_file)
    return nodes, edges


def get_nodes_in_edge_order(nodes, edges):
    """Return node occurrences in the continuous route described by edges."""
    if not edges:
        return list(nodes)

    nodes_by_id = {node["node_id"]: node for node in nodes}
    ordered_nodes = []
    for edge in edges:
        start_node_id = edge["start_node_id"]
        end_node_id = edge["end_node_id"]
        if start_node_id not in nodes_by_id or end_node_id not in nodes_by_id:
            raise ValueError(f"Edge '{edge['edge_id']}' references an undefined node")
        if ordered_nodes and ordered_nodes[-1]["node_id"] != start_node_id:
            raise ValueError(f"Edge '{edge['edge_id']}' does not continue the preceding route")
        if not ordered_nodes:
            ordered_nodes.append(nodes_by_id[start_node_id])
        ordered_nodes.append(nodes_by_id[end_node_id])

    return ordered_nodes
