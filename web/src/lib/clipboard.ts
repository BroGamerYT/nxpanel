/**
 * In die Zwischenablage kopieren - auch ueber http://10.0.0.x.
 * navigator.clipboard gibt es nur auf HTTPS-Seiten und localhost; im LAN
 * ohne Zertifikat ist es undefined. Dann bleibt der alte Weg ueber ein
 * unsichtbares Textfeld, den alle Browser weiter unterstuetzen.
 */
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* weiter mit dem Rueckfall */
    }
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  document.body.removeChild(ta);
  return ok;
}
