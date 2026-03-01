package com.sailer.agenticos.agenticnetexecutor.config;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.sailer.agenticos.agenticnetexecutor.service.MasterPollingService;
import com.sailer.agenticos.agenticnetexecutor.transition.TransitionStore;
import com.sailer.agenticos.agenticnetexecutor.transition.command.CommandActionExecutor;
import com.sailer.agenticos.agenticnetexecutor.transition.runtime.TransitionActionExecutor;
import com.sailer.agenticos.agenticnetexecutor.transition.service.ConsumptionService;
import com.sailer.agenticos.agenticnetexecutor.transition.service.EmissionService;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class TransitionConfiguration {

    @Bean
    public TransitionStore transitionStore() {
        return new TransitionStore();
    }

    // ❌ REMOVED: TransitionRemoteClient bean - executor no longer calls agentic-net-node directly
    // ❌ REMOVED: ReservationService bean - reservations now handled by master

    @Bean
    public EmissionService emissionService(ObjectMapper objectMapper,
                                           MasterPollingService masterPollingService) {
        return new EmissionService(objectMapper, masterPollingService);
    }

    @Bean
    public ConsumptionService consumptionService(MasterPollingService masterPollingService) {
        return new ConsumptionService(masterPollingService);
    }

    @Bean
    public TransitionActionExecutor transitionActionExecutor(ObjectMapper objectMapper,
                                                              CommandActionExecutor commandActionExecutor) {
        return new TransitionActionExecutor(objectMapper, commandActionExecutor);
    }
}
