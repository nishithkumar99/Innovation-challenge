package de.smartcare.core.app;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableScheduling;

/** SmartCareLogistics core: task dispatching, traffic, energy and anomaly management for a VDA 5050 AMR fleet. */
@SpringBootApplication(scanBasePackages = "de.smartcare.core.app")
@EnableScheduling
public class SmartCareApplication {
    public static void main(String[] args) { SpringApplication.run(SmartCareApplication.class, args); }
}
