import { setView, closeOverlay, getUser } from '../state'
import { auth, settings, system, skin, sync, profiles as profilesApi } from '../ipc'
import { Dialog } from './dialog'
import type { IGameSettings } from '../../electron/handlers/settings'
import shared from '../shared'

const resolutionList = [
  { label: 'Automatique (par défaut)', value: '854x480', width: 854, height: 480 },
  { label: 'Plein écran', value: 'fullscreen', width: 854, height: 480 },
  { label: '2560x1440 (1440p)', value: '2560x1440', width: 2560, height: 1440 },
  { label: '1920x1080 (1080p)', value: '1920x1080', width: 1920, height: 1080 },
  { label: '1600x900', value: '1600x900', width: 1600, height: 900 },
  { label: '1366x768', value: '1366x768', width: 1366, height: 768 },
  { label: '1280x1024', value: '1280x1024', width: 1280, height: 1024 },
  { label: '1280x720 (720p)', value: '1280x720', width: 1280, height: 720 },
  { label: '1024x768', value: '1024x768', width: 1024, height: 768 },
  { label: '800x600', value: '800x600', width: 800, height: 600 }
]

let currentSettings: IGameSettings
let launcherActionBeforeCrashReports: IGameSettings['launcherAction'] = 'close'
let syncEnabled = false
let syncProfileIds = new Map<string, string>()

export async function initSettings() {
  const sysInfo = await system.getInfo()
  currentSettings = await settings.get()
  syncEnabled = await sync.getState()

  initUIListeners()
  initDualSlider(sysInfo.totalMem)
  initFormValues(sysInfo.resolution)
  await initSyncTab()

  const versionElem = document.getElementById('version')
  if (versionElem) versionElem.innerText = `Launcher EML v${sysInfo.version}`
}

function initUIListeners() {
  const closeBtn = document.getElementById('btn-close-settings')
  const tabContents = document.querySelectorAll('.tab-content')
  const tabButtons = document.querySelectorAll('.nav-btn')
  const logoutBtn = document.getElementById('btn-logout')
  const crashReportsInput = document.getElementById('send-crash-reports') as HTMLInputElement | null

  const addSkinUrlBtn = document.getElementById('btn-add-skin-url')!
  const addSkinFileBtn = document.getElementById('btn-add-skin-file')!

  const addSkinFileForm = document.getElementById('form-add-skin-file')!
  const addSkinFileInput = document.getElementById('input-add-skin-file') as HTMLInputElement
  const addSkinFileButton = document.getElementById('btn-add-skin-choose-file') as HTMLButtonElement
  const addSkinFileSelectedDiv = document.getElementById('div-add-skin-file-selected')!
  const addSkinFileSelectedName = document.getElementById('span-add-skin-file-name')!
  const addSkinFileResetBtn = document.getElementById('btn-selected-file-reset') as HTMLButtonElement

  const addSkinUrlForm = document.getElementById('form-add-skin-url')!
  const addSkinUrlInput = document.getElementById('input-add-skin-url') as HTMLInputElement

  const addSkinSubmitBtn = document.getElementById('btn-add-skin-submit') as HTMLButtonElement
  const syncActivateBtn = document.getElementById('btn-sync-activate') as HTMLButtonElement | null
  const syncUploadBtn = document.getElementById('btn-sync-upload') as HTMLButtonElement | null

  sync.onUploadProgress(renderSyncUploadProgress)

  syncUploadBtn?.addEventListener('click', async () => {
    if (syncUploadBtn.disabled) return

    const profileSelect = document.getElementById('sync-profile-select') as HTMLSelectElement | null
    const status = document.getElementById('sync-upload-status')
    const profileSlug = profileSelect?.value
    const profileId = profileSlug ? syncProfileIds.get(profileSlug) : undefined
    if (!profileSlug || !profileId) {
      const message = 'Ce profil n’est plus disponible. Actualisez la liste puis réessayez.'
      if (status) status.textContent = message
      await Dialog.show(message, [{ text: 'D’accord', type: 'ok' }], 'FlowBlock Sync')
      return
    }

    syncUploadBtn.disabled = true
    syncUploadBtn.textContent = 'Synchronisation…'
    if (status) status.textContent = 'Préparation des fichiers…'
    try {
      const result = await sync.uploadSelected(profileSlug, profileId)
      if (status) {
        status.textContent = `${result.syncedFiles} fichier${result.syncedFiles === 1 ? '' : 's'} synchronisé${result.syncedFiles === 1 ? '' : 's'}.`
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'La synchronisation n’a pas abouti. Réessayez plus tard.'
      if (status) status.textContent = 'La synchronisation a échoué.'
      await Dialog.show(message, [{ text: 'D’accord', type: 'ok' }], 'FlowBlock Sync')
    } finally {
      syncUploadBtn.disabled = false
      syncUploadBtn.textContent = 'Synchroniser maintenant'
    }
  })

  syncActivateBtn?.addEventListener('click', async () => {
    await enableSync()
  })

  closeBtn?.addEventListener('click', async () => {
    await saveSettings()
    closeOverlay('settings')
  })

  crashReportsInput?.addEventListener('change', async () => {
    syncLauncherActionWithCrashReports(crashReportsInput.checked)
    await saveSettings()
  })

  logoutBtn?.addEventListener('click', async () => {
    if (
      await Dialog.show('Se déconnecter ?', [
        { text: 'Annuler', type: 'cancel' },
        { text: 'Se déconnecter', type: 'danger' }
      ])
    ) {
      await auth.logout()
      closeOverlay('settings')
      setView('login')
    }
  })

  addSkinUrlBtn?.addEventListener('click', () => {
    addSkinUrlBtn!.classList.add('active')
    addSkinFileBtn!.classList.remove('active')
    addSkinUrlForm!.style.display = 'block'
    addSkinFileForm!.style.display = 'none'
    addSkinFileInput.value = ''
    addSkinUrlInput.value = ''
    addSkinFileSelectedDiv.style.display = 'none'
    addSkinFileButton.style.display = 'block'
    addSkinSubmitBtn.disabled = true
  })

  addSkinFileBtn?.addEventListener('click', () => {
    addSkinFileBtn!.classList.add('active')
    addSkinUrlBtn!.classList.remove('active')
    addSkinUrlForm!.style.display = 'none'
    addSkinFileForm!.style.display = 'block'
    addSkinUrlInput.value = ''
    addSkinFileInput.value = ''
    addSkinFileSelectedDiv.style.display = 'none'
    addSkinFileButton.style.display = 'block'
    addSkinSubmitBtn.disabled = true
  })

  addSkinFileButton?.addEventListener('click', async () => {
    addSkinFileInput.click()
  })

  addSkinFileInput?.addEventListener('change', async () => {
    const file = addSkinFileInput.files?.[0]
    if (!file) {
      addSkinFileButton.style.display = 'block'
      addSkinSubmitBtn.disabled = true
      addSkinFileSelectedDiv.style.display = 'none'
      return
    }

    addSkinFileButton.style.display = 'none'
    addSkinSubmitBtn.disabled = false
    addSkinFileSelectedName.innerText = file.name
    addSkinFileSelectedDiv.style.display = 'block'
  })

  addSkinUrlInput?.addEventListener('input', () => {
    addSkinSubmitBtn.disabled = addSkinUrlInput.value.trim() === ''
  })

  addSkinFileResetBtn?.addEventListener('click', () => {
    addSkinFileInput.value = ''
    addSkinFileButton.style.display = 'block'
    addSkinSubmitBtn.disabled = true
    addSkinFileSelectedDiv.style.display = 'none'
  })

  addSkinSubmitBtn?.addEventListener('click', async () => {
    addSkin()
    addSkinUrlInput.value = ''
    addSkinFileInput.value = ''
    addSkinFileButton.style.display = 'block'
    addSkinSubmitBtn.disabled = true
    addSkinFileSelectedDiv.style.display = 'none'
    document.getElementById('settings-content')?.scrollTo({ top: 0, behavior: 'smooth' })
  })

  tabButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn instanceof HTMLButtonElement && btn.dataset.tab === 'sync' && btn.style.display === 'none') return
      tabButtons.forEach((b) => b.classList.remove('active'))
      btn.classList.add('active')
      const targetTab = btn.getAttribute('data-tab')
      tabContents.forEach((c) => (c.id === `tab-${targetTab}` ? c.classList.add('active') : c.classList.remove('active')))
      if (targetTab === 'sync' && syncEnabled) void refreshSyncTab()
    })
  })

  window.addEventListener('app:user-changed', () => {
    if (syncEnabled) void refreshSyncTab()
  })
}

function initDualSlider(maxRamSystem: number) {
  maxRamSystem = Math.min(maxRamSystem, 16)
  const minInput = document.getElementById('ram-min') as HTMLInputElement
  const maxInput = document.getElementById('ram-max') as HTMLInputElement
  const fill = document.getElementById('ram-track-fill')
  const minLabel = document.getElementById('ram-min-label')
  const maxLabel = document.getElementById('ram-max-label')

  if (!minInput || !maxInput || !fill) return

  minInput.max = maxRamSystem.toString()
  maxInput.max = maxRamSystem.toString()

  const gap = 0.5
  const updateSlider = (e?: Event) => {
    let minVal = parseFloat(minInput.value)
    let maxVal = parseFloat(maxInput.value)

    if (maxVal - minVal < gap) {
      if (e?.target === minInput) {
        minInput.value = (maxVal - gap).toString()
        minVal = parseFloat(minInput.value)
      } else {
        maxInput.value = (minVal + gap).toString()
        maxVal = parseFloat(maxInput.value)
      }
    }

    if (minLabel) minLabel.innerText = `${minVal} Go`
    if (maxLabel) maxLabel.innerText = `${maxVal} Go`

    const range = maxRamSystem - parseFloat(minInput.min)
    const minPercent = ((minVal - parseFloat(minInput.min)) / range) * 100
    const maxPercent = ((maxVal - parseFloat(maxInput.min)) / range) * 100

    fill.style.left = `${minPercent}%`
    fill.style.width = `${maxPercent - minPercent}%`
  }

  minInput.addEventListener('input', updateSlider)
  maxInput.addEventListener('input', updateSlider)
  updateSlider()
}

function initFormValues(resolution: { width: number; height: number }) {
  if (!currentSettings) return

  const minInput = document.getElementById('ram-min') as HTMLInputElement
  const maxInput = document.getElementById('ram-max') as HTMLInputElement
  const resolutionSelect = document.getElementById('resolution-select') as HTMLSelectElement
  const launcherActionSelect = document.getElementById('launcher-action-select') as HTMLSelectElement
  const javaSelect = document.getElementById('java-select') as HTMLSelectElement
  const crashReportsInput = document.getElementById('send-crash-reports') as HTMLInputElement

  if (minInput) minInput.value = currentSettings.memory.min + ''
  if (maxInput) maxInput.value = currentSettings.memory.max + ''
  if (resolutionSelect) {
    const availableResolutions = getAvailableResolutions(resolution)
    resolutionSelect.innerHTML = ''
    availableResolutions.forEach((res) => {
      const option = document.createElement('option')
      option.value = res.value
      option.innerText = res.label
      resolutionSelect.appendChild(option)
    })

    resolutionSelect.value = currentSettings.resolution.fullscreen
      ? 'fullscreen'
      : `${currentSettings.resolution.width}x${currentSettings.resolution.height}`
  }
  if (launcherActionSelect) launcherActionSelect.value = currentSettings.launcherAction
  if (javaSelect) javaSelect.value = currentSettings.java === 'bundled' ? 'bundled' : 'custom'
  if (crashReportsInput) {
    crashReportsInput.checked = currentSettings.sendCrashReports
    launcherActionBeforeCrashReports = currentSettings.launcherAction
    syncLauncherActionWithCrashReports(crashReportsInput.checked)
  }

  minInput.dispatchEvent(new Event('input'))
}

function applySyncCardState() {
  const syncCard = document.querySelector('.sync-card') as HTMLDivElement | null
  const syncActivateBtn = document.getElementById('btn-sync-activate') as HTMLButtonElement | null
  const syncSelection = document.getElementById('sync-selection') as HTMLDivElement | null

  if (!syncCard || !syncActivateBtn) return

  if (syncEnabled) {
    syncCard.style.display = 'none'
    syncActivateBtn.disabled = true
    syncActivateBtn.textContent = 'Activé'
    if (syncSelection) syncSelection.style.display = 'flex'
    return
  }

  syncCard.style.display = 'flex'
  syncActivateBtn.disabled = false
  syncActivateBtn.textContent = 'Activer'
  if (syncSelection) syncSelection.style.display = 'none'
}

async function initSyncTab() {
  applySyncCardState()
  if (!syncEnabled) return
  await refreshSyncTab()
}

async function enableSync() {
  const syncActivateBtn = document.getElementById('btn-sync-activate') as HTMLButtonElement | null
  if (!syncActivateBtn || syncActivateBtn.disabled) return

  syncActivateBtn.disabled = true
  try {
    const result = await sync.setEnabled(true)
    if (!result.success) {
      syncActivateBtn.disabled = false
      setSyncTabAvailable(false)
      await showSyncError(result, enableSync)
      return
    }

    syncEnabled = true
    setSyncTabAvailable(true)
    applySyncCardState()
    await renderSyncFileSelection()
  } finally {
    if (!syncEnabled) syncActivateBtn.disabled = false
  }
}

async function refreshSyncTab() {
  const syncSelection = document.getElementById('sync-selection') as HTMLDivElement | null
  if (syncSelection) syncSelection.style.display = 'none'

  const result = await sync.authenticate()
  if (!result.success) {
    setSyncTabAvailable(false)
    await showSyncError(result, refreshSyncTab)
    return
  }

  setSyncTabAvailable(true)
  applySyncCardState()
  await renderSyncFileSelection()
}

function setSyncTabAvailable(available: boolean) {
  const syncTabButton = document.querySelector('.nav-btn[data-tab="sync"]') as HTMLButtonElement | null
  const syncTab = document.getElementById('tab-sync')
  if (!syncTabButton || !syncTab) return

  syncTabButton.style.display = available ? '' : 'none'
  syncTab.style.display = available ? '' : 'none'

  if (!available && syncTabButton.classList.contains('active')) {
    const gameTabButton = document.querySelector('.nav-btn[data-tab="game"]') as HTMLButtonElement | null
    gameTabButton?.click()
  }
}

async function showSyncError(failure: { message: string; canRetry: boolean }, retry: () => Promise<void> | void): Promise<void> {
  const buttons = failure.canRetry
    ? [
        { text: 'Fermer', type: 'cancel' as const },
        { text: 'Réessayer', type: 'ok' as const, action: retry }
      ]
    : [{ text: 'D’accord', type: 'ok' as const }]

  await Dialog.show(failure.message, buttons, 'FlowBlock Sync')
}

async function renderSyncFileSelection() {
  const profileSelect = document.getElementById('sync-profile-select') as HTMLSelectElement | null
  if (!profileSelect) return

  const user = getUser()
  if (!user) return

  const profileList = await profilesApi.get(user)
  if (!profileList || profileList.length === 0) return

  profileSelect.innerHTML = ''
  syncProfileIds = new Map()
  profileList.forEach((profile) => {
    const option = document.createElement('option')
    option.value = profile.slug
    option.innerText = profile.name
    profileSelect.appendChild(option)
    if (typeof profile.id === 'string' && profile.id.length > 0) {
      syncProfileIds.set(profile.slug, profile.id)
    }
  })

  const preferredSlug = shared.selectedProfileSlug ?? profileList.find((p) => p.isDefault)?.slug ?? profileList[0].slug
  profileSelect.value = preferredSlug

  profileSelect.onchange = () => renderSyncFilesList(profileSelect.value)

  await renderSyncFilesList(profileSelect.value)
}

function renderSyncUploadProgress(progress: {
  completedFiles: number
  totalFiles: number
  currentPath: string | null
  bytesSent: number
  fileSize: number
}) {
  const status = document.getElementById('sync-upload-status')
  if (!status) return

  if (!progress.currentPath) {
    status.textContent = `${progress.completedFiles}/${progress.totalFiles} fichier${progress.totalFiles === 1 ? '' : 's'} traité${progress.totalFiles === 1 ? '' : 's'}`
    return
  }

  const percentage = progress.fileSize > 0 ? Math.min(100, Math.floor((progress.bytesSent / progress.fileSize) * 100)) : 0
  status.textContent = `Envoi ${progress.completedFiles + 1}/${progress.totalFiles} — ${progress.currentPath} (${percentage} %)`
}

async function renderSyncFilesList(profileSlug: string) {
  const filesListEl = document.getElementById('sync-files-list')
  if (!filesListEl) return

  const [entries, selection] = await Promise.all([sync.listInstanceEntries(profileSlug), sync.getSelection(profileSlug)])

  filesListEl.innerHTML = ''

  if (entries.length === 0) {
    filesListEl.innerHTML = '<p class="sync-files-empty">Aucun fichier trouvé pour ce profil.</p>'
    return
  }

  entries.forEach((entry) => {
    const row = document.createElement('label')
    row.classList.add('sync-file-row')

    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    checkbox.checked = selection.includes(entry.name)
    checkbox.addEventListener('change', async () => {
      const updated = checkbox.checked ? [...selection, entry.name] : selection.filter((name) => name !== entry.name)
      selection.length = 0
      selection.push(...updated)
      await sync.setSelection(profileSlug, updated)
    })

    const icon = document.createElement('i')
    icon.classList.add('bi', entry.isDirectory ? 'bi-folder' : 'bi-file-earmark')

    const name = document.createElement('span')
    name.innerText = entry.name

    row.appendChild(checkbox)
    row.appendChild(icon)
    row.appendChild(name)
    filesListEl.appendChild(row)
  })
}

async function saveSettings() {
  const minInput = document.getElementById('ram-min') as HTMLInputElement
  const maxInput = document.getElementById('ram-max') as HTMLInputElement
  const launcherActionSelect = document.getElementById('launcher-action-select') as HTMLSelectElement
  const resolutionSelect = document.getElementById('resolution-select') as HTMLSelectElement
  const javaSelect = document.getElementById('java-select') as HTMLSelectElement
  const crashReportsInput = document.getElementById('send-crash-reports') as HTMLInputElement

  const newSettings: IGameSettings = {
    ...currentSettings,
    memory: {
      min: parseFloat(minInput.value),
      max: parseFloat(maxInput.value)
    },
    resolution: {
      height: resolutionList.find((r) => r.value === resolutionSelect.value)?.height ?? 854,
      width: resolutionList.find((r) => r.value === resolutionSelect.value)?.width ?? 480,
      fullscreen: resolutionSelect.value === 'fullscreen'
    },
    java: javaSelect.value === 'bundled' ? 'bundled' : 'path',
    launcherAction: launcherActionSelect.value as 'close' | 'keep' | 'hide',
    sendCrashReports: crashReportsInput.checked
  }

  await settings.set(newSettings)
  currentSettings = newSettings
}

function syncLauncherActionWithCrashReports(enabled: boolean) {
  const launcherActionSelect = document.getElementById('launcher-action-select') as HTMLSelectElement | null
  const lockedMessage = document.getElementById('launcher-action-locked-message') as HTMLParagraphElement | null
  if (!launcherActionSelect) return

  if (enabled) {
    if (launcherActionSelect.value !== 'hide') {
      launcherActionBeforeCrashReports = launcherActionSelect.value as IGameSettings['launcherAction']
    }
    launcherActionSelect.value = 'hide'
    launcherActionSelect.disabled = true
    if (lockedMessage) lockedMessage.hidden = false
    return
  }

  launcherActionSelect.disabled = false
  launcherActionSelect.value = launcherActionBeforeCrashReports
  if (lockedMessage) lockedMessage.hidden = true
}

async function addSkin() {
  const addSkinUrlBtn = document.getElementById('btn-add-skin-url')!
  const addSkinFileBtn = document.getElementById('btn-add-skin-file')!
  const addSkinFileInput = document.getElementById('input-add-skin-file') as HTMLInputElement
  const addSkinUrlInput = document.getElementById('input-add-skin-url') as HTMLInputElement
  const addSkinSlimVariant = document.getElementById('input-add-skin-variant-slim') as HTMLInputElement

  let skinSource: string | ArrayBuffer | null = null
  let variant: 'classic' | 'slim' = 'classic'

  if (addSkinUrlBtn.classList.contains('active')) {
    skinSource = addSkinUrlInput.value.trim()
  } else if (addSkinFileBtn.classList.contains('active')) {
    const file = addSkinFileInput.files?.[0]
    if (file) {
      skinSource = await file.arrayBuffer()
    }
  }

  if (!skinSource) return

  if (addSkinSlimVariant.checked) variant = 'slim'

  try {
    const result = await skin.updateSkin(skinSource, variant)
    if (!result) {
      await Dialog.show('Failed to add skin. Please check the URL or file and try again.', [{ text: 'Close', type: 'ok' }])
      return
    }

    shared.skins = result
    shared.resetMainView()
    shared.resetSkinViews()
  } catch (err) {
    await Dialog.show('An error occurred while adding the skin. Please try again in few minutes.', [{ text: 'Close', type: 'ok' }])
    return
  }
}

function getAvailableResolutions(systemResolution: { width: number; height: number }) {
  return resolutionList.filter((res) => res.width <= systemResolution.width && res.height <= systemResolution.height)
}
