from datetime import datetime, timezone

from protocol.vda5050_common import AgvPosition
from protocol.vda_2_0_0.vda5050_2_0_0_action import Action, BlockingType
from protocol.vda_2_0_0.vda5050_2_0_0_state import ActionStatus


class SimulatorActionsMixin:
    def run_action(self, action: Action) -> bool:
        """Execute an action and report whether it was handled."""
        action_state_index = None
        for index, action_state in enumerate(self.state.action_states):
            if action_state.action_id == action.action_id:
                if action_state.action_status == ActionStatus.WAITING:
                    action_state_index = index
                else:
                    return False
                break

        if action_state_index is None:
            return False

        action_state = self.state.action_states[action_state_index]
        action_state.action_status = ActionStatus.RUNNING
        print(
            f"SIM ({self.config.vehicle.serial_number}): Running action ID "
            f"{action.action_id}, Type: {action.action_type}"
        )

        if action.action_type == "initPosition":
            parameters = {parameter.key: parameter.value.value for parameter in action.action_parameters}
            position = AgvPosition(
                x=float(parameters.get("x", 0.0)),
                y=float(parameters.get("y", 0.0)),
                position_initialized=True,
                theta=float(parameters.get("theta", 0.0)),
                map_id=str(parameters.get("mapId", "")),
                deviation_range=None,
                map_description=None,
                localization_score=None,
            )
            if not self._position_is_clear(position.x, position.y, position.map_id):
                action_state.action_status = ActionStatus.FAILED
                action_state.result_description = "Requested position overlaps another AMR or is invalid"
                return True
            self.state.agv_position = position
            self.visualization.agv_position = self.state.agv_position
            action_state.action_status = ActionStatus.FINISHED
            print(
                f"SIM ({self.config.vehicle.serial_number}): Finished action ID "
                f"{action.action_id}, Type: {action.action_type}"
            )
            return True

        if action.action_type in ("drop", "pick"):
            self.action_start_time = datetime.now(timezone.utc)
            self.action_duration = self.config.settings.action_time
            if action.action_type == "drop":
                print(f"SIM ({self.config.vehicle.serial_number}): Starting dropOff action ID {action.action_id}")
            return True

        if action.action_type == "wait":
            duration = self.config.settings.action_time
            for parameter in action.action_parameters:
                if parameter.key == "duration":
                    try:
                        duration = float(parameter.value.value)
                    except (ValueError, TypeError):
                        pass
                    break
            print(
                f"SIM ({self.config.vehicle.serial_number}): Starting wait action ID "
                f"{action.action_id}, duration={duration}s"
            )
            self.action_start_time = datetime.now(timezone.utc)
            self.action_duration = duration
            return True

        if action.action_type == "cancelOrder":
            self.cancel_order()
            action_state.action_status = ActionStatus.FINISHED
            print(
                f"SIM ({self.config.vehicle.serial_number}): Finished action ID "
                f"{action.action_id}, Type: {action.action_type}"
            )
            return True

        print(
            f"SIM ({self.config.vehicle.serial_number}): Unknown action type "
            f"'{action.action_type}'. Marking as finished."
        )
        action_state.action_status = ActionStatus.FINISHED
        return True

    def cancel_order(self) -> None:
        """Stop the vehicle and clear its active order."""
        print(f"SIM ({self.config.vehicle.serial_number}): Cancelling order {self.state.order_id}")
        for action_state in self.state.action_states:
            if (
                action_state.action_type != "cancelOrder"
                and action_state.action_status in (
                    ActionStatus.WAITING,
                    ActionStatus.RUNNING,
                    ActionStatus.INITIALIZING,
                    ActionStatus.PAUSED,
                )
            ):
                action_state.action_status = ActionStatus.FAILED

        self.order = None
        self.action_start_time = None
        self.action_duration = None
        self.state.node_states.clear()
        self.state.edge_states.clear()
        self.state.driving = False

    def instant_actions_accept_procedure(self, instant_action_request) -> None:
        """Accept instant actions and initialize their action states."""
        self.instant_actions = instant_action_request
        for instant_action in self.instant_actions.instant_actions:
            self.state.action_states.append(self._create_action_state(instant_action))

    def _create_action_state(self, action):
        from protocol.vda_2_0_0.vda5050_2_0_0_state import ActionState

        return ActionState(
            action_id=action.action_id,
            action_status=ActionStatus.WAITING,
            action_type=action.action_type,
            action_description=None,
            result_description=None,
        )
