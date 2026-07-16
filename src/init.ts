import { setBlockingView, setUser, setView } from './state'
import { auth, background, maintenance, skin } from './ipc'
import logger from 'electron-log/renderer'

const DEFAULT_BACKGROUND = '/src/static/images/bg.png'
const DEFAULT_LOGO = '/src/static/images/logo.png'
const REMOTE_LOGO = 'https://mcflowblock.com/eml-logo'
const dateFormatOptions: Intl.DateTimeFormatOptions = {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit'
}

function preloadImage(url: string): Promise<void> {
  return new Promise((resolve) => {
    const img = new Image()
    img.src = url
    img.onload = () => resolve()
    img.onerror = () => resolve()
  })
}

function resolveImageWithFallback(primaryUrl: string, fallbackUrl: string): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image()
    img.src = primaryUrl
    img.onload = () => resolve(primaryUrl)
    img.onerror = () => resolve(fallbackUrl)
  })
}

export async function initializeApp() {
  logger.log('Initialisation du launcher...')

  const bgElement = document.querySelector('.app-background') as HTMLElement
  const maintenanceDates = document.getElementById('maintenance-dates')!
  const maintenanceReason = document.getElementById('maintenance-reason')!
  const logoElements = Array.from(document.querySelectorAll('.logo')) as HTMLImageElement[]
  const bg = await background.get()
  const session = await auth.refresh()
  const mn = await maintenance.get(session.success ? session.account : undefined)
  const bgUrl = bg?.file?.url ?? DEFAULT_BACKGROUND
  const logoUrl = await resolveImageWithFallback(REMOTE_LOGO, DEFAULT_LOGO)

  if (mn) {
    const start = new Date(mn.startTime as Date)
    const end = new Date(mn.endTime as Date)
    maintenanceDates.innerText = `Du ${start.toLocaleString('fr-FR', dateFormatOptions)} au ${end.toLocaleString('fr-FR', dateFormatOptions)}`
    maintenanceReason.innerText = mn.message ?? 'Veuillez revenir plus tard.'
    setBlockingView('maintenance')
    return
  }
  try {
    const [_, __] = await Promise.all([
      preloadImage(bgUrl),
      preloadImage(logoUrl)
      // Promise.resolve(_mockSession)
    ])

    if (bgElement) bgElement.style.backgroundImage = `url('${bgUrl}')`
    logoElements.forEach((logoElement) => {
      logoElement.src = logoUrl
    })

    if (session.success) {
      const [__, skins, capes, avatar] = await Promise.all([skin.reload(session.account), skin.getSkin(), skin.getCape(), skin.getAvatar()])

      setUser(session.account, { skins, capes, avatar })
      setView('home')
    } else {
      setView('login')
    }
  } catch (err) {
    logger.error('Error while initializing launcher:', err)
    if (bgElement) bgElement.style.backgroundImage = `url('${DEFAULT_BACKGROUND}')`
    logoElements.forEach((logoElement) => {
      logoElement.src = DEFAULT_LOGO
    })
    setView('login')
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 400))
    document.querySelector('div#view-loading')?.classList.add('loaded')
    await new Promise((resolve) => setTimeout(resolve, 200))
    document.body.classList.add('loaded')
  }
}

