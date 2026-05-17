// Web Push helpers.
//
// Mirrors the conversion routines from the vanilla settings.js so the
// subscription payload we send to /api/push/subscribe is byte-identical
// to what the legacy frontend sends. Same VAPID public key, same SW.

import { api } from './api';

/**
 * Convert a URL-safe base64 string (VAPID public key) to the
 * Uint8Array that PushManager.subscribe() requires.
 */
export function urlBase64ToUint8Array(b64: string): Uint8Array {
  const padding = '='.repeat((4 - (b64.length % 4)) % 4);
  const std = (b64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(std);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export function arrayBufferToBase64(buffer: ArrayBuffer | null): string {
  if (!buffer) return '';
  const bytes = new Uint8Array(buffer);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

/**
 * Browser-side push support check. Returns null when supported, or an
 * explanatory message to show inline when it isn't.
 */
export function pushSupportProblem(): string | null {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return 'Your browser does not support Web Push.';
  }
  if (Notification.permission === 'denied') {
    return 'You blocked notifications for this site. Unblock from the browser’s site settings (lock icon in the address bar).';
  }
  return null;
}

/**
 * One-stop "subscribe this browser" routine. Mirrors the vanilla
 * enablePushFlow but returns a promise instead of mutating DOM, so the
 * React component can chain a state update on success.
 */
export async function subscribeThisBrowser(): Promise<void> {
  const reg = await navigator.serviceWorker.register('/sw.js');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error('Notification permission denied.');
  }
  const { public_key } = await api<{ public_key: string }>('/api/push/vapid_public_key');
  // applicationServerKey expects a BufferSource. Newer TS lib.dom typings
  // narrow Uint8Array to <ArrayBuffer> (excluding SharedArrayBuffer), so
  // we cast through ArrayBuffer to make the conversion explicit.
  const keyBytes = urlBase64ToUint8Array(public_key);
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: keyBytes.buffer as ArrayBuffer,
  });
  await api('/api/push/subscribe', {
    method: 'POST',
    body: {
      endpoint: sub.endpoint,
      keys: {
        p256dh: arrayBufferToBase64(sub.getKey('p256dh')),
        auth: arrayBufferToBase64(sub.getKey('auth')),
      },
    },
  });
}

export async function unsubscribeThisBrowser(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  await api('/api/push/subscribe', {
    method: 'DELETE',
    body: { endpoint: sub.endpoint },
  });
  await sub.unsubscribe();
}

/**
 * Returns the active subscription endpoint on this browser, or null.
 * Used by the Settings page to pick between "Enable" and "Disable".
 */
export async function currentSubscriptionEndpoint(): Promise<string | null> {
  if (!('serviceWorker' in navigator)) return null;
  try {
    const reg = await navigator.serviceWorker.register('/sw.js');
    const sub = await reg.pushManager.getSubscription();
    return sub?.endpoint ?? null;
  } catch {
    return null;
  }
}
