import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { clearSessionEnded, endedCopy, handleUnauthorized, useSessionEnded } from './sessionEnded';

afterEach(() => clearSessionEnded());

describe('endedCopy', () => {
  it('names the other device when known', () => {
    expect(endedCopy({ reason: 'other_device', deviceLabel: 'iphone' })).toEqual({
      title: 'me_ended_other_title', body: 'me_ended_other_body', device: 'me_device_iphone',
    });
    expect(endedCopy({ reason: 'other_device', deviceLabel: 'toaster' }).device).toBe('me_device_other');
    expect(endedCopy({ reason: 'other_device' }).device).toBe('me_device_other');
  });

  it('has PIN, deletion and expiry variants', () => {
    expect(endedCopy({ reason: 'pin_change' }).title).toBe('me_ended_pin_title');
    expect(endedCopy({ reason: 'pin_reset' }).title).toBe('me_ended_pin_title');
    expect(endedCopy({ reason: 'account_deleted' }).title).toBe('me_ended_deleted_title');
    expect(endedCopy({ reason: 'expired' }).title).toBe('me_ended_expired_title');
  });
});

describe('handleUnauthorized', () => {
  it('reports ended and expired sessions, and ignores a plain sign-in requirement', () => {
    const { result } = renderHook(() => useSessionEnded());
    act(() => handleUnauthorized('auth.required'));
    expect(result.current).toBeNull();
    act(() => handleUnauthorized('auth.session_ended', { reason: 'other_device', deviceLabel: 'mac' }));
    expect(result.current).toEqual({ reason: 'other_device', deviceLabel: 'mac' });
    act(() => handleUnauthorized('session.expired'));
    expect(result.current).toEqual({ reason: 'expired', deviceLabel: null });
    act(() => clearSessionEnded());
    expect(result.current).toBeNull();
  });
});
