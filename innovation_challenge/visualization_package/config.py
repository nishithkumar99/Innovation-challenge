import tomli
import os
import math
from dataclasses import dataclass, field
from typing import Optional

@dataclass
class MqttBrokerConfig:
    host: str
    port: str
    vda_interface: str

@dataclass
class VehicleConfig:
    manufacturer: str
    serial_number: str
    vda_version: str
    vda_full_version: str
    collision_radius: float = 0.5

    def __post_init__(self):
        if not math.isfinite(self.collision_radius) or self.collision_radius <= 0:
            raise ValueError("Collision radius must be finite and greater than zero")

@dataclass
class Settings:
    action_time: float
    speed: float
    robot_count: int
    state_frequency: int
    visualization_frequency: int
    map_id: str
    floorplan_x: float
    floorplan_y: float
    background_image: str
    battery_consumption_per_meter: float
    battery_charging_rate_per_second: float
    battery_health_min: int
    battery_health_max: int
    collision_radii: dict[str, float] = field(default_factory=dict)
    spawn_x: float = 0.0
    spawn_y: float = 0.0
    spawn_offset_x: float = 1.5
    spawn_offset_y: float = 0.0

    def __post_init__(self):
        if self.floorplan_x <= 0 or self.floorplan_y <= 0:
            raise ValueError("Floorplan dimensions must be greater than zero")
        if self.battery_consumption_per_meter < 0:
            raise ValueError("Battery consumption per meter cannot be negative")
        if self.battery_charging_rate_per_second < 0:
            raise ValueError("Battery charging rate cannot be negative")
        if not 0 <= self.battery_health_min <= self.battery_health_max <= 100:
            raise ValueError("Battery health range must satisfy 0 <= min <= max <= 100")
        if any(not math.isfinite(radius) or radius <= 0 for radius in self.collision_radii.values()):
            raise ValueError("Collision radii must be finite and greater than zero")
        if not all(math.isfinite(value) for value in (
            self.spawn_x, self.spawn_y, self.spawn_offset_x, self.spawn_offset_y,
        )):
            raise ValueError("Spawn coordinates and offsets must be finite")

@dataclass
class Config:
    mqtt_broker: MqttBrokerConfig
    vehicle: VehicleConfig
    settings: Settings

def get_config() -> Config:
    """Load configuration from config.toml file"""
    with open("config.toml", "rb") as f:
        config_dict = tomli.load(f)

    # Environment overrides (fallback remains config.toml)
    mqtt_host = os.getenv("VDA_MQTT_HOST", config_dict["mqtt_broker"]["host"])
    mqtt_port = os.getenv("VDA_MQTT_PORT", str(config_dict["mqtt_broker"]["port"]))
    vda_interface = os.getenv("VDA_INTERFACE", config_dict["mqtt_broker"]["vda_interface"])
    speed = float(os.getenv("VDA_SPEED", str(config_dict["settings"]["speed"])))
    robot_count = int(os.getenv("VDA_ROBOT_COUNT", str(config_dict["settings"]["robot_count"])))

    config_dict["mqtt_broker"]["host"] = mqtt_host
    config_dict["mqtt_broker"]["port"] = str(mqtt_port)
    config_dict["mqtt_broker"]["vda_interface"] = vda_interface
    config_dict["settings"]["speed"] = speed
    config_dict["settings"]["robot_count"] = robot_count
    
    mqtt_broker = MqttBrokerConfig(**config_dict["mqtt_broker"])
    vehicle = VehicleConfig(**config_dict["vehicle"])
    settings = Settings(**config_dict["settings"])
    
    return Config(mqtt_broker=mqtt_broker, vehicle=vehicle, settings=settings)