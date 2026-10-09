import copy
import json
import math
import unittest
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from config import get_config
from protocol.vda_2_0_0.vda5050_2_0_0_state import ActionStatus
from vehicle_simulator import VehicleSimulator


class CollisionTests(unittest.TestCase):
    def setUp(self):
        self.config = get_config()
        self.config.vehicle.collision_radius = 0.5
        self.config.settings.spawn_x = 0.0
        self.config.settings.spawn_y = 0.0
        self.fleet = []
        self.first = VehicleSimulator(copy.deepcopy(self.config))
        second_config = copy.deepcopy(self.config)
        second_config.settings.spawn_x = 2.0
        self.second = VehicleSimulator(second_config)
        self.first.register_collision_fleet(self.fleet)
        self.second.register_collision_fleet(self.fleet)
        self.set_position(self.first, 0.0, 0.0)
        self.set_position(self.second, 2.0, 0.0)

    def set_position(self, vehicle, x, y):
        vehicle.state.agv_position.x = x
        vehicle.state.agv_position.y = y

    def set_route(self, target_x, speed=0.2):
        self.first.config.settings.speed = speed
        self.first.state.last_node_id = "start"
        self.first.state.last_node_sequence_id = 0
        nodes = [
            SimpleNamespace(node_id="start", sequence_id=0, actions=[]),
            SimpleNamespace(node_id="target", sequence_id=2, actions=[]),
        ]
        self.first.order = SimpleNamespace(nodes=nodes)
        self.first.state.node_states = [
            SimpleNamespace(node_id="start", sequence_id=0, node_position=None),
            SimpleNamespace(
                node_id="target", sequence_id=2,
                node_position=SimpleNamespace(x=target_x, y=0.0),
            ),
        ]

    def test_default_and_invalid_radii(self):
        self.assertEqual(replace(self.config.vehicle).collision_radius, 0.5)
        for radius in (0.0, -0.5, math.inf, math.nan):
            with self.subTest(radius=radius), self.assertRaises(ValueError):
                replace(self.config.vehicle, collision_radius=radius)

    def test_touching_allowed_overlap_blocked(self):
        map_id = self.config.settings.map_id
        self.assertTrue(self.first._position_is_clear(1.0, 0.0, map_id))
        self.assertFalse(self.first._position_is_clear(1.01, 0.0, map_id))

    def test_unequal_radii(self):
        self.second.config.vehicle = replace(self.second.config.vehicle, collision_radius=0.75)
        self.assertFalse(self.first._position_is_clear(1.0, 0.0, self.config.settings.map_id))
        self.assertTrue(self.first._position_is_clear(0.75, 0.0, self.config.settings.map_id))

    def test_swept_segment_blocks_tunneling(self):
        self.assertFalse(self.first._position_is_clear(
            4.0, 0.0, self.config.settings.map_id, start=(0.0, 0.0),
        ))
        self.assertTrue(self.first._position_is_clear(
            4.0, 1.0, self.config.settings.map_id, start=(0.0, 1.0),
        ))

    def test_other_map_does_not_block(self):
        self.second.state.agv_position.map_id = "other-map"
        self.assertTrue(self.first._position_is_clear(2.0, 0.0, self.config.settings.map_id))

    def test_spawn_is_separated(self):
        spawn_config = copy.deepcopy(self.config)
        spawn_config.settings.spawn_x = 5.0
        spawn_config.settings.spawn_y = 5.0
        vehicle = VehicleSimulator(spawn_config)
        vehicle.register_collision_fleet(self.fleet)
        self.assertTrue(vehicle._position_is_clear(
            vehicle.state.agv_position.x, vehicle.state.agv_position.y,
            self.config.settings.map_id,
        ))
        self.assertEqual((vehicle.state.agv_position.x, vehicle.state.agv_position.y), (5.0, 5.0))

    def test_overlapping_spawn_rejected_without_relocation(self):
        vehicle = VehicleSimulator(copy.deepcopy(self.config))
        with self.assertRaisesRegex(ValueError, "Configured spawn"):
            vehicle.register_collision_fleet(self.fleet)
        self.assertEqual((vehicle.state.agv_position.x, vehicle.state.agv_position.y), (0.0, 0.0))
        self.assertNotIn(vehicle, self.fleet)

    def test_invalid_spawn_settings(self):
        for setting in ("spawn_x", "spawn_y", "spawn_offset_x", "spawn_offset_y"):
            for value in (math.inf, math.nan):
                with self.subTest(setting=setting, value=value), self.assertRaises(ValueError):
                    replace(self.config.settings, **{setting: value})

    def test_commander_startup_does_not_reset_positions(self):
        from commander import Commander

        commander = Commander(configuration=self.config)
        with patch.object(commander, "send_instant_action") as instant_action:
            with patch.object(commander, "send_next_order") as next_order:
                commander.send_initial_commands("AMR1", 0)
                instant_action.assert_not_called()
                next_order.assert_called_once_with("AMR1")

    def test_visualizer_discovery_only_subscribes(self):
        from visualizer import Visualizer

        visualizer = Visualizer(configuration=self.config)
        client = Mock()
        visualizer.client = client
        visualizer.on_connect(client, None, None, 0)
        base_topic = visualizer._base_topic("AMR1")
        visualizer.on_message(client, None, SimpleNamespace(
            topic=f"{base_topic}/connection", payload=b"{}",
        ))
        visualizer.on_message(client, None, SimpleNamespace(
            topic=f"{base_topic}/visualization",
            payload=json.dumps({"agvPosition": {"x": 12.0, "y": 8.0, "theta": 0.0}}).encode(),
        ))
        self.assertEqual(visualizer.robot_positions["AMR1"], (12.0, 8.0, 0.0))
        client.publish.assert_not_called()
        topics = [call.args[0] for call in client.subscribe.call_args_list]
        self.assertIn(f"{base_topic}/visualization", topics)
        self.assertIn(f"{base_topic}/state", topics)

    def test_blocked_step_preserves_position_battery_and_route(self):
        self.set_position(self.first, 0.9, 0.0)
        self.set_route(5.0)
        charge = self.first.state.battery_state.battery_charge
        self.first.state_iterate()
        self.assertEqual(self.first.state.agv_position.x, 0.9)
        self.assertEqual(self.first.state.battery_state.battery_charge, charge)
        self.assertFalse(self.first.state.driving)
        self.assertTrue(self.first.state.safety_state.field_violation)
        self.assertEqual(len(self.first.state.node_states), 2)
        self.set_position(self.second, 2.0, 2.0)
        self.first.state_iterate()
        self.assertGreater(self.first.state.agv_position.x, 0.9)
        self.assertTrue(self.first.state.driving)
        self.assertFalse(self.first.state.safety_state.field_violation)

    def test_fast_step_cannot_pass_through_vehicle(self):
        self.set_route(10.0, speed=4.0)
        self.first.state_iterate()
        self.assertEqual(self.first.state.agv_position.x, 0.0)
        self.assertFalse(self.first.state.driving)

    def test_arrival_snap_cannot_overlap(self):
        self.set_position(self.first, 1.0, 0.0)
        self.set_route(1.1)
        self.first.state_iterate()
        self.assertEqual(self.first.state.agv_position.x, 1.0)
        self.assertEqual(self.first.state.last_node_id, "start")
        self.assertEqual(len(self.first.state.node_states), 2)

    def test_init_position_rejects_overlap_and_accepts_clear_position(self):
        for index, (target_x, expected) in enumerate((
            (2.0, ActionStatus.FAILED), (4.0, ActionStatus.FINISHED),
        )):
            action = SimpleNamespace(
                action_id=f"init-{index}", action_type="initPosition",
                action_parameters=[
                    SimpleNamespace(key=key, value=SimpleNamespace(value=value))
                    for key, value in (("x", target_x), ("y", 0.0), ("mapId", self.config.settings.map_id))
                ],
            )
            self.first.state.action_states.append(self.first._create_action_state(action))
            self.assertTrue(self.first.run_action(action))
            self.assertEqual(self.first.state.action_states[-1].action_status, expected)
            self.assertEqual(self.first.state.agv_position.x, 0.0 if index == 0 else 4.0)
            self.assertIs(self.first.visualization.agv_position, self.first.state.agv_position)


class StartupTests(unittest.IsolatedAsyncioTestCase):
    async def test_fleet_uses_base_position_and_offsets(self):
        import main as simulator_main

        for offset_x, offset_y in ((1.5, 0.0), (0.0, -2.0), (1.5, 2.0)):
            with self.subTest(offset_x=offset_x, offset_y=offset_y):
                configuration = get_config()
                configuration.vehicle.collision_radius = 0.5
                configuration.settings = replace(
                    configuration.settings, robot_count=3, collision_radii={},
                    spawn_x=10.0, spawn_y=12.0,
                    spawn_offset_x=offset_x, spawn_offset_y=offset_y,
                )
                publish = AsyncMock()
                with patch.object(simulator_main.config, "get_config", return_value=configuration), \
                        patch.object(simulator_main, "MQTTClient") as mqtt_handler, \
                        patch.object(simulator_main, "subscribe_vda_messages", new=AsyncMock()), \
                        patch.object(simulator_main, "publish_vda_messages", new=publish):
                    mqtt_handler.return_value.connect.return_value = (Mock(), Mock())
                    await simulator_main.main()
                vehicles = [call.args[0] for call in publish.await_args_list]
                self.assertEqual(len(vehicles), 3)
                for index, vehicle in enumerate(vehicles):
                    position = vehicle.state.agv_position
                    self.assertEqual((position.x, position.y), (
                        10.0 + index * offset_x, 12.0 + index * offset_y,
                    ))
                    self.assertIs(vehicle.visualization.agv_position, position)
                self.assertEqual((configuration.settings.spawn_x, configuration.settings.spawn_y), (10.0, 12.0))

    async def test_overlapping_fleet_fails_before_mqtt_connect(self):
        import main as simulator_main

        configuration = get_config()
        configuration.settings = replace(
            configuration.settings, robot_count=2,
            spawn_offset_x=0.0, spawn_offset_y=0.0,
        )
        with patch.object(simulator_main.config, "get_config", return_value=configuration), \
                patch.object(simulator_main, "MQTTClient") as mqtt_handler:
            with self.assertRaisesRegex(ValueError, "Configured spawn"):
                await simulator_main.main()
            mqtt_handler.assert_not_called()


if __name__ == "__main__":
    unittest.main()