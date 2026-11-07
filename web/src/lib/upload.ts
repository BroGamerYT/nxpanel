import { currentToken, refreshSession } from './api';
import { t } from './i18n';

/**
 * Datei hochladen mit Fortschritt. fetch kann keinen Upload-Fortschritt
 * melden, deshalb XMLHttpRequest. Vorher frischen Token holen: ein grosser
 * Upload dauert leicht laenger als die 15 Minuten Token-Laufzeit.
 */
export async function uploadFile<T>(url: string, file: File, onProgress: (pct: number) => void): Promise<{ status: number; data: T | null; error: string | null }> {
  await refreshSession();
  const token = currentToken();
  const form = new FormData();
  form.append('file', file);
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/v1${url}`);
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100)); };
    xhr.onload = () => {
      let data: unknown = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* leer */ }
      const ok = xhr.status >= 200 && xhr.status < 300;
      resolve({
        status: xhr.status,
        data: ok ? (data as T) : null,
        error: ok ? null : ((data as { error?: string } | null)?.error ?? t('common.errorCode', { code: xhr.status })),
      });
    };
    xhr.onerror = () => resolve({ status: 0, data: null, error: t('common.connectionLost') });
    xhr.send(form);
  });
}
