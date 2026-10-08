import { alertKindsFor, deviceLabel, isPushEndpoint, wantsAlert } from './alerts';

describe('alerts', () => {
  it('offers each role only the alerts its permissions allow', () => {
    expect(alertKindsFor('site_supervisor')).toEqual(['panic', 'bolo', 'patrol_overdue', 'post_uncovered', 'wrong_post', 'red_report', 'visitor_barred', 'visitor_exception', 'visitor_overstay', 'visitor_handover', 'roll_call']);
    expect(alertKindsFor('client_manager')).toEqual([]);
    expect(alertKindsFor('hr_admin')).toEqual([]);
    expect(alertKindsFor('stores_clerk')).toEqual([]);
  });

  it('respects what a person switched off, except a panic, which cannot be switched off', () => {
    const off = new Set(['panic', 'bolo']);
    expect(wantsAlert('site_supervisor', 'bolo', off)).toBe(false);
    expect(wantsAlert('site_supervisor', 'panic', off)).toBe(true);
    expect(wantsAlert('site_supervisor', 'red_report', off)).toBe(true);
    expect(wantsAlert('client_manager', 'panic', new Set())).toBe(false);
    expect(wantsAlert('client_manager', 'test', new Set())).toBe(true);
    // Alerts for customers never go to staff, and are not among a member of staff's settings.
    expect(wantsAlert('system_admin', 'visitor_request', new Set())).toBe(false);
    expect(alertKindsFor('system_admin')).not.toContain('visitor_request');
  });

  it('sends alerts only to the real delivery services, over HTTPS', () => {
    expect(isPushEndpoint('https://fcm.googleapis.com/fcm/send/abc')).toBe(true);
    expect(isPushEndpoint('https://web.push.apple.com/QGk')).toBe(true);
    expect(isPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/x')).toBe(true);
    expect(isPushEndpoint('https://wns2-par02p.notify.windows.com/w/?token=x')).toBe(true);
    expect(isPushEndpoint('http://fcm.googleapis.com/fcm/send/abc')).toBe(false);
    expect(isPushEndpoint('https://fcm.googleapis.com.evil.test/x')).toBe(false);
    expect(isPushEndpoint('https://evil.test/fcm.googleapis.com')).toBe(false);
    expect(isPushEndpoint('https://localhost:4000/api/users')).toBe(false);
    expect(isPushEndpoint('https://user@fcm.googleapis.com/x')).toBe(false);
    expect(isPushEndpoint('not a url')).toBe(false);
  });

  it('names a device from its browser', () => {
    expect(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1')).toBe('iPhone (Safari)');
    expect(deviceLabel('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36')).toBe('Android phone (Chrome)');
    expect(deviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 Edg/124.0')).toBe('Windows computer (Edge)');
    expect(deviceLabel('')).toBe('Device');
  });
});
