package com.sailer.agenticos.agenticnetexecutor.transition;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * @deprecated Replaced by plaintext credentials from agentic-net-vault.
 *             Kept for backward compatibility during migration.
 */
@Deprecated
@JsonInclude(JsonInclude.Include.NON_NULL)
public record EncryptedCredentials(
        String algorithm,
        String iv,
        String ciphertext,
        String keyId
) {
    public boolean isComplete() {
        return algorithm != null && iv != null && ciphertext != null;
    }
}
