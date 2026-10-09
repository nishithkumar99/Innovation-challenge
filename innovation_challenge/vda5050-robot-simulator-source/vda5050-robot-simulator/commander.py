import argparse
import json
import threading
import time
import traceback
import uuid

import paho.mqtt.client as mqtt

import config
import mqtt_utils
import utils
from protocol.vda_2_0_0.vda5050_2_0_0_action import (
    Action,
    ActionParameter,
    ActionParameterValue,
    BlockingType,
)
from protocol.vda_2_0_0.vda5050_2_0_0_instant_actions import InstantActions
from protocol.vda_2_0_0.vda5050_2_0_0_order import Edge, Node, Order
from route_utils import get_nodes_in_edge_order, load_route_definition


class Commander:
    """Publish edge-ordered route orders without resetting AMR positions."""

    def __init__(self, configuration=None, send_initial_commands=True, auto_reorder=True):
        self.config = configuration or config.get_config()
        self.send_initial_commands_enabled = send_initial_commands
        self.auto_reorder_enabled = auto_reorder
        self.nodes_template, self.edges_template = load_route_definition()
        self.ordered_nodes = get_nodes_in_edge_order(self.nodes_template, self.edges_template)
        self.client = None
        self.serial_numbers = []
        self.base_topics = {}
        self.order_counters = {}
        self.last_dispatched_for = {}
        self.pending_reorder_serials = {}
        self.registry_lock = threading.Lock()

    def _base_topic(self, serial_number):
        return mqtt_utils.generate_vda_mqtt_base_topic(
            self.config.mqtt_broker.vda_interface,
            self.config.vehicle.vda_version,
            self.config.vehicle.manufacturer,
            serial_number,
        )

    def start(self):
        options = mqtt_utils.mqtt_create_opts()
        self.client = mqtt.Client(
            callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
            client_id=options["client_id"] + "-commander",
            protocol=mqtt.MQTTv5,
        )
        self.client.on_connect = self.on_connect
        self.client.on_message = self.on_message

        broker_host = self.config.mqtt_broker.host
        broker_port = int(self.config.mqtt_broker.port)
        if broker_host.startswith("tcp://"):
            broker_host = broker_host[len("tcp://"):]
        if ":" in broker_host:
            host_part, port_part = broker_host.rsplit(":", 1)
            if port_part.isdigit():
                broker_host = host_part
                broker_port = int(port_part)

        try:
            self.client.connect(host=broker_host, port=broker_port)
            self.client.loop_start()
            print("Commander connected to MQTT broker.")
            return True
        except Exception as exc:
            print(f"Commander MQTT connection failed: {exc}")
            traceback.print_exc()
            self.client = None
            return False

    def stop(self):
        if self.client:
            self.client.loop_stop()
            self.client.disconnect()
            self.client = None

    def run(self):
        if not self.start():
            return
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            print("Stopping commander...")
        finally:
            self.stop()

    def on_connect(self, client, userdata, flags, reason_code, properties=None):
        print(f"Commander connected with result code {reason_code}")
        discovery_topic = (
            f"{self.config.mqtt_broker.vda_interface}/"
            f"{self.config.vehicle.vda_version}/"
            f"{self.config.vehicle.manufacturer}/+/connection"
        )
        client.subscribe(discovery_topic, qos=1)
        print(f"Subscribed to discovery topic {discovery_topic}")

        with self.registry_lock:
            known_serials = list(self.serial_numbers)
        for serial_number in known_serials:
            self._subscribe_robot(client, serial_number)

    def _subscribe_robot(self, client, serial_number):
        base_topic = self.base_topics.get(serial_number)
        if base_topic:
            client.subscribe(f"{base_topic}/state", qos=1)

    def register_robot(self, serial_number):
        with self.registry_lock:
            if serial_number in self.serial_numbers:
                return
            self.serial_numbers.append(serial_number)
            robot_index = len(self.serial_numbers) - 1
            self.base_topics[serial_number] = self._base_topic(serial_number)
            self.order_counters[serial_number] = 0

        print(f"Discovered robot: {serial_number}")
        if self.client:
            self._subscribe_robot(self.client, serial_number)
        if self.send_initial_commands_enabled:
            threading.Thread(
                target=self.send_initial_commands,
                args=(serial_number, robot_index),
                daemon=True,
            ).start()

    def on_message(self, client, userdata, message):
        topic_parts = message.topic.split("/")
        if len(topic_parts) < 5:
            return
        topic_type = topic_parts[-1]
        serial_number = topic_parts[-2]
        if topic_type == "connection":
            self.register_robot(serial_number)
            return

        with self.registry_lock:
            known_robot = serial_number in self.serial_numbers
        if not known_robot:
            self.register_robot(serial_number)

        try:
            data = json.loads(message.payload.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            print(f"Error decoding JSON from {message.topic}")
            return
        if topic_type != "state":
            return

        order_id = data.get("orderId", "")
        node_states = data.get("nodeStates") or []
        edge_states = data.get("edgeStates") or []
        if self.last_dispatched_for.get(serial_number) != order_id:
            self.last_dispatched_for.pop(serial_number, None)
        if self.pending_reorder_serials.get(serial_number) != order_id:
            self.pending_reorder_serials.pop(serial_number, None)

        if not order_id or node_states or edge_states:
            return
        if self.last_dispatched_for.get(serial_number) == order_id:
            return
        if self.auto_reorder_enabled:
            self.last_dispatched_for[serial_number] = order_id
            print(f"Order '{order_id}' completed by {serial_number}; sending the next order.")
            threading.Thread(target=self.send_next_order, args=(serial_number,), daemon=True).start()
        else:
            self.pending_reorder_serials[serial_number] = order_id

    def send_initial_commands(self, serial_number, robot_index):
        self.send_next_order(serial_number)

    def send_next_order(self, serial_number):
        with self.registry_lock:
            self.order_counters[serial_number] += 1
            counter = self.order_counters[serial_number]
        order_id = f"order_loop_{serial_number}_{counter}"
        nodes_data = []
        for node_template in self.ordered_nodes:
            node_copy = dict(node_template)
            node_copy["actions"] = []
            for action_template in node_template.get("actions", []):
                action_copy = dict(action_template)
                action_copy["action_id"] = str(uuid.uuid4())
                node_copy["actions"].append(action_copy)
            nodes_data.append(node_copy)
        print(f"Commander: Sending order '{order_id}' to {serial_number}")
        self.send_order(serial_number, order_id, nodes_data, self.edges_template)

    def send_instant_action(self, serial_number, action_type, params=None, blocking_type=BlockingType.HARD):
        if not self.client:
            print("MQTT client not connected.")
            return
        base_topic = self.base_topics.get(serial_number)
        if not base_topic:
            print(f"Could not find base topic for {serial_number}")
            return
        action_params = [
            ActionParameter(key=key, value=ActionParameterValue(value))
            for key, value in (params or {}).items()
        ]
        action = Action(
            action_type=action_type,
            action_id=str(uuid.uuid4()),
            blocking_type=blocking_type,
            action_parameters=action_params,
        )
        command = InstantActions(
            header_id=0,
            timestamp=utils.get_timestamp(),
            version=self.config.vehicle.vda_full_version,
            manufacturer=self.config.vehicle.manufacturer,
            serial_number=serial_number,
            instant_actions=[action],
        )
        self._publish(f"{base_topic}/instantActions", command.to_dict())

    def send_order(self, serial_number, order_id, nodes_data, edges_data):
        if not self.client:
            print("MQTT client not connected.")
            return
        base_topic = self.base_topics.get(serial_number)
        if not base_topic:
            print(f"Could not find base topic for {serial_number}")
            return

        nodes = []
        for node_index, node_data in enumerate(nodes_data):
            actions = []
            for action_data in node_data.get("actions", []):
                parameters = [
                    ActionParameter(key=key, value=ActionParameterValue(value))
                    for key, value in action_data.get("action_parameters", {}).items()
                ]
                actions.append(Action(
                    action_type=action_data["action_type"],
                    action_id=action_data.get("action_id", str(uuid.uuid4())),
                    blocking_type=BlockingType(action_data.get("blocking_type", BlockingType.HARD)),
                    action_parameters=parameters,
                    action_description=action_data.get("action_description"),
                ))
            nodes.append(Node(
                node_id=node_data["node_id"],
                sequence_id=node_index * 2,
                released=node_data.get("released", True),
                node_description=node_data.get("node_description"),
                actions=actions,
            ))

        edges = [
            Edge(
                edge_id=edge_data["edge_id"],
                sequence_id=edge_index * 2 + 1,
                start_node_id=edge_data["start_node_id"],
                end_node_id=edge_data["end_node_id"],
                released=edge_data.get("released", True),
                actions=[],
            )
            for edge_index, edge_data in enumerate(edges_data)
        ]
        order = Order(
            header_id=0,
            timestamp=utils.get_timestamp(),
            version=self.config.vehicle.vda_full_version,
            manufacturer=self.config.vehicle.manufacturer,
            serial_number=serial_number,
            order_id=order_id,
            order_update_id=0,
            nodes=nodes,
            edges=edges,
        )
        self._publish(f"{base_topic}/order", order.to_dict())

    def _publish(self, topic, data):
        payload = json.dumps(data, indent=4)
        print(f"Publishing to {topic}")
        result = self.client.publish(topic, payload=payload, qos=1)
        print(f"Publish result: {result.rc}")

    def enable_auto_reorder(self):
        self.auto_reorder_enabled = True
        with self.registry_lock:
            pending = list(self.pending_reorder_serials.items())
        for serial_number, completed_order_id in pending:
            if self.last_dispatched_for.get(serial_number) != completed_order_id:
                self.last_dispatched_for[serial_number] = completed_order_id
                threading.Thread(target=self.send_next_order, args=(serial_number,), daemon=True).start()


def main():
    parser = argparse.ArgumentParser(description="VDA5050 MQTT commander")
    parser.add_argument(
        "--disable-initial-commands",
        action="store_true",
        help="Do not send an initial order when robots are discovered.",
    )
    parser.add_argument(
        "--disable-auto-reorder",
        action="store_true",
        help="Do not automatically send another order when a robot completes its current order.",
    )
    args = parser.parse_args()
    Commander(
        send_initial_commands=not args.disable_initial_commands,
        auto_reorder=not args.disable_auto_reorder,
    ).run()


if __name__ == "__main__":
    main()
