import asyncio
import json
import time
import traceback

import paho.mqtt.client as mqtt

import config
import mqtt_utils
import utils
from protocol.vda_2_0_0.vda5050_2_0_0_connection import Connection, ConnectionState
from protocol.vda_2_0_0.vda5050_2_0_0_instant_actions import InstantActions
from protocol.vda_2_0_0.vda5050_2_0_0_order import Order


class MQTTClient:
    """Own the MQTT transport for one simulated AMR."""

    def __init__(self, config_data: config.Config):
        self.config = config_data
        self.client = None
        self.base_topic = mqtt_utils.generate_vda_mqtt_base_topic(
            self.config.mqtt_broker.vda_interface,
            self.config.vehicle.vda_version,
            self.config.vehicle.manufacturer,
            self.config.vehicle.serial_number,
        )
        self.message_queue = None
        self.loop = None

    def on_connect(self, client, userdata, flags, rc, properties=None):
        """Subscribe this AMR client to control topics after connecting."""
        print(f"Connected with result code {rc}")
        topics = (
            f"{self.base_topic}/order",
            f"{self.base_topic}/instantActions",
        )
        for topic in topics:
            client.subscribe(topic, qos=1)
            print(f"SIM ({self.config.vehicle.serial_number}): Subscribed to {topic}")

    def on_message(self, client, userdata, msg):
        """Parse incoming commands and enqueue them for the asyncio loop."""
        topic = msg.topic
        topic_type = utils.get_topic_type(topic)
        payload = msg.payload.decode("utf-8")
        serial_number = self.config.vehicle.serial_number
        print(f"SIM ({serial_number}): Received raw message on {topic_type}")

        if self.loop is None or self.message_queue is None:
            print(f"SIM ({serial_number}): Error - Loop or Queue not initialized in on_message.")
            return

        try:
            if topic_type == "order":
                order = Order.from_dict(json.loads(payload))
                self.loop.call_soon_threadsafe(self.message_queue.put_nowait, ("order", order))
                print(f"SIM ({serial_number}): Queued order {order.order_id}")
            elif topic_type == "instantActions":
                instant_actions = InstantActions.from_dict(json.loads(payload))
                self.loop.call_soon_threadsafe(
                    self.message_queue.put_nowait,
                    ("instantActions", instant_actions),
                )
                print(f"SIM ({serial_number}): Queued instant actions")
        except Exception as exc:
            print(f"SIM ({serial_number}): Error processing message on {topic}: {exc}")
            traceback.print_exc()

    def connect(self):
        """Connect to the broker, establish the asyncio queue, and start MQTT I/O."""
        options = mqtt_utils.mqtt_create_opts()
        client_id_suffix = self.config.vehicle.serial_number.replace(" ", "_")
        self.client = mqtt.Client(
            callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
            client_id=f"{options['client_id']}-{client_id_suffix}",
            protocol=mqtt.MQTTv5,
        )
        self.client.on_connect = self.on_connect
        self.client.on_message = self.on_message

        connection_topic = f"{self.base_topic}/connection"
        last_will = Connection(
            header_id=0,
            timestamp=utils.get_timestamp(),
            version=self.config.vehicle.vda_full_version,
            manufacturer=self.config.vehicle.manufacturer,
            serial_number=self.config.vehicle.serial_number,
            connection_state=ConnectionState.CONNECTION_BROKEN,
        )
        self.client.will_set(
            topic=connection_topic,
            payload=json.dumps(last_will.to_dict()).encode("utf-8"),
            qos=1,
            retain=True,
        )

        self.loop = asyncio.get_running_loop()
        self.message_queue = asyncio.Queue()
        broker_host = self.config.mqtt_broker.host
        if broker_host.startswith("tcp://"):
            broker_host = broker_host[len("tcp://"):]
        broker_port = int(self.config.mqtt_broker.port)

        for attempt in range(3):
            try:
                self.client.connect(host=broker_host, port=broker_port)
                break
            except OSError as exc:
                if attempt == 2:
                    raise ConnectionError(
                        f"SIM ({self.config.vehicle.serial_number}): MQTT connect to "
                        f"{broker_host}:{broker_port} failed after 3 attempts. Last error: {exc}"
                    ) from exc
                print(
                    f"SIM ({self.config.vehicle.serial_number}): MQTT connect to "
                    f"{broker_host}:{broker_port} failed ({exc}). Retry {attempt + 1}/3 in 3s..."
                )
                time.sleep(3)

        self.client.loop_start()
        return self.client, self.message_queue
