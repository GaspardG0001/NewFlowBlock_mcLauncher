import { setViewWithTab, getUser } from '../state'
import { game, news, server, settings, profiles, permissions } from '../ipc'
import { Dialog } from './dialog'
import logger from 'electron-log/renderer'

const formatDate = (dateString: string) => {
  const date = new Date(dateString)
  return date.toLocaleDateString('fr-FR', { month: 'short', day: 'numeric', year: 'numeric' })
}

const escapeHtml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')

const isValidHttpUrl = (value: string) => {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

export function initHome() {
  const body = document.body
  const playBtn = document.getElementById('btn-play')
  const settingsBtn = document.getElementById('btn-settings')
  const profileBtn = document.getElementById('btn-profile')
  const progressContainer = document.getElementById('launch-progress-container')
  const progressBar = document.getElementById('launch-progress-bar')
  const progressLabel = document.getElementById('launch-progress-label')
  const progressPercent = document.getElementById('launch-progress-percent')
  const statusDot = document.getElementById('server-status-dot')
  const statusText = document.getElementById('server-status-text')
  const playerCount = document.getElementById('player-count')
  const newsList = document.getElementById('news-list')
  const profileSelector = document.getElementById('profile-selector')
  const profileDropdown = document.getElementById('profile-dropdown')
  const currentProfileName = document.getElementById('current-profile-name')
  const currentSelectedProfile = document.getElementById('current-selected-profile')

  let selectedProfile: any = null
  let allProfiles: any[] = []
  let currentRole: 'Membre' | 'Développeur' = 'Membre'
  let totalToDownload = 0
  let totalDownloadedByType: { type: string; size: number }[] = []

  const isDeveloperProfile = (profile: any) => typeof profile?.name === 'string' && profile.name.startsWith('[DEV] ')

  const canAccessDeveloperProfiles = () => currentRole === 'Développeur'

  const getVisibleProfiles = () =>
    canAccessDeveloperProfiles() ? allProfiles : allProfiles.filter((profile) => !isDeveloperProfile(profile))

  const setNoProfileAvailableState = () => {
    selectedProfile = null
    if (currentProfileName) currentProfileName.innerText = 'Aucun profil disponible'
    if (currentSelectedProfile) currentSelectedProfile.innerText = 'Aucun profil disponible'
    if (profileDropdown) {
      profileDropdown.innerHTML = '<div class="profile-option disabled">Aucun profil disponible</div>'
    }
    if (playBtn) playBtn.setAttribute('disabled', 'true')
  }

  const setPlayAvailability = () => {
    if (!playBtn) return
    const hasPlayableProfile = Boolean(selectedProfile)
    playBtn.toggleAttribute('disabled', !hasPlayableProfile)
  }

  const loadProfiles = async () => {
    const user = getUser()
    if (!user) return

    currentRole = await permissions.getRole(user.name)
    allProfiles = await profiles.get()

    const visibleProfiles = getVisibleProfiles()
    if (visibleProfiles.length === 0) {
      setNoProfileAvailableState()
      return
    }

    const preferredProfile = visibleProfiles.find((profile) => profile.isDefault) ?? visibleProfiles[0]
    selectProfile(preferredProfile)
    renderDropdown()
  }

  const renderDropdown = () => {
    if (!profileDropdown) return
    const visibleProfiles = getVisibleProfiles()

    if (visibleProfiles.length === 0) {
      setNoProfileAvailableState()
      return
    }

    profileDropdown.innerHTML = visibleProfiles
      .map(
        (p) => `
      <div class="profile-option ${selectedProfile?.id === p.id ? 'active' : ''}" data-id="${p.id}">
        ${p.name}
      </div>
    `
      )
      .join('')

    profileDropdown.querySelectorAll('.profile-option').forEach((opt) => {
      opt.addEventListener('click', (e) => {
        const id = (e.target as HTMLElement).dataset.id
        const profile = visibleProfiles.find((p) => p.id === id)
        if (profile) selectProfile(profile)
        profileSelector?.classList.remove('open')
      })
    })

    setPlayAvailability()
  }

  const selectProfile = (profile: any) => {
    if (isDeveloperProfile(profile) && !canAccessDeveloperProfiles()) {
      return
    }

    selectedProfile = profile
    if (currentProfileName) currentProfileName.innerText = profile.name
    if (currentSelectedProfile) currentSelectedProfile.innerText = profile.name
    renderDropdown()
    updateServerStatus()
    setPlayAvailability()
  }

  const updateServerStatus = async () => {
    if (statusDot) {
      statusDot.classList.remove('online', 'offline')
      statusDot.classList.add('pinging')
    }
    if (statusText) statusText.innerHTML = 'Ping en cours...'
    if (playerCount) playerCount.innerHTML = ''

    const status = selectedProfile ? await server.getStatus(selectedProfile.ip, selectedProfile.port || 25565) : null

    if (status) {
      if (statusDot) {
        statusDot.classList.remove('pinging', 'offline')
        statusDot.classList.add('online')
      }
      if (statusText) statusText.innerHTML = 'En ligne'

      if (playerCount) {
        playerCount.innerHTML = `${status.players.online.toLocaleString()} joueurs connectés`
      }
    } else {
      if (statusDot) {
        statusDot.classList.remove('pinging', 'online')
        statusDot.classList.add('offline')
      }
      if (statusText) statusText.innerHTML = 'Hors ligne'
      if (playerCount) playerCount.innerHTML = ''
    }
  }

  const loadNews = async () => {
    if (!newsList) return
    newsList.innerHTML = '<div style="text-align:center; padding: 20px; color: #888;">Chargement des actualités...</div>'
    try {
      const rawFeed = await news.getNews()
      const feed = Array.isArray(rawFeed)
        ? rawFeed
        : Array.isArray((rawFeed as any)?.items)
          ? (rawFeed as any).items
          : []

      newsList.innerHTML = ''

      if (feed.length === 0) {
        newsList.innerHTML = '<div style="text-align:center; color: #888; padding: 20px;">Aucune actualité disponible.</div>'
        return
      }

      feed.slice(0, 2).forEach((item: any) => {
        const safeTitle = escapeHtml(item?.title ?? 'Article')
        const safeDescription = escapeHtml(item?.description ?? '')
        const safeDate = item?.publishedAt ? formatDate(item.publishedAt) : ''
        const safeLink = isValidHttpUrl(item?.link ?? '') ? item.link : '#'
        const safeBackground = typeof item?.image === 'string' && item.image.length > 0
          ? `background-image: linear-gradient(180deg, rgba(0,0,0,0.20) 0%, rgba(0,0,0,0.82) 70%), url('${item.image.replaceAll("'", '%27')}');`
          : 'background: linear-gradient(155deg, rgba(18,23,34,0.9) 0%, rgba(11,14,20,0.95) 100%);'

        const articleHTML = `
          <a class="news-article news-article-card" href="${safeLink}" target="_blank" rel="noopener noreferrer" style="${safeBackground}">
            <div class="article-overlay"></div>
            <div class="article-content-card">
              <span class="date">${safeDate}</span>
              <h3>${safeTitle}</h3>
              <p>${safeDescription}</p>
            </div>
          </a>
        `

        newsList.insertAdjacentHTML('beforeend', articleHTML)
      })
    } catch (error) {
      logger.error('Unable to load RSS news:', error)
      newsList.innerHTML = '<div style="text-align:center; color: #888; padding: 20px;">Impossible de charger les actualités.</div>'
    }
  }

  window.addEventListener('app:user-changed', () => {
    void loadProfiles()
  })

  if (getUser()) {
    void loadProfiles()
  }

  updateServerStatus()
  loadNews()

  const setIndeterminate = (active: boolean) => {
    if (!progressBar || !progressPercent) return

    if (active) {
      progressBar.classList.add('indeterminate')
      progressPercent.style.display = 'none'
    } else {
      progressBar.classList.remove('indeterminate')
      progressPercent.style.display = 'block'
    }
  }

  settingsBtn?.addEventListener('click', () => {
    setViewWithTab('settings', 'game')
  })

  profileBtn?.addEventListener('click', async () => {
    setViewWithTab('settings', 'account')
  })

  playBtn?.addEventListener('click', async () => {
    if (!selectedProfile) {
      await Dialog.show('Aucun profil n\'est disponible pour votre compte.', [{ text: 'Fermer', type: 'ok' }])
      return
    }

    if (isDeveloperProfile(selectedProfile) && !canAccessDeveloperProfiles()) {
      await Dialog.show('Ce profil est réservé aux développeurs.', [{ text: 'Fermer', type: 'ok' }])
      return
    }

    setIndeterminate(true)
    if (playBtn) playBtn.style.display = 'none'
    if (progressContainer) progressContainer.classList.remove('hidden')
    if (progressBar) progressBar.style.width = '0%'
    if (progressPercent) progressPercent.innerText = '0%'

    const user = getUser()
    if (!user) return

    const config = await settings.get()

    const message = `
  Prêt à lancer le jeu avec les paramètres suivants :
      
  👤 Compte : ${user.name}
  🧠 RAM : ${config.memory.min} - ${config.memory.max}
  ☕️ Java : ${config.java}
  🖥️ Résolution : ${config.resolution.width}x${config.resolution.height}
  🚀 Action au lancement : ${config.launcherAction}
    `

    logger.log(message)
    game.launch({ account: user, settings: config, profileSlug: selectedProfile?.slug })
  })

  profileSelector?.querySelector('.selected-profile')?.addEventListener('click', () => {
    profileSelector.classList.toggle('open')
  })

  body.addEventListener('click', (e) => {
    if (!profileSelector?.contains(e.target as Node)) {
      profileSelector?.classList.remove('open')
    }
  })

  game.launchComputeDownload(() => {
    setIndeterminate(true)
    if (progressLabel) progressLabel.innerText = 'Préparation du téléchargement...'
    if (progressPercent) progressPercent.innerText = ''
  })
  game.launchDownload((download) => {
    setIndeterminate(false)
    totalToDownload = download.total.size
    if (progressLabel) progressLabel.innerText = `Téléchargement des fichiers...`
  })
  game.downloadProgress((progress) => {
    if (!totalDownloadedByType.find((t) => t.type === progress.type)) {
      totalDownloadedByType.push({ type: progress.type, size: progress.downloaded.size })
    } else {
      totalDownloadedByType[totalDownloadedByType.findIndex((t) => t.type === progress.type)].size = progress.downloaded.size
    }
    if (progressBar && progressLabel && progressPercent) {
      const downloadedSum = totalDownloadedByType.reduce((acc, curr) => acc + curr.size, 0)
      progressBar.style.width = `${Math.min((downloadedSum / totalToDownload) * 100, 100)}%`
      progressLabel.innerText = `Téléchargement des ${progress.type === 'JAVA' ? 'fichiers Java' : 'fichiers du jeu'}...`
      progressPercent.innerText = `${Math.round(Math.min((downloadedSum / totalToDownload) * 100, 100))}%`
    }
  })
  game.launchInstallLoader(() => {
    setIndeterminate(true)
    if (progressLabel) progressLabel.innerText = 'Extraction des fichiers...'
    if (progressPercent) progressPercent.innerText = ''
  })
  game.launchExtractNatives(() => {
    setIndeterminate(true)
    if (progressLabel) progressLabel.innerText = 'Extraction des fichiers...'
  })
  game.launchCopyAssets(() => {
    setIndeterminate(true)
    if (progressLabel) progressLabel.innerText = 'Extraction des fichiers...'
  })
  game.launchPatchLoader(() => {
    setIndeterminate(true)
    if (progressLabel) progressLabel.innerText = 'Finalisation de l\'installation...'
  })
  game.launchLaunch(() => {
    setIndeterminate(true)
    if (progressLabel) progressLabel.innerText = 'Lancement du jeu...'
  })
  game.launched(() => {
    setTimeout(() => {
      if (playBtn) playBtn.style.display = 'block'
      if (progressContainer) progressContainer.classList.add('hidden')
      if (progressBar) progressBar.style.width = '0%'
      if (progressPercent) progressPercent.innerText = ''
    }, 10000)
  })
}





