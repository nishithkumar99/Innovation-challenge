import os
import json
import math
import threading

import matplotlib.animation as animation
import matplotlib.pyplot as plt
import paho.mqtt.client as mqtt
from matplotlib.collections import LineCollection
from matplotlib.patches import PathPatch
from matplotlib.path import Path
from matplotlib.transforms import Affine2D

import config
import mqtt_utils
from route_utils import load_route_nodes


_ARROW_PATH = Path(
    [(-0.5, -0.15), (0.1, -0.15), (0.1, -0.3), (0.5, 0.0),
     (0.1, 0.3), (0.1, 0.15), (-0.5, 0.15), (-0.5, -0.15)],
    [Path.MOVETO, Path.LINETO, Path.LINETO, Path.LINETO,
     Path.LINETO, Path.LINETO, Path.LINETO, Path.CLOSEPOLY],
)


class Visualizer:
    """Display the configured route and subscribe to live AMR telemetry."""

    def __init__(self, configuration=None):
        self.config = configuration or config.get_config()
        self.node_templates = load_route_nodes()
        self.edge_templates = self._get_visualizer_edges()
        self.robot_serial_numbers = []
        self.base_topics = {}
        self.robot_positions = {}
        self.robot_states_info = {}
        self.robot_colors = {}
        self.robot_patches = {}
        self.robot_labels = {}
        self.registry_lock = threading.Lock()
        self.client = None
        self.fig = None
        self.ax = None
        self.ax_info = None
        self.info_text = None
        self.path_plot = None
        self.edge_collection = None
        self.node_plot = None
        self.node_name_labels = []
        self.drop_plot = None
        self.animation = None
        self.dropped_package_locations = self._get_drop_locations()

    def _get_visualizer_edges(self):
        node_ids = {node["node_id"] for node in self.node_templates}
        neighbors_by_node = {}
        for node in self.node_templates:
            node_id = node["node_id"]
            neighbors = node.get("neghbour_nodes") or []
            if not isinstance(neighbors, list):
                raise ValueError(f"neghbour_nodes for '{node_id}' must be a list")
            for neighbor_id in neighbors:
                if neighbor_id not in node_ids:
                    raise ValueError(
                        f"Node '{node_id}' references unknown neighbor '{neighbor_id}'"
                    )
            neighbors_by_node[node_id] = set(neighbors)

        edges = []
        seen_connections = set()
        for node in self.node_templates:
            node_id = node["node_id"]
            for neighbor_id in neighbors_by_node[node_id]:
                if node_id not in neighbors_by_node[neighbor_id]:
                    continue
                connection = tuple(sorted((node_id, neighbor_id)))
                if connection in seen_connections:
                    continue
                seen_connections.add(connection)
                edges.append({
                    "start_node_id": connection[0],
                    "end_node_id": connection[1],
                })
        return edges

    def _get_drop_locations(self):
        locations = []
        for node in self.node_templates:
            if any(action.get("action_type") == "dropOff" for action in node.get("actions", [])):
                location = (node["x"], node["y"])
                if location not in locations:
                    locations.append(location)
        return locations

    def _base_topic(self, serial_number):
        return mqtt_utils.generate_vda_mqtt_base_topic(
            self.config.mqtt_broker.vda_interface,
            self.config.vehicle.vda_version,
            self.config.vehicle.manufacturer,
            serial_number,
        )

    def start_mqtt(self):
        options = mqtt_utils.mqtt_create_opts()
        self.client = mqtt.Client(
            callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
            client_id=options["client_id"] + "-visualizer",
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
            print("Visualizer subscribed to MQTT telemetry.")
            return True
        except Exception as exc:
            print(f"Visualizer could not connect to MQTT broker; showing the route offline: {exc}")
            self.client = None
            return False

    def stop_mqtt(self):
        if self.client:
            self.client.loop_stop()
            self.client.disconnect()
            self.client = None

    def on_connect(self, client, userdata, flags, reason_code, properties=None):
        print(f"Visualizer connected with result code {reason_code}")
        discovery_topic = (
            f"{self.config.mqtt_broker.vda_interface}/"
            f"{self.config.vehicle.vda_version}/"
            f"{self.config.vehicle.manufacturer}/+/connection"
        )
        client.subscribe(discovery_topic, qos=1)
        print(f"Subscribed to discovery topic {discovery_topic}")
        with self.registry_lock:
            known_serials = list(self.robot_serial_numbers)
        for serial_number in known_serials:
            self._subscribe_robot(client, serial_number)

    def _subscribe_robot(self, client, serial_number):
        base_topic = self.base_topics.get(serial_number)
        if base_topic:
            for topic_type in ("visualization", "state"):
                topic = f"{base_topic}/{topic_type}"
                client.subscribe(topic, qos=1)
                print(f"Subscribed to {topic}")

    def register_robot(self, serial_number):
        with self.registry_lock:
            if serial_number in self.robot_serial_numbers:
                return
            self.robot_serial_numbers.append(serial_number)
            self.base_topics[serial_number] = self._base_topic(serial_number)
        print(f"Discovered robot: {serial_number}")
        if self.client:
            self._subscribe_robot(self.client, serial_number)

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
            known_robot = serial_number in self.robot_serial_numbers
        if not known_robot:
            self.register_robot(serial_number)
        try:
            data = message.payload.decode("utf-8")
            data = json.loads(data)
        except (UnicodeDecodeError, ValueError):
            print(f"Error decoding JSON from {message.topic}")
            return

        if topic_type == "visualization":
            position = data.get("agvPosition")
            if isinstance(position, dict) and all(key in position for key in ("x", "y", "theta")):
                self.robot_positions[serial_number] = (
                    position["x"], position["y"], position["theta"]
                )
            else:
                print(f"Warning: Missing or invalid agvPosition for {serial_number}")
        elif topic_type == "state":
            agv_position = data.get("agvPosition") or {}
            running_actions = [
                action for action in (data.get("actionStates") or [])
                if action.get("actionStatus") == "RUNNING"
            ]
            self.robot_states_info[serial_number] = {
                "order_id": data.get("orderId", ""),
                "running_actions": running_actions,
                "position": (
                    agv_position.get("x"),
                    agv_position.get("y"),
                    agv_position.get("theta"),
                ),
                "last_node": data.get("lastNodeId") or "-",
                "driving": data.get("driving", False),
            }

    def _add_robot_plot(self, serial_number, color):
        transform = Affine2D().scale(0.4).translate(-9999, -9999) + self.ax.transData
        patch = PathPatch(
            _ARROW_PATH,
            facecolor=color,
            edgecolor="black",
            linewidth=0.5,
            label=serial_number,
            zorder=5,
            transform=transform,
        )
        self.ax.add_patch(patch)
        label = self.ax.text(
            -9999, -9999, serial_number[-2:], fontsize=8,
            ha="center", va="bottom", color=color,
        )
        self.robot_colors[serial_number] = color
        self.robot_patches[serial_number] = patch
        self.robot_labels[serial_number] = label

    def _refresh_legend(self):
        self.ax.legend(
            loc="upper center",
            bbox_to_anchor=(0.5, -0.18),
            ncol=4,
            borderaxespad=0.0,
        )

    def _layout_node_labels(self):
        self.fig.canvas.draw()
        renderer = self.fig.canvas.get_renderer()
        nodes_by_id = {node["node_id"]: node for node in self.node_templates}
        points = {
            node_id: self.ax.transData.transform((node["x"], node["y"]))
            for node_id, node in nodes_by_id.items()
        }
        directions = (
            (1, 0), (-1, 0), (0, 1), (0, -1),
            (1, 1), (-1, 1), (1, -1), (-1, -1),
        )
        offsets = [
            (dx * radius, dy * radius)
            for radius in (8, 14, 20, 26, 32, 40, 50)
            for dx, dy in directions
        ]

        def nearest_node_distance(node_id):
            return min(
                math.dist(points[node_id], point)
                for other_id, point in points.items()
                if other_id != node_id
            )

        labels_by_id = {
            label.get_text().replace("\n", "_"): label
            for label in self.node_name_labels
        }
        priority = sorted(nodes_by_id, key=nearest_node_distance)
        placed_boxes = []
        for node_id in priority:
            label = labels_by_id[node_id]
            own_point = points[node_id]
            best_candidate = None
            for offset_x, offset_y in offsets:
                label.set_position((offset_x, offset_y))
                label.set_ha("left" if offset_x > 0 else "right" if offset_x < 0 else "center")
                label.set_va("bottom" if offset_y > 0 else "top" if offset_y < 0 else "center")
                box = label.get_window_extent(renderer)
                center = box.get_points().mean(axis=0)
                own_distance = math.dist(center, own_point)
                other_distances = [
                    math.dist(center, point)
                    for other_id, point in points.items()
                    if other_id != node_id
                ]
                if other_distances and own_distance >= min(other_distances):
                    continue
                if any(box.overlaps(placed_box) for placed_box in placed_boxes):
                    continue
                covers_other_node = any(
                    box.contains(*point)
                    for other_id, point in points.items()
                    if other_id != node_id
                )
                if covers_other_node:
                    continue
                distance = math.hypot(offset_x, offset_y)
                if best_candidate is None or distance < best_candidate[0]:
                    best_candidate = (distance, (offset_x, offset_y), box)

            if best_candidate is None:
                raise ValueError(f"Could not place node label without overlap: {node_id}")

            _, offset, box = best_candidate
            label.set_position(offset)
            label.set_ha("left" if offset[0] > 0 else "right" if offset[0] < 0 else "center")
            label.set_va("bottom" if offset[1] > 0 else "top" if offset[1] < 0 else "center")
            placed_boxes.append(box)

    def init_plot(self):
        floorplan_x = self.config.settings.floorplan_x
        floorplan_y = self.config.settings.floorplan_y
        self.ax.set_xlabel("X Coordinate")
        self.ax.set_ylabel("Y Coordinate")
        self.ax.set_title("Robot Positions & Path")
        self.ax.set_xlim(0, floorplan_x)
        self.ax.set_ylim(0, floorplan_y)

        image_path = os.path.join(
            os.path.dirname(os.path.abspath(__file__)),
            self.config.settings.background_image,
        )
        try:
            background_image = plt.imread(image_path)
            image_height, image_width = background_image.shape[:2]
            image_scale = min(floorplan_x / image_width, floorplan_y / image_height)
            width_units = image_width * image_scale
            height_units = image_height * image_scale
            image_left = (floorplan_x - width_units) / 2
            image_bottom = (floorplan_y - height_units) / 2
            self.ax.imshow(
                background_image,
                extent=(image_left, image_left + width_units,
                        image_bottom, image_bottom + height_units),
                origin="upper",
                aspect="auto",
                alpha=0.55,
                zorder=0,
            )
        except (OSError, ValueError) as exc:
            print(f"Warning: Could not load floorplan background image '{image_path}': {exc}")

        self.ax.grid(True)
        self.ax.set_aspect("equal", adjustable="box")
        self.ax_info = self.fig.add_axes([0.67, 0.15, 0.31, 0.80])
        self.ax_info.set_axis_off()
        self.ax_info.set_facecolor("lightyellow")
        self.info_text = self.ax_info.text(
            0.04, 0.98, "", transform=self.ax_info.transAxes,
            fontsize=8, va="top", ha="left", fontfamily="monospace", wrap=True,
        )

        nodes_by_id = {node["node_id"]: node for node in self.node_templates}
        edge_segments = [
            [
                (nodes_by_id[edge["start_node_id"]]["x"], nodes_by_id[edge["start_node_id"]]["y"]),
                (nodes_by_id[edge["end_node_id"]]["x"], nodes_by_id[edge["end_node_id"]]["y"]),
            ]
            for edge in self.edge_templates
        ]
        self.edge_collection = LineCollection(
            edge_segments,
            colors="grey",
            linestyles="dashed",
            linewidths=1,
            label="Edges",
            zorder=2,
        )
        self.ax.add_collection(self.edge_collection)
        self.node_plot, = self.ax.plot(
            [node["x"] for node in self.node_templates],
            [node["y"] for node in self.node_templates],
            marker="s",
            linestyle="",
            color="grey",
            label="Nodes",
            zorder=3,
        )
        for node in self.node_templates:
            self.node_name_labels.append(self.ax.annotate(
                node["node_id"].replace("_", "\n"),
                xy=(node["x"], node["y"]),
                xytext=(8, 8),
                textcoords="offset points",
                fontsize=6,
                ha="left",
                va="bottom",
                color="#222222",
                bbox={"facecolor": "white", "edgecolor": "none", "alpha": 0.72, "pad": 1},
                arrowprops={
                    "arrowstyle": "-",
                    "color": "#555555",
                    "linewidth": 0.5,
                    "shrinkA": 1,
                    "shrinkB": 4,
                },
                zorder=4,
            ))
        colors = plt.rcParams["axes.prop_cycle"].by_key()["color"]
        with self.registry_lock:
            serials = list(self.robot_serial_numbers)
        for index, serial_number in enumerate(serials):
            self._add_robot_plot(serial_number, colors[index % len(colors)])
        self.drop_plot, = self.ax.plot(
            [location[0] for location in self.dropped_package_locations],
            [location[1] for location in self.dropped_package_locations],
            marker="x", color="red", linestyle="", markersize=7, label="DropOff",
        )
        self._refresh_legend()
        self._layout_node_labels()
        return [self.node_plot, self.drop_plot, self.info_text, *self.node_name_labels]

    def update_plot(self, frame):
        artists = []
        with self.registry_lock:
            serials = list(self.robot_serial_numbers)
        colors = plt.rcParams["axes.prop_cycle"].by_key()["color"]
        added_robot = False
        for serial_number in serials:
            if serial_number not in self.robot_patches:
                self._add_robot_plot(
                    serial_number,
                    colors[len(self.robot_patches) % len(colors)],
                )
                added_robot = True
        if added_robot:
            self._refresh_legend()

        for serial_number, patch in self.robot_patches.items():
            if serial_number in self.robot_positions:
                x, y, theta = self.robot_positions[serial_number]
                patch.set_transform(
                    Affine2D().scale(0.4).rotate(theta).translate(x, y) + self.ax.transData
                )
                self.robot_labels[serial_number].set_position((x, y + 0.25))
                self.robot_labels[serial_number].set_text(f"{serial_number} ({x:.1f}, {y:.1f})")
                artists.extend((patch, self.robot_labels[serial_number]))
            else:
                patch.set_transform(
                    Affine2D().scale(0.4).translate(-9999, -9999) + self.ax.transData
                )
                self.robot_labels[serial_number].set_position((-9999, -9999))

        if self.info_text is not None:
            lines = ["AGV Status\n" + "-" * 22]
            with self.registry_lock:
                serials = list(self.robot_serial_numbers)
            for serial_number in serials:
                info = self.robot_states_info.get(serial_number, {})
                order_id = info.get("order_id") or "-"
                running_actions = info.get("running_actions", [])
                position = info.get("position", (None, None, None))
                lines.extend((f"\n[{serial_number}]", f"Order: {order_id}"))
                lines.append(f"Driving: {'yes' if info.get('driving') else 'no'}")
                if running_actions:
                    for action in running_actions:
                        action_type = action.get("actionType", "?")
                        action_id = action.get("actionId", "?")
                        lines.append(f"Action: {action_type} ({action_id[:8]})")
                else:
                    lines.append("Action: none")
                if position[0] is not None:
                    lines.append(
                        f"Position: x={position[0]:.2f} y={position[1]:.2f} "
                        f"theta={position[2] * 180 / 3.14159:.2f} deg"
                    )
                else:
                    lines.append("Position: ?")
                lines.append(f"Last node: {info.get('last_node', '-')}")
                lines.append("-" * 22)
            self.info_text.set_text("\n".join(lines))
            artists.append(self.info_text)
        if self.drop_plot is not None:
            artists.append(self.drop_plot)
        return artists

    def run(self):
        self.fig, self.ax = plt.subplots(figsize=(14, 7))
        self.fig.subplots_adjust(left=0.06, bottom=0.20, right=0.64, top=0.95)
        self.start_mqtt()
        self.animation = animation.FuncAnimation(
            self.fig,
            self.update_plot,
            init_func=self.init_plot,
            interval=100,
            blit=False,
            cache_frame_data=False,
        )
        try:
            plt.show()
        finally:
            self.stop_mqtt()


def main():
    Visualizer().run()


if __name__ == "__main__":
    main()
