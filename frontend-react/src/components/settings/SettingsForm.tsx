import { useEffect, useState } from 'react';

import type { SettingsCurrent } from '@/lib/types';

/**
 * Single source of truth for the in-memory form values shared by every
 * Settings tab. Initialised from the API response and merged back on
 * save. Each input does setForm({ ...form, foo: value }) — small enough
 * we don't need a reducer.
 */
export interface SettingsFormState {
  pollingInterval: number;
  requestTimeout: number;
  hashrateSmoothing: number;
  retentionDays: number;
  tempChip: number;
  tempVr: number;
  offlineSeconds: number;
  repeatSeconds: number;
  notificationsEnabled: boolean;
  pushEnabled: boolean;
  telegramEnabled: boolean;
  telegramChatId: string;
  telegramBotToken: string; // write-only
  telegramTokenSet: boolean;
  scanCidr: string;
  authEnabled: boolean;
  authPassword: string; // write-only
}

export function useSettingsForm(current: SettingsCurrent | null | undefined) {
  const [form, setForm] = useState<SettingsFormState | null>(null);

  useEffect(() => {
    if (!current) return;
    setForm({
      pollingInterval: current.polling.interval_seconds,
      requestTimeout: current.polling.request_timeout,
      hashrateSmoothing: current.polling.hashrate_smoothing_seconds ?? 60,
      retentionDays:
        (current.storage as unknown as { retention_days?: number }).retention_days
          ?? current.storage.retention_1m_days
          ?? 30,
      tempChip: current.alerts.temp_chip_threshold,
      tempVr: current.alerts.temp_vr_threshold,
      offlineSeconds: current.alerts.offline_threshold_seconds,
      repeatSeconds: current.alerts.repeat_seconds,
      notificationsEnabled: current.alerts.notifications_enabled !== false,
      pushEnabled: current.alerts.push_enabled !== false,
      telegramEnabled: !!current.alerts.telegram_enabled,
      telegramChatId: current.alerts.telegram_chat_id ?? '',
      telegramBotToken: '',
      telegramTokenSet: !!current.alerts.telegram_token_set,
      scanCidr: current.network.scan_cidr,
      authEnabled: current.auth_enabled,
      authPassword: '',
    });
  }, [current]);

  return [form, setForm] as const;
}

/**
 * Convert the form state to the dotted-key overrides payload the
 * backend expects. Write-only secrets are only included when non-empty
 * so leaving them blank preserves whatever's stored.
 */
export function formToOverrides(form: SettingsFormState): Record<string, unknown> {
  const overrides: Record<string, unknown> = {
    'polling.interval_seconds': form.pollingInterval,
    'polling.request_timeout': form.requestTimeout,
    'polling.hashrate_smoothing_seconds': form.hashrateSmoothing,
    'storage.retention_days': form.retentionDays,
    'alerts.temp_chip_threshold': form.tempChip,
    'alerts.temp_vr_threshold': form.tempVr,
    'alerts.offline_threshold_seconds': form.offlineSeconds,
    'alerts.repeat_seconds': form.repeatSeconds,
    'alerts.notifications_enabled': form.notificationsEnabled,
    'alerts.push_enabled': form.pushEnabled,
    'alerts.telegram_enabled': form.telegramEnabled,
    'alerts.telegram_chat_id': form.telegramChatId.trim(),
    'network.scan_cidr': form.scanCidr,
    'auth.enabled': form.authEnabled,
  };
  if (form.authPassword) overrides['auth.password'] = form.authPassword;
  if (form.telegramBotToken) overrides['alerts.telegram_bot_token'] = form.telegramBotToken;
  return overrides;
}
