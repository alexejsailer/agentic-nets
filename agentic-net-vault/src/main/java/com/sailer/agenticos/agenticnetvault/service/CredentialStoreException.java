package com.sailer.agenticos.agenticnetvault.service;

/** Backend-neutral failure of the credential store — maps to 502 like VaultException. */
public class CredentialStoreException extends RuntimeException {

    public CredentialStoreException(String message) {
        super(message);
    }

    public CredentialStoreException(String message, Throwable cause) {
        super(message, cause);
    }
}
