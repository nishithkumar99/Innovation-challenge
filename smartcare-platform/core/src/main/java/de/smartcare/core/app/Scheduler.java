package de.smartcare.core.app;

import de.smartcare.core.engine.CoreEngine;
import de.smartcare.core.sim.AmrSimulator;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/** Drives the control loop and the built-in simulator. Exceptions are logged and never stop the loop. */
@Component
public class Scheduler {
    private static final Logger log = LoggerFactory.getLogger(Scheduler.class);
    @Autowired(required = false) private CoreEngine core;
    @Autowired(required = false) private AmrSimulator sim;
    private long lastSim = System.nanoTime();

    @Scheduled(fixedDelayString = "${smartcare.core.tick-ms:250}")
    public void coreTick() {
        if (core == null) return;
        try { core.tick(); } catch (RuntimeException e) { log.error("core tick failed", e); }
    }

    @Scheduled(fixedDelay = 100)
    public void simTick() {
        if (sim == null) return;
        long now = System.nanoTime();
        double dt = Math.min(0.5, (now - lastSim) / 1e9);
        lastSim = now;
        try { sim.tick(dt); } catch (RuntimeException e) { log.error("simulator tick failed", e); }
    }
}
