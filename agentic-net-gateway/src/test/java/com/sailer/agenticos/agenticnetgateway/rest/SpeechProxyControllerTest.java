package com.sailer.agenticos.agenticnetgateway.rest;

import com.github.tomakehurst.wiremock.WireMockServer;
import com.sailer.agenticos.agenticnetgateway.config.GatewayProperties;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestInstance;
import org.springframework.http.ResponseEntity;
import org.springframework.mock.web.MockHttpServletRequest;

import java.nio.charset.StandardCharsets;

import static com.github.tomakehurst.wiremock.client.WireMock.aResponse;
import static com.github.tomakehurst.wiremock.client.WireMock.absent;
import static com.github.tomakehurst.wiremock.client.WireMock.equalTo;
import static com.github.tomakehurst.wiremock.client.WireMock.post;
import static com.github.tomakehurst.wiremock.client.WireMock.postRequestedFor;
import static com.github.tomakehurst.wiremock.client.WireMock.urlEqualTo;
import static org.assertj.core.api.Assertions.assertThat;

/**
 * The optional speech route: {@code /speech-api/**} goes to the local speech service as is
 * (no {@code /api} prefix, the bridge has none), the JWT is stripped (the service is local), the
 * audio comes back untouched, and without a configured URL the route says so with 503.
 */
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class SpeechProxyControllerTest {

    private WireMockServer speech;

    @BeforeAll
    void start() {
        speech = new WireMockServer(0);
        speech.start();
    }

    @AfterAll
    void stop() {
        if (speech != null) speech.stop();
    }

    private static MockHttpServletRequest req(String method, String uri, String contentType) {
        MockHttpServletRequest r = new MockHttpServletRequest();
        r.setMethod(method);
        r.setRequestURI(uri);
        if (contentType != null) r.setContentType(contentType);
        return r;
    }

    @Test
    void withoutAConfiguredServiceTheRouteAnswers503AndNamesTheSetting() {
        SpeechProxyController controller = new SpeechProxyController(new GatewayProperties());
        ResponseEntity<byte[]> resp = controller.proxyRest(req("POST", "/speech-api/transcribe", "multipart/form-data"), new byte[] {1});
        assertThat(resp.getStatusCode().value()).isEqualTo(503);
        assertThat(new String(resp.getBody(), StandardCharsets.UTF_8)).contains("SPEECH_URL");
    }

    @Test
    void forwardsToTheServiceWithoutTheApiPrefixOrTheToken_andReturnsTheAudioAsIs() {
        GatewayProperties props = new GatewayProperties();
        props.setSpeechUrl("http://localhost:" + speech.port());
        SpeechProxyController controller = new SpeechProxyController(props);
        byte[] wav = "RIFF....WAVE".getBytes(StandardCharsets.UTF_8);
        speech.stubFor(post(urlEqualTo("/speak")).willReturn(aResponse().withStatus(200).withHeader("Content-Type", "audio/wav").withBody(wav)));

        MockHttpServletRequest request = req("POST", "/speech-api/speak", "application/json");
        request.addHeader("Authorization", "Bearer secret");
        ResponseEntity<byte[]> resp = controller.proxyRest(request, "{\"text\":\"hello\"}".getBytes(StandardCharsets.UTF_8));

        assertThat(resp.getStatusCode().value()).isEqualTo(200);
        assertThat(resp.getHeaders().getFirst("Content-Type")).isEqualTo("audio/wav");
        assertThat(resp.getBody()).isEqualTo(wav);
        speech.verify(postRequestedFor(urlEqualTo("/speak"))
                .withHeader("Authorization", absent())
                .withHeader("Content-Type", equalTo("application/json")));
    }
}
