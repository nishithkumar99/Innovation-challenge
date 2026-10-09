package de.smartcare.core;

import de.smartcare.core.engine.CoreEngine;
import de.smartcare.core.model.HospitalMap;
import de.smartcare.core.mqtt.LoopbackBroker;
import de.smartcare.core.settings.Settings;
import de.smartcare.core.sim.AmrSimulator;

import java.io.InputStream;
import java.util.concurrent.atomic.AtomicLong;

/** Core + built-in simulator + loopback MQTT + virtual clock: tests advance time explicitly and never sleep. */
public final class Rig {
    public final Settings cfg = new Settings();
    public final AtomicLong clock = new AtomicLong(1_000_000);
    public final LoopbackBroker broker = new LoopbackBroker();
    public final HospitalMap map;
    public final CoreEngine core;
    public final AmrSimulator sim;

    private long stepCount;

    public Rig() { this(5); }

    public Rig(int robots) { this(robots, null); }

    public Rig(int robots, java.util.function.Consumer<Settings> tweak) { this("/map/test-hospital.json", robots, tweak); }

    /** A rig on the shipped (organizers') map: 23 nodes, one vehicle per node. */
    public static Rig onSimulatorMap(int robots) {
        return new Rig("/map/hospital.json", robots, c -> { c.traffic.stationCapacityDefault = 1; c.sim.speedMps = 1.0; });
    }

    public Rig(String mapResource, int robots, java.util.function.Consumer<Settings> tweak) {
        cfg.sim.robots = robots;
        cfg.core.telemetryMs = 500;
        if (mapResource.contains("test-hospital")) cfg.sim.startNodes = "PH,LAB,CSSD,WC,WD,OR";   // node ids of the legacy test map
        if (tweak != null) tweak.accept(cfg);
        try (InputStream in = Rig.class.getResourceAsStream(mapResource)) {
            map = HospitalMap.load(in, cfg.traffic.stationCapacityDefault, cfg.map.width, cfg.map.height);
        } catch (Exception e) { throw new IllegalStateException(e); }
        core = new CoreEngine(map, cfg, clock::get, broker.gateway());
        sim = new AmrSimulator(map, cfg, broker.gateway());
        core.start();
        sim.start();
        advance(1);
    }

    /** Advances virtual time in 100 ms steps. */
    public void advance(double seconds) {
        int steps = (int) Math.round(seconds * 10);
        for (int i = 0; i < steps; i++) {
            clock.addAndGet(100);
            sim.tick(0.1);
            if (++stepCount % 2 == 0) core.tick();
        }
    }

    public boolean advanceUntil(double maxSeconds, java.util.function.BooleanSupplier cond) {
        int steps = (int) Math.round(maxSeconds * 10);
        for (int i = 0; i < steps; i++) { if (cond.getAsBoolean()) return true; advance(0.1); }
        return cond.getAsBoolean();
    }
}
