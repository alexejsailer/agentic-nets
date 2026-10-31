package com.sailer.agenticos.agenticnetgateway.tenant;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * The fence through the real filter chain: keys minted at {@code /oauth2/token}, bearer tokens on
 * proxied routes. Backends point at a closed port, so a request the fence lets through is handed
 * to the proxy (an async dispatch or a 502), and a refused one ends in 403/401 before any proxying.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.MOCK)
@AutoConfigureMockMvc
class TenantFenceIntegrationTest {

    private static final Path KEY_DIR;
    /** A stand-in node that only knows the model list: alice has two models, bob one, the operator one. */
    private static final com.sun.net.httpserver.HttpServer NODE;

    static {
        try {
            KEY_DIR = Files.createTempDirectory("gw-tenancy");
            NODE = com.sun.net.httpserver.HttpServer.create(new java.net.InetSocketAddress("127.0.0.1", 0), 0);
            NODE.createContext("/", ex -> {
                byte[] out = ex.getRequestURI().getPath().equals("/api/admin/models")
                        ? ("[{\"modelId\":\"alice-notes\",\"name\":\"a\"},{\"modelId\":\"alice-two\",\"name\":\"a2\"},"
                        + "{\"modelId\":\"bob-notes\",\"name\":\"b\"},{\"modelId\":\"default\",\"name\":\"d\"}]").getBytes()
                        : "{}".getBytes();
                int code = ex.getRequestURI().getPath().equals("/api/admin/models") ? 200 : 404;
                ex.getResponseHeaders().add("Content-Type", "application/json");
                ex.sendResponseHeaders(code, out.length);
                ex.getResponseBody().write(out);
                ex.close();
            });
            NODE.start();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry r) {
        r.add("gateway.jwt-key-dir", KEY_DIR::toString);
        r.add("gateway.client-secret", () -> "operator-secret");
        r.add("gateway.master-url", () -> "http://127.0.0.1:1");
        r.add("gateway.node-url", () -> "http://127.0.0.1:" + NODE.getAddress().getPort());
        r.add("gateway.tenancy.enabled", () -> "true");
        r.add("gateway.tenancy.signup", () -> "invite");
        r.add("gateway.tenancy.invite-codes", () -> "let-me-in");
        r.add("gateway.rate-limit-per-minute", () -> "1000");
        r.add("otel.sdk.disabled", () -> "true");
    }

    @Autowired
    MockMvc mvc;
    @Autowired
    TenantRegistry registry;

    private final ObjectMapper mapper = new ObjectMapper();
    private String aliceKey;
    private String bobKey;

    @BeforeEach
    void tenants() {
        registry.remove("alice");
        registry.remove("bob");
        aliceKey = registry.create("alice", "test", 2, 1000).key();
        bobKey = registry.create("bob", "test", 2, 1000).key();
    }

    private String token(String key) throws Exception {
        MvcResult res = mvc.perform(post("/oauth2/token").contentType(MediaType.APPLICATION_FORM_URLENCODED)
                        .param("grant_type", "client_credentials").param("client_secret", key))
                .andExpect(status().isOk()).andReturn();
        return mapper.readTree(res.getResponse().getContentAsString()).get("access_token").asText();
    }

    private static void assertPassed(int status) {
        assertThat(status).as("passed the fence").isNotIn(401, 403, 413, 415, 429);
    }

    private int getStatus(String bearer, String path) throws Exception {
        return mvc.perform(get(path).header("Authorization", "Bearer " + bearer)).andReturn().getResponse().getStatus();
    }

    private int postStatus(String bearer, String path, String json) throws Exception {
        return mvc.perform(post(path).header("Authorization", "Bearer " + bearer)
                .contentType(MediaType.APPLICATION_JSON).content(json)).andReturn().getResponse().getStatus();
    }

    @Test
    void aTenantKeyMintsATenantTokenWithoutAClientId() throws Exception {
        MvcResult res = mvc.perform(post("/oauth2/token").contentType(MediaType.APPLICATION_FORM_URLENCODED)
                        .param("grant_type", "client_credentials").param("client_secret", aliceKey))
                .andExpect(status().isOk()).andReturn();
        JsonNode body = mapper.readTree(res.getResponse().getContentAsString());
        assertThat(body.get("scope").asText()).isEqualTo("agenticos tenant");
        mvc.perform(post("/oauth2/token").contentType(MediaType.APPLICATION_FORM_URLENCODED)
                        .param("grant_type", "client_credentials").param("client_secret", aliceKey + "x"))
                .andExpect(status().isUnauthorized());
    }

    @Test
    void eachTenantReachesItsOwnModelsAndNeverTheOther() throws Exception {
        String alice = token(aliceKey);
        String bob = token(bobKey);
        // Allowed requests pass the fence and fail at the (closed) backend with 502.
        assertPassed(getStatus(alice, "/api/explorer/alice-notes/catalogue"));
        assertPassed(getStatus(bob, "/api/explorer/bob-notes/catalogue"));
        assertThat(getStatus(alice, "/api/explorer/bob-notes/catalogue")).isEqualTo(403);
        assertThat(getStatus(bob, "/api/explorer/alice-notes/catalogue")).isEqualTo(403);
        assertThat(getStatus(alice, "/node-api/models/bob-notes/tree")).isEqualTo(403);
        assertThat(postStatus(alice, "/node-api/events/execute/bob-notes", "{\"events\":[]}")).isEqualTo(403);
        assertThat(postStatus(alice, "/api/transitions/t/start", "{\"modelId\":\"bob-notes\"}")).isEqualTo(403);
        assertThat(getStatus(alice, "/vault-api/credentials")).isEqualTo(403);
        assertThat(getStatus(alice, "/api/tenants")).isEqualTo(403);
        assertThat(getStatus(alice, "/api/hub/remotes")).isEqualTo(403);
    }

    @Test
    void aRotatedKeyOrADisabledTenantStopsAtTheNextRequest() throws Exception {
        String alice = token(aliceKey);
        assertPassed(getStatus(alice, "/api/explorer/alice-notes/catalogue"));
        registry.rotate("alice");
        assertThat(getStatus(alice, "/api/explorer/alice-notes/catalogue")).isEqualTo(401);
        String bob = token(bobKey);
        registry.setDisabled("bob", true);
        assertThat(getStatus(bob, "/api/explorer/bob-notes/catalogue")).isEqualTo(401);
        mvc.perform(post("/oauth2/token").contentType(MediaType.APPLICATION_FORM_URLENCODED)
                        .param("grant_type", "client_credentials").param("client_secret", bobKey))
                .andExpect(status().isUnauthorized());
    }

    @Test
    void anUnknownScopeIsNoLongerAdmin() throws Exception {
        mvc.perform(get("/api/explorer/m/catalogue").with(jwt().jwt(t -> t.claim("scope", "agenticos something"))))
                .andExpect(status().isForbidden());
        mvc.perform(get("/api/explorer/m/catalogue").with(jwt().jwt(t -> t.claim("scope", "agenticos tenant"))))
                .andExpect(status().isForbidden());
    }

    @Test
    void theOperatorIssuesKeysAndExecutorKeys() throws Exception {
        MvcResult created = mvc.perform(post("/api/tenants").with(jwt().jwt(t -> t.claim("scope", "agenticos admin")))
                        .contentType(MediaType.APPLICATION_JSON).content("{\"tenant\":\"carol\",\"modelsMax\":3}"))
                .andExpect(status().isCreated()).andReturn();
        JsonNode body = mapper.readTree(created.getResponse().getContentAsString());
        assertThat(body.get("key").asText()).startsWith("ant_carol_");
        assertThat(body.get("modelPrefix").asText()).isEqualTo("carol-");
        assertThat(token(body.get("key").asText())).isNotBlank();

        MvcResult exec = mvc.perform(post("/api/tenants/carol/executors").with(jwt().jwt(t -> t.claim("scope", "agenticos admin")))
                        .contentType(MediaType.APPLICATION_JSON).content("{\"name\":\"box\"}"))
                .andExpect(status().isOk()).andReturn();
        String execKey = mapper.readTree(exec.getResponse().getContentAsString()).get("executorKey").asText();
        String execToken = token(execKey);
        assertPassed(getStatus(execToken, "/api/transitions/poll?modelId=carol-a&executorId=carol-box"));
        assertThat(getStatus(execToken, "/api/transitions/poll?modelId=alice-a&executorId=carol-box")).isEqualTo(403);
        assertThat(getStatus(execToken, "/api/explorer/carol-a/catalogue")).isEqualTo(403);
        registry.remove("carol");
    }

    @Test
    void signUpNeedsTheInviteCode() throws Exception {
        mvc.perform(get("/oauth2/tenancy")).andExpect(status().isOk());
        mvc.perform(post("/oauth2/register").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"tenant\":\"dave\",\"inviteCode\":\"wrong\"}"))
                .andExpect(status().isForbidden());
        MvcResult ok = mvc.perform(post("/oauth2/register").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"tenant\":\"dave\",\"inviteCode\":\"let-me-in\"}"))
                .andExpect(status().isCreated()).andReturn();
        assertThat(mapper.readTree(ok.getResponse().getContentAsString()).get("key").asText()).startsWith("ant_dave_");
        mvc.perform(post("/oauth2/register").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"tenant\":\"dave\",\"inviteCode\":\"let-me-in\"}"))
                .andExpect(status().isConflict());
        registry.remove("dave");
    }

    @Test
    void modelListsShowOnlyTheTenantsOwnModels() throws Exception {
        String alice = token(aliceKey);
        for (String path : new String[]{"/api/admin/models", "/node-api/admin/models"}) {
            MvcResult res = mvc.perform(get(path).header("Authorization", "Bearer " + alice)).andExpect(status().isOk()).andReturn();
            JsonNode list = mapper.readTree(res.getResponse().getContentAsString());
            assertThat(list).hasSize(2);
            list.forEach(m -> assertThat(m.get("modelId").asText()).startsWith("alice-"));
        }
        MvcResult bob = mvc.perform(get("/api/admin/models").header("Authorization", "Bearer " + token(bobKey)))
                .andExpect(status().isOk()).andReturn();
        assertThat(mapper.readTree(bob.getResponse().getContentAsString())).hasSize(1);
    }

    @Test
    void theModelQuotaIsCheckedBeforeACreate() throws Exception {
        String alice = token(aliceKey);   // modelsMax 2, and alice already has two
        assertThat(postStatus(alice, "/node-api/admin/models", "{\"modelId\":\"alice-new\",\"name\":\"n\"}")).isEqualTo(403);
        // Naming an existing model is not a new one (the backend answers that it exists).
        assertPassed(postStatus(alice, "/node-api/admin/models", "{\"modelId\":\"alice-notes\",\"name\":\"n\"}"));
        String bob = token(bobKey);       // one of two used
        assertPassed(postStatus(bob, "/api/admin/models", "{\"modelId\":\"bob-new\",\"name\":\"n\"}"));
        assertThat(postStatus(bob, "/api/admin/models", "{\"modelId\":\"alice-new\",\"name\":\"n\"}")).isEqualTo(403);
    }
}
