from protocol.vda5050_common import NodePosition
from protocol.vda_2_0_0.vda5050_2_0_0_order import Order
from protocol.vda_2_0_0.vda5050_2_0_0_state import ActionState, ActionStatus, EdgeState, NodeState


class SimulatorOrdersMixin:
    def order_accept_procedure(self, order_request: Order) -> None:
        """Validate an incoming order or update before accepting it."""
        if order_request.order_id != self.state.order_id:
            if self.state.order_id == "":
                self.order_accept(order_request)
                return
            if len(self.state.node_states) == 0 and len(self.state.edge_states) == 0:
                self.state.action_states = []
                self.order_accept(order_request)
                return
            self.order_reject("There is order_state or edge_state in state")
            return

        if order_request.order_update_id > self.state.order_update_id:
            if len(self.state.node_states) > 0 and len(self.state.edge_states) == 0:
                self.state.action_states = []
                self.order_accept(order_request)
                return
            self.order_reject("There is order_state or edge_state in state1")
            return

        self.order_reject("Order update id is lower")

    def order_accept(self, order_request: Order) -> None:
        """Resolve node positions and initialize state for an accepted order."""
        missing_positions = [node for node in order_request.nodes if node.node_position is None]
        unknown_node_ids = [
            node.node_id for node in missing_positions
            if node.node_id not in self.route_node_positions
        ]
        if unknown_node_ids:
            self.order_reject(
                "nodePosition is missing and node IDs are not defined in route_nodes.json: "
                + ", ".join(unknown_node_ids)
            )
            return

        for node in missing_positions:
            x, y = self.route_node_positions[node.node_id]
            node.node_position = NodePosition(x=x, y=y, map_id=self.config.settings.map_id)

        self.order = order_request
        first_node = min(self.order.nodes, key=lambda node: node.sequence_id, default=None)
        if first_node:
            self.state.last_node_id = first_node.node_id
            self.state.last_node_sequence_id = first_node.sequence_id
            print(
                f"SIMULATOR ({self.config.vehicle.serial_number}): Initializing state to first node: "
                f"ID={self.state.last_node_id}, Seq={self.state.last_node_sequence_id}"
            )
        else:
            self.state.last_node_id = ""
            self.state.last_node_sequence_id = 0
            print(f"SIMULATOR ({self.config.vehicle.serial_number}): Warning - Accepted order has no nodes.")

        self.state.order_id = self.order.order_id
        self.state.order_update_id = self.order.order_update_id
        self.state.action_states = []
        self.state.node_states = []
        self.state.edge_states = []

        for node in self.order.nodes:
            self.state.node_states.append(NodeState(
                node_id=node.node_id,
                sequence_id=node.sequence_id,
                released=node.released,
                node_description=node.node_description,
                node_position=node.node_position,
            ))
            for action in node.actions:
                self.state.action_states.append(ActionState(
                    action_id=action.action_id,
                    action_type=action.action_type,
                    action_description=action.action_description,
                    action_status=ActionStatus.WAITING,
                    result_description=None,
                ))

        for edge in self.order.edges:
            self.state.edge_states.append(EdgeState(
                edge_id=edge.edge_id,
                sequence_id=edge.sequence_id,
                released=edge.released,
                start_node_id=edge.start_node_id,
                end_node_id=edge.end_node_id,
                edge_description=edge.edge_description,
                trajectory=None,
            ))
            for action in edge.actions:
                self.state.action_states.append(ActionState(
                    action_id=action.action_id,
                    action_type=action.action_type,
                    action_description=action.action_description,
                    action_status=ActionStatus.WAITING,
                    result_description=None,
                ))

    def order_reject(self, reason: str) -> None:
        """Report why an order was not accepted."""
        print(f"Order reject: {reason}")
