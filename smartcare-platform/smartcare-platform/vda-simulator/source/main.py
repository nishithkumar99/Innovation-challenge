import asyncio
import copy
import random
import traceback
from dataclasses import replace

import config
from mqtt_client import MQTTClient
from vehicle_simulator import VehicleSimulator
from simulator_movement import SIMULATION_TICK_SECONDS


async def subscribe_vda_messages(vehicle_simulator, mqtt_client, message_queue):
    """Dispatch queued MQTT commands to one vehicle simulator."""
    while True:
        try:
            message_type, message_data = await message_queue.get()
            if message_type == "order":
                vehicle_simulator.order_accept_procedure(message_data)
            elif message_type == "instantActions":
                vehicle_simulator.instant_actions_accept_procedure(message_data)
            message_queue.task_done()
        except Exception as exc:
            print(f"Error processing message: {exc}")
            traceback.print_exc()
            await asyncio.sleep(1)


async def publish_vda_messages(
    vehicle_simulator,
    mqtt_client,
    state_frequency,
    visualization_frequency,
):
    """Advance one vehicle at 20 Hz and publish its state and visualization."""
    await vehicle_simulator.publish_connection(mqtt_client)
    tick_time = SIMULATION_TICK_SECONDS
    state_ticks = 0
    visualization_ticks = 0

    while True:
        vehicle_simulator.state_iterate()
        state_ticks += 1
        visualization_ticks += 1

        if state_ticks * tick_time > 1.0 / state_frequency:
            state_ticks = 0
            await vehicle_simulator.publish_state(mqtt_client)

        if visualization_ticks * tick_time > 1.0 / visualization_frequency:
            visualization_ticks = 0
            await vehicle_simulator.publish_visualization(mqtt_client)

        await asyncio.sleep(tick_time)


def _battery_health_for_robot(robot_index, robot_count, minimum, maximum):
    """Return the configured health endpoint or a random in-range value."""
    if robot_index == 0:
        return maximum
    if robot_index == 1:
        return minimum
    return random.randint(minimum, maximum)


async def main():
    """Start configured AMRs and their MQTT processing tasks."""
    config_data = config.get_config()
    tasks = []
    vehicles = []

    for robot_index in range(config_data.settings.robot_count):
        vehicle_config = copy.deepcopy(config_data)
        assigned_health = _battery_health_for_robot(
            robot_index,
            config_data.settings.robot_count,
            config_data.settings.battery_health_min,
            config_data.settings.battery_health_max,
        )
        vehicle_config.settings.battery_health_min = assigned_health
        vehicle_config.settings.battery_health_max = assigned_health
        vehicle_config.settings.spawn_x = (
            config_data.settings.spawn_x + robot_index * config_data.settings.spawn_offset_x
        )
        vehicle_config.settings.spawn_y = (
            config_data.settings.spawn_y + robot_index * config_data.settings.spawn_offset_y
        )
        vehicle_config.vehicle.serial_number = f"{config_data.vehicle.serial_number}{robot_index}"
        vehicle_config.vehicle = replace(
            vehicle_config.vehicle,
            collision_radius=config_data.settings.collision_radii.get(
                vehicle_config.vehicle.serial_number,
                config_data.vehicle.collision_radius,
            ),
        )

        vehicle_simulator = VehicleSimulator(vehicle_config)
        vehicle_simulator.register_collision_fleet(vehicles)

    for vehicle_simulator in vehicles:
        vehicle_config = vehicle_simulator.config
        mqtt_handler = MQTTClient(vehicle_config)
        mqtt_client, message_queue = mqtt_handler.connect()
        tasks.append(asyncio.create_task(
            subscribe_vda_messages(vehicle_simulator, mqtt_client, message_queue)
        ))
        tasks.append(asyncio.create_task(
            publish_vda_messages(
                vehicle_simulator,
                mqtt_client,
                config_data.settings.state_frequency,
                config_data.settings.visualization_frequency,
            )
        ))

    await asyncio.gather(*tasks)


if __name__ == "__main__":
    asyncio.run(main())
