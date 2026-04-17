package com.sailer.agenticos.agenticnetvault.rest;

import com.sailer.agenticos.agenticnetvault.service.VersionService;
import com.sailer.agenticos.agenticnetvault.service.VersionService.VersionReadException;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@WebMvcTest(VersionController.class)
class VersionControllerTest {

    @Autowired
    private MockMvc mockMvc;

    @MockitoBean
    private VersionService versionService;

    @Test
    void version_returnsOkWithPlainTextVersion() throws Exception {
        when(versionService.readVersion()).thenReturn("0.0.1-SNAPSHOT");

        mockMvc.perform(get("/version"))
            .andExpect(status().isOk())
            .andExpect(content().contentTypeCompatibleWith(MediaType.TEXT_PLAIN))
            .andExpect(content().string("0.0.1-SNAPSHOT"));
    }

    @Test
    void version_returnsInternalServerErrorWhenPomCannotBeRead() throws Exception {
        when(versionService.readVersion())
            .thenThrow(new VersionReadException("pom.xml not found"));

        mockMvc.perform(get("/version"))
            .andExpect(status().isInternalServerError())
            .andExpect(content().contentTypeCompatibleWith(MediaType.TEXT_PLAIN))
            .andExpect(content().string("Unable to read version"));
    }
}
