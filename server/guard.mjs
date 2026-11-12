import os from 'node:os'

/**
 * The host names the page may be opened under: localhost, this Mac's own
 * name, its Tailscale name (*.ts.net), and any in ALLOWED_HOSTS. Anything else
 * is refused, so a web page elsewhere can't reach the server through a DNS
 * name it controls (DNS rebinding), and can't post changes to it (Origin).
 */
export function hostAllowed(hostHeader, allowed = []) {
  const host = String(hostHeader ?? '')
    .toLowerCase()
    .replace(/:\d+$/, '')
    .replace(/^\[|\]$/g, '')
  if (!host) return false
  const name = os.hostname().toLowerCase().replace(/\.local$/, '')
  const local = ['localhost', '127.0.0.1', '::1', name, `${name}.local`]
  return local.includes(host) || host.endsWith('.ts.net') || allowed.includes(host)
}
