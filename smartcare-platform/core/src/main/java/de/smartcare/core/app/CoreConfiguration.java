package de.smartcare.core.app;

import de.smartcare.core.api.Api;
import de.smartcare.core.engine.CoreEngine;
import de.smartcare.core.model.HospitalMap;
import de.smartcare.core.mqtt.LoopbackBroker;
import de.smartcare.core.mqtt.MqttGateway;
import de.smartcare.core.mqtt.PahoMqttGateway;
import de.smartcare.core.settings.Settings;
import de.smartcare.core.settings.SettingsBinder;
import de.smartcare.core.sim.AmrSimulator;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.env.Environment;
import org.springframework.core.io.DefaultResourceLoader;
import org.springframework.core.io.Resource;

import java.io.InputStream;

/** Wires the framework-free domain classes into the Spring context. */
@Configuration
public class CoreConfiguration {
    private static final Logger log = LoggerFactory.getLogger(CoreConfiguration.class);

    @Bean
    public Settings settings(Environment env) {
        Settings s = SettingsBinder.bind(env::getProperty);
        log.info("MQTT mode={} host={}:{} interface={}/{} | core.enabled={} sim.enabled={} (robots={})",
                s.mqtt.mode, s.mqtt.host, s.mqtt.port, s.mqtt.interfaceName, s.mqtt.majorVersion, s.core.enabled, s.sim.enabled, s.sim.robots);
        return s;
    }

    @Bean
    public HospitalMap hospitalMap(Settings s) throws Exception {
        Resource r = new DefaultResourceLoader().getResource(s.map.file.startsWith("classpath:") || s.map.file.startsWith("file:") ? s.map.file : "file:" + s.map.file);
        try (InputStream in = r.getInputStream()) { return HospitalMap.load(in, s.traffic.stationCapacityDefault, s.map.width, s.map.height); }
    }

    /** Shared in-process broker, only used in INTERNAL mode. */
    @Bean
    public LoopbackBroker loopbackBroker() { return new LoopbackBroker(); }

    @Bean(name = "coreMqtt", destroyMethod = "close")
    @ConditionalOnProperty(name = "smartcare.core.enabled", havingValue = "true", matchIfMissing = true)
    public MqttGateway coreMqtt(Settings s, LoopbackBroker broker) throws Exception {
        MqttGateway g = gateway(s, broker, s.mqtt.clientId);
        g.start();
        return g;
    }

    @Bean(name = "simMqtt", destroyMethod = "close")
    @ConditionalOnProperty(name = "smartcare.sim.enabled", havingValue = "true", matchIfMissing = true)
    public MqttGateway simMqtt(Settings s, LoopbackBroker broker) throws Exception {
        MqttGateway g = gateway(s, broker, s.mqtt.clientId + "-sim");
        g.start();
        return g;
    }

    private static MqttGateway gateway(Settings s, LoopbackBroker broker, String clientId) {
        if ("BROKER".equalsIgnoreCase(s.mqtt.mode)) return new PahoMqttGateway(s.mqtt.host, s.mqtt.port, clientId, s.mqtt.username, s.mqtt.password);
        return broker.gateway();
    }

    @Bean
    @ConditionalOnProperty(name = "smartcare.core.enabled", havingValue = "true", matchIfMissing = true)
    public CoreEngine coreEngine(Settings s, HospitalMap map, @Qualifier("coreMqtt") MqttGateway mqtt) {
        CoreEngine e = new CoreEngine(map, s, System::currentTimeMillis, mqtt);
        e.start();
        return e;
    }

    @Bean
    @ConditionalOnProperty(name = "smartcare.core.enabled", havingValue = "true", matchIfMissing = true)
    public Api api(CoreEngine engine) { return new Api(engine); }

    @Bean
    @ConditionalOnProperty(name = "smartcare.sim.enabled", havingValue = "true", matchIfMissing = true)
    public AmrSimulator simulator(Settings s, HospitalMap map, @Qualifier("simMqtt") MqttGateway mqtt) {
        AmrSimulator sim = new AmrSimulator(map, s, mqtt);
        sim.start();
        log.info("Built-in VDA 5050 simulator started with {} vehicles", s.sim.robots);
        return sim;
    }
}
