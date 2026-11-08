/** Settings for our generated, disposable LTI helpers only. These must never be
 * applied to the original hosted course, a registration or account defaults.
 * Cloud V2 SettingsPostSchema + effective SettingListSchema:
 * https://cloud.scorm.com/docs/swagger.json */
const VALUES = Object.freeze({ PlayerLaunchType: 'FRAMESET', PlayerScoLaunchType: 'FRAMESET', Lti13PrivacySettings: 'NO_LEARNER_INFO' });
export function ltiHelperSettingsRequest(): { settings: Array<{ settingId: string; value: string }> } {
  return { settings: Object.entries(VALUES).map(([settingId, value]) => ({ settingId, value })) };
}
export function ltiHelperSettingsConfirmed(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const items = (raw as Record<string, unknown>).settingItems;
  if (!Array.isArray(items) || items.length > 2000) return false;
  return Object.entries(VALUES).every(([id, desired]) => {
    const matching = items.filter(item => item && typeof item === 'object' && !Array.isArray(item) && (item as Record<string, unknown>).id === id);
    return matching.length === 1 && (matching[0] as Record<string, unknown>).effectiveValue === desired;
  });
}
