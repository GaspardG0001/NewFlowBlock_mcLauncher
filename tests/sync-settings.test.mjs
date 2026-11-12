import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'

let usageCalls = 0
globalThis.__syncSettings = {
  getUser: () => ({}),
  shared: { selectedProfileSlug: 'one' },
  ipc: {
    auth: {}, settings: { get: async () => null }, system: { getInfo: async () => ({ totalMem: 8, resolution: {}, version: 'test' }) },
    skin: {},
    profiles: { get: async () => [{ id: 'one-id', slug: 'one', name: 'Un' }, { id: 'two-id', slug: 'two', name: 'Deux' }] },
    sync: {
      getState: async () => true,
      authenticate: async () => ({ success: true }),
      onUploadProgress: () => {},
      onCompleted: () => {},
      getUsage: async (ids) => {
        usageCalls++
        assert.deepEqual(ids, ['one-id', 'two-id'])
        return {
          scope: 'player', quotaBytes: '100', usedBytes: '30', reservedBytes: '0',
          profiles: [{ profileId: 'one-id', usedBytes: '10', reservedBytes: '0' }, { profileId: 'two-id', usedBytes: '20', reservedBytes: '0' }]
        }
      },
      listInstanceEntries: async () => [],
      getSelection: async () => [],
      getConflicts: async () => []
    }
  }
}
const vite = await createServer({
  configFile: false, server: { middlewareMode: true, ws: false }, appType: 'custom', logLevel: 'error',
  plugins: [{
    name: 'settings-mocks', enforce: 'pre',
    resolveId(source) {
      if (source === '../ipc') return '\0settings-ipc'
      if (source === '../state') return '\0settings-state'
      if (source === '../shared') return '\0settings-shared'
      if (source === './dialog') return '\0settings-dialog'
    },
    load(id) {
      if (id === '\0settings-ipc') return 'export const { auth, settings, system, skin, sync, profiles } = globalThis.__syncSettings.ipc'
      if (id === '\0settings-state') return 'export const getUser = globalThis.__syncSettings.getUser; export const setView = () => {}; export const closeOverlay = () => {}'
      if (id === '\0settings-shared') return 'export default globalThis.__syncSettings.shared'
      if (id === '\0settings-dialog') return 'export const Dialog = {}'
    }
  }]
})
const { initSettings } = await vite.ssrLoadModule('/src/views/settings.ts')
after(async () => { delete globalThis.__syncSettings; await vite.close() })

function element() {
  return {
    children: [], style: {}, attributes: {}, textContent: '', value: '', innerHTML: '',
    replaceChildren(...children) { this.children = children },
    appendChild(child) { this.children.push(child) },
    append(...children) { this.children.push(...children) },
    setAttribute(name, value) { this.attributes[name] = value },
    removeAttribute(name) { delete this.attributes[name] },
    addEventListener() {}
  }
}

test('switching profiles leaves the global quota bar unchanged', async () => {
  const ids = ['sync-profile-select', 'sync-files-list', 'sync-conflicts', 'sync-usage-total', 'sync-usage-bar', 'sync-usage-legend']
  const elements = Object.fromEntries(ids.map((id) => [id, element()]))
  const oldDocument = globalThis.document
  const oldWindow = globalThis.window
  globalThis.document = {
    getElementById: (id) => elements[id] ?? null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: element
  }
  globalThis.window = { addEventListener() {} }
  try {
    await initSettings()
    await new Promise((resolve) => setImmediate(resolve))
    const bar = elements['sync-usage-bar']
    const segments = [...bar.children]
    assert.equal(bar.attributes['aria-valuenow'], '30')
    assert.deepEqual(segments.map((segment) => segment.style.width), ['10%', '20%'])
    elements['sync-profile-select'].value = 'two'
    elements['sync-profile-select'].onchange()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(usageCalls, 1)
    assert.deepEqual(bar.children, segments)
    assert.equal(bar.attributes['aria-valuenow'], '30')
  } finally {
    globalThis.document = oldDocument
    globalThis.window = oldWindow
  }
})
