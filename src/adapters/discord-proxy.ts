import { createGlobalProxyAgent } from 'global-agent'
import { ProxyAgent } from 'undici'

export function configureDiscordProxy(value: string) {
  const url = new URL(value)
  if (url.protocol !== 'http:' || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Use an HTTP proxy URL')
  }

  const dispatcher = new ProxyAgent(url.href)
  // Discord.js uses ws for the Gateway. Its custom socket factory bypasses
  // Node's default HTTPS agent unless a proxy agent is supplied explicitly.
  const gateway = createGlobalProxyAgent({ environmentVariableNamespace: 'SOXIN_GATEWAY_' })
  gateway.HTTPS_PROXY = url.href
  gateway.NO_PROXY = 'localhost,127.0.0.1'
  return dispatcher
}
