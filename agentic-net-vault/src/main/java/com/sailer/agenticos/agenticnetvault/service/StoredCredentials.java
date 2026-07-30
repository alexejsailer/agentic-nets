package com.sailer.agenticos.agenticnetvault.service;

import java.util.Map;

/**
 * Backend-neutral read result. {@code metadata} uses the OpenBao KV2 key names
 * ({@code version}, {@code created_time}, {@code deletion_time}) — CredentialService
 * translates them into the REST metadata shape, so every backend must emit the
 * same names.
 */
public record StoredCredentials(Map<String, Object> data, Map<String, Object> metadata) {
}
