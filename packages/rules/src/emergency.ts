/**
 * The emergency panel on the post phone (owner, 7 Oct 2026): police, fire, ambulance and the
 * site's armed response company. It opens after PANIC and is on the Call screen. The phone
 * never dials any of these by itself: the guard taps the service he needs.
 */

/** A site's own emergency numbers, set with the site's other contacts. */
export const EMERGENCY_CONTACT_KINDS = ['police_station', 'fire', 'ambulance', 'armed_response'] as const;
export type EmergencyContactKind = (typeof EMERGENCY_CONTACT_KINDS)[number];

export const SITE_CONTACT_KINDS = ['supervisor', 'site_manager', 'control_room', ...EMERGENCY_CONTACT_KINDS] as const;
export type SiteContactKind = (typeof SITE_CONTACT_KINDS)[number];

/** National numbers. The owner confirmed their use (7 Oct 2026); they are kept here so they change in one place. */
export const NATIONAL_POLICE = '10111';
export const NATIONAL_AMBULANCE_FIRE = '10177';

export const EMERGENCY_SERVICES = ['police', 'fire', 'ambulance', 'armed_response'] as const;
export type EmergencyService = (typeof EMERGENCY_SERVICES)[number];
export const EMERGENCY_SERVICE_LABELS: Record<EmergencyService, string> = { police: 'Police', fire: 'Fire brigade', ambulance: 'Ambulance', armed_response: 'Armed response' };

/** One number the guard can tap. `kind` is what is recorded when he does. */
export interface EmergencyOption {
  kind: 'police_national' | 'police_station' | 'fire' | 'fire_national' | 'ambulance' | 'ambulance_national' | 'armed_response';
  service: EmergencyService;
  label: string;
  name: string;
  phone: string;
  national: boolean;
}
export const EMERGENCY_OPTION_KINDS = ['police_national', 'police_station', 'fire', 'fire_national', 'ambulance', 'ambulance_national', 'armed_response'] as const;

type Saved = Partial<Record<string, { name: string; phone: string }>>;

/**
 * What the panel offers at a site.
 * - Police: always 10111, and the local station when the site has its number (two choices).
 * - Fire and ambulance: the site's local number; the national number only when none is set.
 * - Armed response: only when the site has one.
 */
export function emergencyOptions(saved: Saved): EmergencyOption[] {
  const has = (k: EmergencyContactKind) => !!saved[k]?.phone.trim();
  const out: EmergencyOption[] = [{ kind: 'police_national', service: 'police', label: `Police ${NATIONAL_POLICE}`, name: 'National emergency number', phone: NATIONAL_POLICE, national: true }];
  if (has('police_station')) out.push({ kind: 'police_station', service: 'police', label: 'Local police station', name: saved.police_station!.name, phone: saved.police_station!.phone, national: false });
  out.push(
    has('fire')
      ? { kind: 'fire', service: 'fire', label: 'Fire brigade', name: saved.fire!.name, phone: saved.fire!.phone, national: false }
      : { kind: 'fire_national', service: 'fire', label: `Fire brigade ${NATIONAL_AMBULANCE_FIRE}`, name: 'National emergency number', phone: NATIONAL_AMBULANCE_FIRE, national: true },
  );
  out.push(
    has('ambulance')
      ? { kind: 'ambulance', service: 'ambulance', label: 'Ambulance', name: saved.ambulance!.name, phone: saved.ambulance!.phone, national: false }
      : { kind: 'ambulance_national', service: 'ambulance', label: `Ambulance ${NATIONAL_AMBULANCE_FIRE}`, name: 'National emergency number', phone: NATIONAL_AMBULANCE_FIRE, national: true },
  );
  if (has('armed_response')) out.push({ kind: 'armed_response', service: 'armed_response', label: 'Armed response', name: saved.armed_response!.name, phone: saved.armed_response!.phone, national: false });
  return out;
}
