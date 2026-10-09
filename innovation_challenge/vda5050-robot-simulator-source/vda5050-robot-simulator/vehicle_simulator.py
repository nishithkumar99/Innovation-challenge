import json
import math

import paho.mqtt.client as mqtt

import config
import mqtt_utils
import utils
from protocol.vda5050_common import AgvPosition, NodePosition
from protocol.vda_2_0_0.vda5050_2_0_0_connection import Connection, ConnectionState
from protocol.vda_2_0_0.vda5050_2_0_0_state import (
    BatteryState,
    EStop,
    OperatingMode,
    SafetyState,
    State,
)
from protocol.vda_2_0_0.vda5050_2_0_0_visualization import Visualization
from route_utils import load_route_nodes
from simulator_actions import SimulatorActionsMixin
from simulator_movement import SimulatorMovementMixin
from simulator_orders import SimulatorOrdersMixin


class VehicleSimulator(
    SimulatorActionsMixin,
    SimulatorOrdersMixin,
    SimulatorMovementMixin,
):
    """Own one AMR's state and coordinate its actions, orders, and movement."""

    def __init__(self, config_data: config.Config):
        self.config = config_data
        self.collision_vehicles = []
        route_nodes = load_route_nodes()
        self.route_node_positions = {
            node["node_id"]: (node["x"], node["y"])
            for node in route_nodes
        }
        self.charging_station_node_ids = {
            node["node_id"] for node in route_nodes if node.get("charging_station", False)
        }

        base_topic = mqtt_utils.generate_vda_mqtt_base_topic(
            self.config.mqtt_broker.vda_interface,
            self.config.vehicle.vda_version,
            self.config.vehicle.manufacturer,
            self.config.vehicle.serial_number,
        )

        self.connection_topic = f"{base_topic}/connection"
        self.connection = Connection(
            header_id=0,
            timestamp=utils.get_timestamp(),
            version=self.config.vehicle.vda_full_version,
            manufacturer=self.config.vehicle.manufacturer,
            serial_number=self.config.vehicle.serial_number,
            connection_state=ConnectionState.CONNECTION_BROKEN,
        )

        self.state_topic = f"{base_topic}/state"
        agv_position = AgvPosition(
            x=self.config.settings.spawn_x,
            y=self.config.settings.spawn_y,
            position_initialized=True,
            theta=0.0,
            map_id=self.config.settings.map_id,
            deviation_range=None,
            map_description=None,
            localization_score=None,
        )
        self.state = State(
            header_id=0,
            timestamp=utils.get_timestamp(),
            version=self.config.vehicle.vda_full_version,
            manufacturer=self.config.vehicle.manufacturer,
            serial_number=self.config.vehicle.serial_number,
            driving=False,
            distance_since_last_node=None,
            operating_mode=OperatingMode.AUTOMATIC,
            node_states=[],
            edge_states=[],
            last_node_id="",
            order_id="",
            order_update_id=0,
            last_node_sequence_id=0,
            action_states=[],
            information=[],
            loads=[],
            errors=[],
            battery_state=BatteryState(
                battery_charge=100.0 if self.config.settings.battery_health_min > 0 else 0.0,
                battery_voltage=None,
                battery_health=self.config.settings.battery_health_min,
                charging=False,
                reach=None,
            ),
            safety_state=SafetyState(
                e_stop=EStop.NONE,
                field_violation=False,
            ),
            paused=None,
            new_base_request=None,
            agv_position=agv_position,
            velocity=None,
            zone_set_id=None,
        )
        self._update_battery_reach()

        self.visualization_topic = f"{base_topic}/visualization"
        self.visualization = Visualization(
            header_id=0,
            timestamp=utils.get_timestamp(),
            version=self.config.vehicle.vda_full_version,
            manufacturer=self.config.vehicle.manufacturer,
            serial_number=self.config.vehicle.serial_number,
            agv_position=agv_position,
            velocity=None,
        )

        self.order = None
        self.instant_actions = None
        self.action_start_time = None
        self.action_duration = None

    def register_collision_fleet(self, vehicles):
        """Join a shared fleet only if the configured spawn position is clear."""
        self.collision_vehicles = vehicles
        position = self.state.agv_position
        if not self._position_is_clear(position.x, position.y, position.map_id):
            raise ValueError(
                f"Configured spawn for {self.config.vehicle.serial_number} at "
                f"({position.x}, {position.y}) overlaps another AMR or is invalid; "
                "adjust spawn coordinates, offsets, or collision radii"
            )
        vehicles.append(self)

    def _position_is_clear(self, x, y, map_id, start=None):
        """Check a circular footprint, optionally swept along a movement segment."""
        if not math.isfinite(x) or not math.isfinite(y):
            return False
        start_x, start_y = start if start is not None else (x, y)
        delta_x, delta_y = x - start_x, y - start_y
        length_squared = delta_x * delta_x + delta_y * delta_y
        for vehicle in self.collision_vehicles:
            if vehicle is self:
                continue
            position = vehicle.state.agv_position
            if position is None or position.map_id != map_id:
                continue
            fraction = 0.0
            if length_squared > 0:
                fraction = max(0.0, min(1.0, (
                    (position.x - start_x) * delta_x
                    + (position.y - start_y) * delta_y
                ) / length_squared))
            closest_x = start_x + fraction * delta_x
            closest_y = start_y + fraction * delta_y
            separation = self.config.vehicle.collision_radius + vehicle.config.vehicle.collision_radius
            if math.hypot(position.x - closest_x, position.y - closest_y) < separation:
                return False
        return True

    def _battery_consumption_rate(self):
        base_rate = self.config.settings.battery_consumption_per_meter
        battery_health = self.state.battery_state.battery_health
        if base_rate == 0 or battery_health is None:
            return base_rate
        if battery_health == 0:
            return float("inf")
        return base_rate * 100 / battery_health

    def _update_battery_reach(self):
        battery_state = self.state.battery_state
        rate = self._battery_consumption_rate()
        battery_state.reach = int(battery_state.battery_charge / rate) if rate > 0 else None

    async def publish_connection(self, mqtt_client: mqtt.Client) -> None:
        """Publish this AMR's retained ONLINE connection state."""
        self.connection.header_id += 1
        self.connection.timestamp = utils.get_timestamp()
        self.connection.connection_state = ConnectionState.ONLINE
        payload = json.dumps(self.connection.to_dict())
        await mqtt_utils.mqtt_publish(
            mqtt_client,
            self.connection_topic,
            payload,
            retain=True,
        )

    async def publish_visualization(self, mqtt_client: mqtt.Client) -> None:
        """Publish this AMR's latest visualization position."""
        self.visualization.header_id += 1
        self.visualization.timestamp = utils.get_timestamp()
        payload = json.dumps(self.visualization.to_dict())
        await mqtt_utils.mqtt_publish(mqtt_client, self.visualization_topic, payload)

    async def publish_state(self, mqtt_client: mqtt.Client) -> None:
        """Publish this AMR's latest state."""
        self.state.header_id += 1
        self.state.timestamp = utils.get_timestamp()
        payload = json.dumps(self.state.to_dict())
        await mqtt_utils.mqtt_publish(mqtt_client, self.state_topic, payload)
