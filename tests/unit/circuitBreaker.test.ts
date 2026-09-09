// tests/unit/circuitBreaker.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { CircuitBreaker, isRateLimitError, isTransientError } from '../../src/utils/circuitBreaker.js';

describe('CircuitBreaker (3-state)', () => {
  let cb: CircuitBreaker;

  beforeEach(() => {
    cb = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000 });
  });

  it('starts CLOSED', () => {
    expect(cb.getState('gemini')).toBe('CLOSED');
    expect(cb.isAvailable('gemini')).toBe(true);
  });

  it('transitions CLOSED → OPEN after threshold failures', () => {
    cb.recordFailure('gemini');
    cb.recordFailure('gemini');
    expect(cb.getState('gemini')).toBe('CLOSED'); // not yet
    cb.recordFailure('gemini');
    expect(cb.getState('gemini')).toBe('OPEN');
    expect(cb.isAvailable('gemini')).toBe(false);
  });

  it('transitions OPEN → HALF_OPEN after cooldown', async () => {
    cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 50 });
    cb.recordFailure('gemini');
    expect(cb.getState('gemini')).toBe('OPEN');
    await new Promise(r => setTimeout(r, 60));
    expect(cb.getState('gemini')).toBe('HALF_OPEN');
    expect(cb.isAvailable('gemini')).toBe(true); // allow probe
  });

  it('transitions HALF_OPEN → CLOSED on success', async () => {
    cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 50 });
    cb.recordFailure('gemini');
    await new Promise(r => setTimeout(r, 60));
    cb.recordSuccess('gemini');
    expect(cb.getState('gemini')).toBe('CLOSED');
  });

  it('transitions HALF_OPEN → OPEN on failure', async () => {
    cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 50 });
    cb.recordFailure('gemini');
    await new Promise(r => setTimeout(r, 60));
    expect(cb.getState('gemini')).toBe('HALF_OPEN');
    cb.recordFailure('gemini');
    expect(cb.getState('gemini')).toBe('OPEN');
  });
});

describe('isTransientError', () => {
  it('returns true for timeout and 5xx errors', () => {
    expect(isTransientError(new Error('Specialist timed out after 5000ms'))).toBe(true);
    expect(isTransientError({ status: 503, message: 'service unavailable' })).toBe(true);
  });

  it('returns true for rate-limit / quota errors', () => {
    expect(isTransientError(new Error('HTTP 429 Too Many Requests'))).toBe(true);
    expect(isTransientError({ status: 429, message: 'rate limited' })).toBe(true);
    expect(isTransientError(new Error('ResourceExhausted: Worker local total request limit reached (10/10)'))).toBe(true);
    expect(isTransientError(new Error('quota exceeded'))).toBe(true);
  });

  it('returns false for non-transient errors', () => {
    expect(isTransientError(new Error('401 Unauthorized'))).toBe(false);
    expect(isTransientError(new Error('Validation failed'))).toBe(false);
  });
});

describe('isRateLimitError', () => {
  it('matches 429, rate-limit text, NVIDIA NIM ResourceExhausted, quota exhaustion', () => {
    expect(isRateLimitError({ status: 429 })).toBe(true);
    expect(isRateLimitError(new Error('HTTP 429 Too Many Requests'))).toBe(true);
    expect(isRateLimitError(new Error('rate limit exceeded'))).toBe(true);
    expect(isRateLimitError(new Error('rate-limit exceeded'))).toBe(true);
    expect(isRateLimitError(new Error('ResourceExhausted: Worker local total request limit reached (5/5)'))).toBe(true);
    expect(isRateLimitError(new Error('quota exhausted'))).toBe(true);
    expect(isRateLimitError(new Error('quota exceeded'))).toBe(true);
  });

  // unitAI-xxjw2: opencode free-tier quota surfaces as FreeUsageLimitError.
  it('matches opencode FreeUsageLimitError by name and usage-limit message', () => {
    const named = new Error('Request failed');
    named.name = 'FreeUsageLimitError';
    expect(isRateLimitError(named)).toBe(true);
    expect(isTransientError(named)).toBe(true);
    expect(isRateLimitError(new Error('Free usage limit exceeded for model'))).toBe(true);
    expect(isRateLimitError(new Error('Total usage limit reached (10/10)'))).toBe(true);
  });

  it('returns false for non-rate-limit errors', () => {
    expect(isRateLimitError(null)).toBe(false);
    expect(isRateLimitError(new Error('503 service unavailable'))).toBe(false);
    expect(isRateLimitError(new Error('401 Unauthorized'))).toBe(false);
    expect(isRateLimitError(new Error('ECONNRESET'))).toBe(false);
  });
});
