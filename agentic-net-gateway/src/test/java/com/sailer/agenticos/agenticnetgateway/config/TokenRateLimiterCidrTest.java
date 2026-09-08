package com.sailer.agenticos.agenticnetgateway.config;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class TokenRateLimiterCidrTest {
    @Test
    void cidrMatching() {
        assertTrue(TokenRateLimiter.cidrContains("172.16.0.0/12", "172.18.0.1"));
        assertFalse(TokenRateLimiter.cidrContains("172.16.0.0/12", "172.32.0.1"));
        assertTrue(TokenRateLimiter.cidrContains("10.0.0.0/8", "10.200.1.2"));
        assertFalse(TokenRateLimiter.cidrContains("10.0.0.0/8", "11.0.0.1"));
        assertTrue(TokenRateLimiter.cidrContains("127.0.0.1/32", "127.0.0.1"));
        assertFalse(TokenRateLimiter.cidrContains("not-a-cidr", "127.0.0.1"));
    }
}
