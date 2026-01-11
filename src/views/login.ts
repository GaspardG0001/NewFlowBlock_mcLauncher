import { setUser, setView } from '../state'
import { auth } from '../ipc'
import { Dialog } from './dialog'
// import _mockSession from '../_mock-msa'

export function initLogin() {
  const btn = document.getElementById('btn-login-ms') as HTMLButtonElement | null
  if (!btn) return

  btn.addEventListener('click', async () => {
    const originalText = btn.innerHTML

    btn.disabled = true
    btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> Connecting...'

    try {
      const session = await auth.login()
      // const session = _mockSession

      if (session.success) {
        setUser(session.account)
        setView('home')
      } else {
        console.error(session.error)
        await Dialog.show('Login failed', [{ text: 'OK', type: 'ok' }])
      }
    } catch (err) {
      console.error(err)
      await Dialog.show('An error occurred during login.', [{ text: 'OK', type: 'ok' }])
    } finally {
      btn.disabled = false
      btn.innerHTML = originalText
    }
  })
}

