import { setUser, setView } from '../state'
import { auth } from '../ipc'
import { Dialog } from './dialog'
import logger from 'electron-log/renderer'
// import _mockSession from '../_mock-msa'

export function initLogin() {
  const btn = document.getElementById('btn-login-ms') as HTMLButtonElement | null
  if (!btn) return

  btn.addEventListener('click', async () => {
    const originalText = btn.innerHTML

    btn.disabled = true
    btn.innerHTML = '<i class="bi bi-circle-notch fa-spin"></i> Connexion en cours...'

    try {
      const session = await auth.login()
      // const session = _mockSession

      if (session.success) {
        setUser(session.account)
        setView('home')
      } else {
        logger.error(session.error)
        await Dialog.show('Une erreur est survenue lors de la connexion.', [{ text: 'Réessayer', type: 'ok' }])
      }
    } catch (err) {
      logger.error(err)
      await Dialog.show('Une erreur est survenue lors de la connexion.', [{ text: 'Réessayer', type: 'ok' }])
    } finally {
      btn.disabled = false
      btn.innerHTML = originalText
    }
  })
}

