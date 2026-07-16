import type { Account, IAvatar, ICape, ISkin } from 'eml-lib'
import logger from 'electron-log/renderer'
import shared from './shared'
import { permissions } from './ipc'

export type ViewName = 'loading' | 'login' | 'home' | 'settings'
export type BlockingViewName = 'maintenance' | 'update'

export function getUser() {
  return shared.account
}

export async function setUser(account: Account, assets: { skins: ISkin[] | null; capes: ICape[] | null; avatar: IAvatar | null }) {
  shared.account = account
  shared.skins = assets.skins
  shared.capes = assets.capes
  shared.avatar = assets.avatar
  await updateUserInterface()
  void updateUserRole(account)
  window.dispatchEvent(new Event('app:user-changed'))
}

export function logout() {
  shared.account = null
  shared.skins = null
  shared.capes = null
  shared.avatar = null
  const nameEl = document.getElementById('user-name')
  const roleEl = document.getElementById('settings-user-role')
  if (nameEl) nameEl.innerText = ''
  if (roleEl) roleEl.innerText = 'Membre'
  window.dispatchEvent(new Event('app:user-changed'))
}

async function updateUserInterface() {
  if (!shared.account || !shared.skins) return

  logger.log("Mise à jour de l'interface pour l'utilisateur :", shared.account.name)

  const nameEl = document.getElementById('user-name')
  const avatarEl = document.getElementById('user-avatar') as HTMLImageElement
  const nameSettingsEl = document.getElementById('settings-user-name')
  const uuidSettingsEl = document.getElementById('settings-user-uuid')
  const typeSettingsEl = document.getElementById('settings-user-type')
  const avatarSettingsEl = document.getElementById('settings-user-avatar') as HTMLImageElement

  if (nameEl) nameEl.innerText = shared.account.name
  if (avatarEl) avatarEl.src = `https://minotar.net/cube/${encodeURIComponent(shared.account.name)}/50`
  if (nameSettingsEl) nameSettingsEl.innerText = shared.account.name
  if (uuidSettingsEl) uuidSettingsEl.innerText = `UUID: ${shared.account.uuid}`
  if (typeSettingsEl) typeSettingsEl.innerHTML = getAccountIcon(shared.account.meta.type)
  if (avatarSettingsEl) avatarSettingsEl.src = shared.avatar?.url ?? 'https://minotar.net/avatar/steve/256.png'

  shared.resetMainView()
  shared.resetSkinViews()
  shared.resetCapesViews()
}

async function updateUserRole(account?: Account) {
  const roleEl = document.getElementById('settings-user-role')
  if (!roleEl) return

  try {
    const role = await permissions.getRole(account)
    roleEl.innerText = role
  } catch (err) {
    logger.error('Impossible de recuperer le role utilisateur :', err)
    roleEl.innerText = 'Membre'
  }
}

export function setView(view: ViewName) {
  const target = document.querySelector(`.view[data-view="${view}"]`) as HTMLElement
  if (!target) return logger.error(`View ${view} not found`)

  const isOverlay = target.classList.contains('overlay')

  if (view === 'settings') resetSettingsTab()

  if (!isOverlay) {
    document.querySelectorAll('.view').forEach((el) => {
      if (!el.classList.contains('overlay')) {
        el.classList.remove('active')
      }
    })
  }

  target.classList.add('active')
}

export function setViewWithTab(view: ViewName, tab?: string) {
  setView(view)
  if (view === 'settings' && tab) {
    setSettingsTab(tab)
  }
}

export function setBlockingView(view: BlockingViewName) {
  setTimeout(() => {
    document.querySelector('div#view-loading')?.classList.add('loaded')
  }, 400)
  setTimeout(() => {
    document.querySelector(`div#view-${view}`)?.classList.add('loaded')
  }, 200)
}

export function closeOverlay(view: ViewName) {
  const target = document.querySelector(`.view[data-view="${view}"]`)
  target?.classList.remove('active')
}

function getAccountIcon(type: 'msa' | 'yggdrasil' | 'azuriom' | 'crack') {
  switch (type) {
    case 'msa':
      return '<i class="bi bi-microsoft"></i>Compte Microsoft'
    case 'yggdrasil':
      return '<i class="bi bi-person-fill"></i>Compte Yggdrasil'
    case 'azuriom':
      return '<i class="bi bi-globe"></i>Compte Azuriom'
    case 'crack':
      return '<i class="bi bi-person-slash"></i>Compte cracké'
    default:
      return 'Type de compte inconnu'
  }
}

function resetSettingsTab() {
  setSettingsTab('game')
}

function setSettingsTab(tab: string) {
  const tabButtons = document.querySelectorAll('.nav-btn')
  const tabContents = document.querySelectorAll('.tab-content')
  tabButtons.forEach((b) => b.classList.remove('active'))
  tabContents.forEach((content) => content.classList.remove('active'))

  const tabButton = document.querySelector(`.nav-btn[data-tab="${tab}"]`) as HTMLElement | null
  const tabContent = document.getElementById(`tab-${tab}`)

  if (tabButton && tabContent) {
    tabButton.classList.add('active')
    tabContent.classList.add('active')
    return
  }

  if (tabButtons[0] && tabContents[0]) {
    tabButtons[0].classList.add('active')
    tabContents[0].classList.add('active')
  }
}



