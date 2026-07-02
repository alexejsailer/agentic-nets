package com.sailer.agenticos.agenticnetexecutor.transition.command;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.TextNode;
import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Hermetic unit tests for {@link CommandToken} — a pure value type with real branching in its
 * accessors ({@code getMetaAsMap}, {@code getBlobStoreHost/IdStrategy}, {@code getOutputFile},
 * {@code getPriority}) and its {@code isValid} contract. No collaborators, no I/O.
 */
class CommandTokenTest {

    private final ObjectMapper mapper = new ObjectMapper();

    private JsonNode json(String raw) {
        try {
            return mapper.readTree(raw);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    private CommandToken token(String kind, String id, String executor, String command,
                               JsonNode args, String expect, JsonNode meta, String resultAs, JsonNode blobStore) {
        return new CommandToken(kind, id, executor, command, args, expect, meta, resultAs, blobStore);
    }

    private CommandToken minimal() {
        return token(null, "cmd-1", "bash", "exec", null, null, null, null, null);
    }

    // ---- constructor defaults & null-guards --------------------------------

    @Test
    void constructor_appliesDefaults_forNullOptionalFields() {
        CommandToken t = minimal();
        assertThat(t.kind()).isEqualTo("command");
        assertThat(t.expect()).isEqualTo("json");
        assertThat(t.resultAs()).isEqualTo("inline");
    }

    @Test
    void constructor_rejectsNullRequiredFields() {
        assertThatThrownBy(() -> token(null, null, "bash", "exec", null, null, null, null, null))
                .isInstanceOf(NullPointerException.class);
        assertThatThrownBy(() -> token(null, "id", null, "exec", null, null, null, null, null))
                .isInstanceOf(NullPointerException.class);
        assertThatThrownBy(() -> token(null, "id", "bash", null, null, null, null, null, null))
                .isInstanceOf(NullPointerException.class);
    }

    // ---- isValid -----------------------------------------------------------

    @Test
    void isValid_trueForWellFormedCommandToken() {
        assertThat(minimal().isValid()).isTrue();
    }

    @Test
    void isValid_falseWhenKindIsNotCommand() {
        assertThat(token("task", "cmd-1", "bash", "exec", null, null, null, null, null).isValid()).isFalse();
    }

    @Test
    void isValid_falseForBlankIdExecutorOrCommand() {
        // requireNonNull permits blank strings; isValid must still reject them
        assertThat(token(null, "  ", "bash", "exec", null, null, null, null, null).isValid()).isFalse();
        assertThat(token(null, "cmd-1", "", "exec", null, null, null, null, null).isValid()).isFalse();
        assertThat(token(null, "cmd-1", "bash", "  ", null, null, null, null, null).isValid()).isFalse();
    }

    // ---- getMetaAsMap ------------------------------------------------------

    @Test
    void getMetaAsMap_nullMeta_returnsEmpty() {
        assertThat(minimal().getMetaAsMap()).isEmpty();
    }

    @Test
    void getMetaAsMap_objectMeta_convertedToMap() {
        JsonNode meta = json("{\"correlationId\":\"abc-123\",\"priority\":2}");
        Map<String, Object> map = token(null, "id", "bash", "exec", null, null, meta, null, null).getMetaAsMap();
        assertThat(map).containsEntry("correlationId", "abc-123").containsEntry("priority", 2);
    }

    @Test
    void getMetaAsMap_stringifiedJsonMeta_isParsed() {
        JsonNode meta = TextNode.valueOf("{\"correlationId\":\"c-9\"}");
        Map<String, Object> map = token(null, "id", "bash", "exec", null, null, meta, null, null).getMetaAsMap();
        assertThat(map).containsEntry("correlationId", "c-9");
    }

    @Test
    void getMetaAsMap_plainTextMeta_returnsEmpty() {
        JsonNode meta = TextNode.valueOf("just a note");
        assertThat(token(null, "id", "bash", "exec", null, null, meta, null, null).getMetaAsMap()).isEmpty();
    }

    @Test
    void getMetaAsMap_invalidStringifiedJson_returnsEmpty() {
        JsonNode meta = TextNode.valueOf("{not valid json");
        assertThat(token(null, "id", "bash", "exec", null, null, meta, null, null).getMetaAsMap()).isEmpty();
    }

    @Test
    void getMetaAsMap_nonObjectNonTextMeta_returnsEmpty() {
        JsonNode meta = mapper.getNodeFactory().numberNode(42);
        assertThat(token(null, "id", "bash", "exec", null, null, meta, null, null).getMetaAsMap()).isEmpty();
    }

    // ---- getMetaValue / getCorrelationId / getPriority ---------------------

    @Test
    void getCorrelationId_readsFromMeta_nullWhenAbsent() {
        JsonNode meta = json("{\"correlationId\":\"corr-7\"}");
        assertThat(token(null, "id", "bash", "exec", null, null, meta, null, null).getCorrelationId())
                .isEqualTo("corr-7");
        assertThat(minimal().getCorrelationId()).isNull();
    }

    @Test
    void getPriority_numericMeta_returnsIntValue() {
        JsonNode meta = json("{\"priority\":5}");
        assertThat(token(null, "id", "bash", "exec", null, null, meta, null, null).getPriority()).isEqualTo(5);
    }

    @Test
    void getPriority_defaultsToZero_whenMissingOrNonNumeric() {
        assertThat(minimal().getPriority()).isZero();
        JsonNode meta = json("{\"priority\":\"high\"}");
        assertThat(token(null, "id", "bash", "exec", null, null, meta, null, null).getPriority()).isZero();
    }

    // ---- isBinaryUrn -------------------------------------------------------

    @Test
    void isBinaryUrn_trueOnlyForBinaryUrnResultAs_caseInsensitive() {
        assertThat(token(null, "id", "bash", "exec", null, null, null, "binaryUrn", null).isBinaryUrn()).isTrue();
        assertThat(token(null, "id", "bash", "exec", null, null, null, "BINARYURN", null).isBinaryUrn()).isTrue();
        assertThat(minimal().isBinaryUrn()).isFalse(); // defaults to "inline"
    }

    // ---- getBlobStoreHost --------------------------------------------------

    @Test
    void getBlobStoreHost_nullWhenNoBlobStore() {
        assertThat(minimal().getBlobStoreHost()).isNull();
    }

    @Test
    void getBlobStoreHost_textualBlobStore_returnedAsHost() {
        JsonNode bs = TextNode.valueOf("http://localhost:8095");
        assertThat(token(null, "id", "bash", "exec", null, null, null, null, bs).getBlobStoreHost())
                .isEqualTo("http://localhost:8095");
    }

    @Test
    void getBlobStoreHost_objectWithHost_returnsHost_orNullWhenAbsent() {
        JsonNode withHost = json("{\"host\":\"http://blob:9000\",\"idStrategy\":\"uuid\"}");
        assertThat(token(null, "id", "bash", "exec", null, null, null, null, withHost).getBlobStoreHost())
                .isEqualTo("http://blob:9000");
        JsonNode noHost = json("{\"idStrategy\":\"uuid\"}");
        assertThat(token(null, "id", "bash", "exec", null, null, null, null, noHost).getBlobStoreHost()).isNull();
    }

    // ---- getBlobStoreIdStrategy --------------------------------------------

    @Test
    void getBlobStoreIdStrategy_defaultsToTimestamp() {
        assertThat(minimal().getBlobStoreIdStrategy()).isEqualTo("timestamp");
        JsonNode noStrategy = json("{\"host\":\"h\"}");
        assertThat(token(null, "id", "bash", "exec", null, null, null, null, noStrategy).getBlobStoreIdStrategy())
                .isEqualTo("timestamp");
    }

    @Test
    void getBlobStoreIdStrategy_readsExplicitStrategy() {
        JsonNode bs = json("{\"idStrategy\":\"uuid\"}");
        assertThat(token(null, "id", "bash", "exec", null, null, null, null, bs).getBlobStoreIdStrategy())
                .isEqualTo("uuid");
    }

    // ---- getOutputFile -----------------------------------------------------

    @Test
    void getOutputFile_nullWhenNoArgs() {
        assertThat(minimal().getOutputFile()).isNull();
    }

    @Test
    void getOutputFile_fromObjectArgs() {
        JsonNode args = json("{\"outputFile\":\"out.pdf\",\"command\":\"x\"}");
        assertThat(token(null, "id", "bash", "exec", args, null, null, null, null).getOutputFile())
                .isEqualTo("out.pdf");
    }

    @Test
    void getOutputFile_nullWhenObjectArgsHaveNoOutputFile() {
        JsonNode args = json("{\"command\":\"x\"}");
        assertThat(token(null, "id", "bash", "exec", args, null, null, null, null).getOutputFile()).isNull();
    }

    @Test
    void getOutputFile_fromStringifiedArgs() {
        JsonNode args = TextNode.valueOf("{\"outputFile\":\"report.pdf\"}");
        assertThat(token(null, "id", "bash", "exec", args, null, null, null, null).getOutputFile())
                .isEqualTo("report.pdf");
    }

    @Test
    void getOutputFile_nullWhenStringifiedArgsUnparseable() {
        JsonNode args = TextNode.valueOf("not json at all");
        assertThat(token(null, "id", "bash", "exec", args, null, null, null, null).getOutputFile()).isNull();
    }
}
