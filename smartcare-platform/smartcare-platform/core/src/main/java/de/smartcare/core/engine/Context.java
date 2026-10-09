package de.smartcare.core.engine;

import de.smartcare.core.event.EventBus;
import de.smartcare.core.fleet.FleetRegistry;
import de.smartcare.core.fleet.Robot;
import de.smartcare.core.model.HospitalMap;
import de.smartcare.core.mqtt.MqttGateway;
import de.smartcare.core.routing.Router;
import de.smartcare.core.settings.Settings;
import de.smartcare.core.task.Task;
import de.smartcare.core.traffic.ReservationTable;
import de.smartcare.core.vda.*;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.LongSupplier;

/** Shared state of the core. Everything in here is only touched while holding the {@link CoreEngine} lock. */
public final class Context {
    public final HospitalMap map;
    public final Settings cfg;
    public final LongSupplier clock;
    public final Router router;
    public final FleetRegistry fleet = new FleetRegistry();
    public final Map<String, Task> tasks = new LinkedHashMap<>();
    public final EventBus bus;
    public final ReservationTable reservations;
    public final MqttGateway mqtt;
    public final Topics topics;
    public final Codec codec = new Codec();
    public final OrderFactory orders;
    /** Non-null in order mode STEPWISE: splits the core's base/horizon orders into stretches the vehicle accepts. */
    public final SegmentedOrders segmented;

    // operator-controlled system state
    public String mode = "AUTO";
    public boolean hold;
    public String notice;
    public boolean aiAvailable = true;

    public Context(HospitalMap map, Settings cfg, LongSupplier clock, MqttGateway mqtt) {
        this.map = map; this.cfg = cfg; this.clock = clock; this.mqtt = mqtt;
        this.router = new Router(map, cfg.sim.speedMps);
        this.bus = new EventBus(clock);
        this.reservations = new ReservationTable(map, cfg.traffic.physicalClearanceM);
        this.topics = new Topics(cfg.mqtt.interfaceName, cfg.mqtt.majorVersion);
        this.orders = new OrderFactory(map, cfg.mqtt.mapId);
        this.segmented = "STEPWISE".equalsIgnoreCase(cfg.mqtt.orderMode)
                ? new SegmentedOrders((m, s, o) -> mqtt.publish(topics.order(m, s), codec.toJson(o), cfg.mqtt.orderQos, false), clock)
                : null;
        this.router.setAvoidChargersAsVia(cfg.traffic.avoidChargersAsVia);
    }

    public long now() { return clock.getAsLong(); }

    /** Nodes on which other vehicles stand right now. Routes avoid them where there is a way around. */
    public java.util.Set<String> standingNodes(Robot except) {
        java.util.Set<String> s = new java.util.HashSet<>();
        for (Robot o : fleet.all()) if (o != except && o.online) { String n = occupiedNode(o); if (n != null) s.add(n); }
        return s;
    }

    /**
     * The node a vehicle physically occupies, or null if it is not (yet) on one. A vehicle that was only snapped to the nearest
     * node (start-up positions, a cancelled order) does not block that node for others.
     */
    public String occupiedNode(Robot r) {
        if (r.lastNodeId == null) return null;
        var n = map.node(r.lastNodeId);
        return n != null && Math.hypot(n.x() - r.x, n.y() - r.y) <= cfg.core.homeToleranceM ? r.lastNodeId : null;
    }

    public void sendOrder(Robot r, Messages.Order o) {
        if (segmented != null) { segmented.submit(r.manufacturer, r.serial, o); return; }
        mqtt.publish(topics.order(r.manufacturer, r.serial), codec.toJson(o), cfg.mqtt.orderQos, false);
    }

    public void sendInstant(Robot r, Messages.Action... actions) {
        if (segmented != null) {
            java.util.List<Messages.Action> forward = new java.util.ArrayList<>();
            for (Messages.Action a : actions) if (segmented.instantAction(r.serial, a)) forward.add(a);
            if (forward.isEmpty()) return;
            actions = forward.toArray(new Messages.Action[0]);
        }
        mqtt.publish(topics.instantActions(r.manufacturer, r.serial), codec.toJson(orders.instant(r.manufacturer, r.serial, actions)), cfg.mqtt.instantActionQos, false);
    }
}
