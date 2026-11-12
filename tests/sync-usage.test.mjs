import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'

const vite = await createServer({ configFile: false, server: { middlewareMode: true, ws: false }, appType: 'custom', logLevel: 'error' })
const { parseSyncUsage } = await vite.ssrLoadModule('/electron/sync/usage.ts')
const { renderSyncUsage, clearSyncUsage, showSyncUsageError } = await vite.ssrLoadModule('/src/views/sync-usage.ts')
after(() => vite.close())

function element() {
  return {
    children: [], style: {}, attributes: {}, textContent: '',
    replaceChildren(...children) { this.children = children },
    appendChild(child) { this.children.push(child) },
    append(...children) { this.children.push(...children) },
    setAttribute(name, value) { this.attributes[name] = value },
    removeAttribute(name) { delete this.attributes[name] }
  }
}

test('renders only used storage per profile, including unknown profiles', () => {
  const elements = Object.fromEntries(['sync-usage-total', 'sync-usage-bar', 'sync-usage-legend'].map((id) => [id, element()]))
  const oldDocument = globalThis.document
  globalThis.document = { getElementById: (id) => elements[id], createElement: element }
  try {
    const usage = parseSyncUsage({
      scope: 'player', quotaBytes: '100', usedBytes: '60', reservedBytes: '25',
      profiles: [
        { profileId: 'b', usedBytes: '20', reservedBytes: '10' },
        { profileId: 'a', usedBytes: '40', reservedBytes: '10' },
        { profileId: 'c', usedBytes: '0', reservedBytes: '5' }
      ]
    })
    renderSyncUsage(usage, new Map([['a', 'Mon profil']]))
    assert.equal(elements['sync-usage-total'].textContent, '< 1 Mo utilisés / < 1 Mo')
    assert.equal(elements['sync-usage-bar'].attributes['aria-valuenow'], '60')
    assert.equal(elements['sync-usage-bar'].attributes['aria-valuetext'], '< 1 Mo utilisés / < 1 Mo')
    assert.deepEqual(elements['sync-usage-bar'].children.map((segment) => segment.style.width), ['40%', '20%'])
    assert.notEqual(elements['sync-usage-bar'].children[0].style.backgroundColor, elements['sync-usage-bar'].children[1].style.backgroundColor)
    assert.equal(elements['sync-usage-legend'].children.length, 2)
    assert.match(elements['sync-usage-legend'].children[1].children[1].textContent, /Profil b/)
    clearSyncUsage('Indisponible')
    assert.equal(elements['sync-usage-bar'].children.length, 0)
    assert.equal(elements['sync-usage-bar'].attributes['aria-valuenow'], undefined)
  } finally {
    globalThis.document = oldDocument
  }
})

test('formats totals and profile sizes in rounded decimal Mo and Go', () => {
  const elements = Object.fromEntries(['sync-usage-total', 'sync-usage-bar', 'sync-usage-legend'].map((id) => [id, element()]))
  const oldDocument = globalThis.document
  globalThis.document = { getElementById: (id) => elements[id], createElement: element }
  try {
    const usage = {
      scope: 'player', quotaBytes: '5368709120', usedBytes: '1250000', reservedBytes: '0',
      profiles: [{ profileId: 'a', usedBytes: '1250000', reservedBytes: '0' }]
    }
    renderSyncUsage(usage, new Map([['a', 'Profil A']]))
    assert.equal(elements['sync-usage-total'].textContent, '1 Mo utilisés / 5 Go')
    assert.equal(elements['sync-usage-legend'].children[0].children[1].textContent, 'Profil A : 1 Mo utilisés')
    usage.usedBytes = '1500000'
    usage.profiles[0].usedBytes = usage.usedBytes
    renderSyncUsage(usage, new Map())
    assert.equal(elements['sync-usage-total'].textContent, '2 Mo utilisés / 5 Go')
    usage.usedBytes = '999999999'
    usage.profiles[0].usedBytes = usage.usedBytes
    renderSyncUsage(usage, new Map())
    assert.equal(elements['sync-usage-total'].textContent, '1 Go utilisés / 5 Go')
    usage.quotaBytes = '5400000000'
    renderSyncUsage(usage, new Map())
    assert.equal(elements['sync-usage-total'].textContent, '1 Go utilisés / 5 Go')
    usage.quotaBytes = '5600000000'
    renderSyncUsage(usage, new Map())
    assert.equal(elements['sync-usage-total'].textContent, '1 Go utilisés / 6 Go')
    usage.usedBytes = '0'
    usage.profiles = []
    renderSyncUsage(usage, new Map())
    assert.equal(elements['sync-usage-total'].textContent, '0 Mo utilisés / 6 Go')
  } finally {
    globalThis.document = oldDocument
  }
})

test('renders zero quota and over-quota usage without overflowing the bar', () => {
  const elements = Object.fromEntries(['sync-usage-total', 'sync-usage-bar', 'sync-usage-legend'].map((id) => [id, element()]))
  const oldDocument = globalThis.document
  globalThis.document = { getElementById: (id) => elements[id], createElement: element }
  try {
    const usage = { scope: 'player', quotaBytes: '0', usedBytes: '2', reservedBytes: '1', profiles: [{ profileId: 'a', usedBytes: '2', reservedBytes: '1' }] }
    renderSyncUsage(usage, new Map())
    assert.equal(elements['sync-usage-bar'].attributes['aria-valuenow'], '100')
    assert.equal(elements['sync-usage-bar'].children.length, 1)
    usage.quotaBytes = '1'
    renderSyncUsage(usage, new Map())
    assert.deepEqual(elements['sync-usage-bar'].children.map((segment) => segment.style.width), ['100%'])
    usage.usedBytes = '0'
    usage.quotaBytes = '0'
    usage.profiles = [{ profileId: 'a', usedBytes: '0', reservedBytes: '1' }]
    renderSyncUsage(usage, new Map())
    assert.equal(elements['sync-usage-bar'].attributes['aria-valuenow'], '0')
    assert.equal(elements['sync-usage-bar'].children.length, 0)
    assert.equal(elements['sync-usage-legend'].children.length, 0)
  } finally {
    globalThis.document = oldDocument
  }
})

test('usage errors give actionable guidance without displaying technical IPC details', () => {
  const elements = Object.fromEntries(['sync-usage-total', 'sync-usage-bar', 'sync-usage-legend'].map((id) => [id, element()]))
  const oldDocument = globalThis.document
  const oldError = console.error
  let logged
  globalThis.document = { getElementById: (id) => elements[id] }
  console.error = (...args) => { logged = args }
  try {
    const error = new Error("Error invoking remote method 'sync:get_usage': fetch failed")
    elements['sync-usage-bar'].setAttribute('aria-valuenow', '80')
    showSyncUsageError(error)
    assert.match(elements['sync-usage-total'].textContent, /Vérifiez votre connexion/)
    assert.match(elements['sync-usage-total'].textContent, /rouvrez cet onglet/)
    assert.doesNotMatch(elements['sync-usage-total'].textContent, /sync:get_usage|fetch failed/)
    assert.equal(elements['sync-usage-bar'].attributes['aria-valuenow'], undefined)
    assert.equal(logged[1], error)
  } finally {
    globalThis.document = oldDocument
    console.error = oldError
  }
})
