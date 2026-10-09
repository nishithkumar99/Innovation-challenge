from datetime import datetime, timedelta, timezone

import utils
from protocol.vda_2_0_0.vda5050_2_0_0_action import BlockingType
from protocol.vda_2_0_0.vda5050_2_0_0_state import ActionStatus

SIMULATION_TICK_SECONDS = 0.05


class SimulatorMovementMixin:
    def _update_charging_state(self) -> bool:
        battery_state = self.state.battery_state
        if (
            self.state.last_node_id not in self.charging_station_node_ids
            or battery_state.battery_health == 0
            or battery_state.battery_charge >= 100.0
            or self.config.settings.battery_charging_rate_per_second <= 0
        ):
            battery_state.charging = False
            return False

        battery_state.charging = True
        battery_state.battery_charge = min(
            100.0,
            battery_state.battery_charge
            + self.config.settings.battery_charging_rate_per_second * SIMULATION_TICK_SECONDS,
        )
        self._update_battery_reach()
        if battery_state.battery_charge >= 100.0:
            battery_state.charging = False
        return True

    def state_iterate(self) -> None:
        """Advance action timers, route state, position, and battery for one tick."""
        self.state.driving = False
        self.state.safety_state.field_violation = False
        is_action_running = False

        if self.action_start_time is not None:
            current_time = datetime.now(timezone.utc)
            action_end_time = self.action_start_time + timedelta(
                seconds=(
                    self.action_duration
                    if self.action_duration is not None
                    else self.config.settings.action_time
                )
            )
            running_action_state = next(
                (state for state in self.state.action_states if state.action_status == ActionStatus.RUNNING),
                None,
            )
            if running_action_state:
                if current_time < action_end_time:
                    is_action_running = True
                    print(
                        f"DEBUG ({self.config.vehicle.serial_number}): Action "
                        f"{running_action_state.action_id} still running... remaining: "
                        f"{action_end_time - current_time}"
                    )
                else:
                    print(
                        f"SIM ({self.config.vehicle.serial_number}): Finished timed action ID "
                        f"{running_action_state.action_id}, Type: {running_action_state.action_type}"
                    )
                    running_action_state.action_status = ActionStatus.FINISHED
                    self.action_start_time = None
                    self.action_duration = None

        if self.instant_actions is not None:
            current_instant_actions = self.instant_actions.instant_actions
            self.instant_actions = None
            for action in current_instant_actions:
                action_started = self.run_action(action)
                if action_started and self.action_start_time is not None:
                    is_action_running = True
                    break

        if self.order is None:
            self._update_charging_state()
            return

        can_move = not any(
            action_state.action_status == ActionStatus.RUNNING
            for action_state in self.state.action_states
        )
        if not can_move:
            return

        actions_at_current_node = next(
            (
                node.actions for node in self.order.nodes
                if node.sequence_id == self.state.last_node_sequence_id
            ),
            [],
        )
        action_started_this_tick = False
        for action in actions_at_current_node:
            action_state_waiting = any(
                state.action_id == action.action_id and state.action_status == ActionStatus.WAITING
                for state in self.state.action_states
            )
            if action_state_waiting and self.run_action(action):
                action_started_this_tick = True
                if action.blocking_type == BlockingType.HARD:
                    print(
                        f"DEBUG ({self.config.vehicle.serial_number}): HARD blocking action "
                        f"{action.action_id} started at node {self.state.last_node_id}. Halting iteration."
                    )
                    return
        if action_started_this_tick:
            return

        if self._update_charging_state():
            return

        if self.state.agv_position is None:
            print(f"DEBUG ({self.config.vehicle.serial_number}): No AGV position, cannot move.")
            return

        if (
            len(self.state.node_states) == 1
            and self.state.node_states[0].sequence_id == self.state.last_node_sequence_id
        ):
            current_node_actions = next(
                (
                    node.actions for node in self.order.nodes
                    if node.sequence_id == self.state.last_node_sequence_id
                ),
                [],
            )
            all_actions_done = all(
                any(
                    state.action_id == action.action_id
                    and state.action_status == ActionStatus.FINISHED
                    for state in self.state.action_states
                )
                for action in current_node_actions
            )
            if all_actions_done:
                print(f"SIM ({self.config.vehicle.serial_number}): Order {self.state.order_id} completed.")
                self.state.node_states.clear()
                self.state.edge_states.clear()
                self.state.action_states.clear()
                self.order = None
            return

        if not self.state.node_states:
            return

        last_node_index = next(
            (
                index for index, node_state in enumerate(self.state.node_states)
                if node_state.sequence_id == self.state.last_node_sequence_id
            ),
            None,
        )
        if last_node_index is None or last_node_index >= len(self.state.node_states) - 1:
            return

        next_node_state = self.state.node_states[last_node_index + 1]
        if next_node_state.node_position is None:
            print(f"DEBUG ({self.config.vehicle.serial_number}): Next node {next_node_state.node_id} has no position!")
            return

        vehicle_position = self.state.agv_position
        target_position = next_node_state.node_position
        distance_to_next_node = utils.get_distance(
            vehicle_position.x,
            vehicle_position.y,
            target_position.x,
            target_position.y,
        )
        arrival_threshold = self.config.settings.speed * 0.5 + 0.05

        if distance_to_next_node < arrival_threshold:
            if not self._position_is_clear(
                target_position.x,
                target_position.y,
                vehicle_position.map_id,
                start=(vehicle_position.x, vehicle_position.y),
            ):
                self.state.safety_state.field_violation = True
                return
            print(
                f"SIM ({self.config.vehicle.serial_number}): Arrived at node "
                f"{next_node_state.node_id} (Seq: {next_node_state.sequence_id})"
            )
            vehicle_position.x = target_position.x
            vehicle_position.y = target_position.y
            self.state.node_states.pop(last_node_index)
            self.state.last_node_id = next_node_state.node_id
            self.state.last_node_sequence_id = next_node_state.sequence_id

            traversed_edge_sequence_id = next_node_state.sequence_id - 1
            edge_index = next(
                (
                    index for index, edge in enumerate(self.state.edge_states)
                    if edge.sequence_id == traversed_edge_sequence_id
                ),
                None,
            )
            if edge_index is not None:
                self.state.edge_states.pop(edge_index)
            self.visualization.agv_position = vehicle_position
            return

        if (
            self.state.battery_state.battery_charge <= 0
            or self.state.battery_state.battery_health == 0
        ):
            return

        updated_position = utils.iterate_position(
            vehicle_position.x,
            vehicle_position.y,
            target_position.x,
            target_position.y,
            self.config.settings.speed,
        )
        if not self._position_is_clear(
            updated_position[0],
            updated_position[1],
            vehicle_position.map_id,
            start=(vehicle_position.x, vehicle_position.y),
        ):
            self.state.safety_state.field_violation = True
            return
        distance_traveled = utils.get_distance(
            vehicle_position.x,
            vehicle_position.y,
            updated_position[0],
            updated_position[1],
        )
        consumption = distance_traveled * self._battery_consumption_rate()
        battery_state = self.state.battery_state
        battery_state.battery_charge = max(0.0, battery_state.battery_charge - consumption)
        self._update_battery_reach()

        self.state.driving = True
        vehicle_position.x = updated_position[0]
        vehicle_position.y = updated_position[1]
        vehicle_position.theta = updated_position[2]
        self.visualization.agv_position = vehicle_position
