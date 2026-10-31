package com.sailer.agenticos.agenticnetgateway.tenant;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sailer.agenticos.agenticnetgateway.config.GatewayProperties;
import com.sailer.agenticos.agenticnetgateway.config.ServiceAuth;
import org.springframework.http.HttpHeaders;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

import java.util.ArrayList;
import java.util.List;

/** Reads which models exist, so the gateway can enforce a tenant's model quota before a create. */
@Component
public class TenantModelDirectory {

    private final RestClient node;
    private final ObjectMapper mapper = new ObjectMapper();

    public TenantModelDirectory(GatewayProperties props) {
        this.node = RestClient.builder().baseUrl(props.getNodeUrl()).build();
    }

    /** The ids of the tenant's existing models. Throws when the node cannot answer (callers fail closed). */
    public List<String> modelsOf(String tenant) {
        List<String> out = new ArrayList<>();
        for (JsonNode m : modelEntriesOf(tenant)) out.add(m.path("modelId").asText());
        return out;
    }

    /** The node's model entries (the same objects master and node list) for the tenant's models only. */
    public List<JsonNode> modelEntriesOf(String tenant) {
        HttpHeaders headers = new HttpHeaders();
        ServiceAuth.apply(headers);
        byte[] body = node.get().uri("/api/admin/models").headers(h -> h.addAll(headers)).retrieve().body(byte[].class);
        List<JsonNode> out = new ArrayList<>();
        try {
            JsonNode list = mapper.readTree(body);
            if (list != null && list.isArray()) {
                for (JsonNode m : list) {
                    if (TenantKeys.ownsModel(tenant, m.path("modelId").asText(null))) out.add(m);
                }
            }
        } catch (Exception e) {
            throw new IllegalStateException("model list unreadable: " + e.getMessage(), e);
        }
        return out;
    }
}
