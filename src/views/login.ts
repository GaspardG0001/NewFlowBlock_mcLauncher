import { setUser, setView } from '../state'
import { auth, skin } from '../ipc'
import { Dialog } from './dialog'
import logger from 'electron-log/renderer'

type MessagePart = string | HTMLElement

function createExternalLink(text: string, href: string): HTMLAnchorElement {
  const link = document.createElement('a')
  link.href = href
  link.target = '_blank'
  link.rel = 'noopener noreferrer'
  link.textContent = text
  return link
}

function createChecklistMessage(introductionText: string, items: MessagePart[][], supportText: string): DocumentFragment {
  const content = document.createDocumentFragment()

  const introduction = document.createElement('p')
  introduction.textContent = introductionText

  const prompt = document.createElement('p')
  prompt.textContent = 'Vérifiez les points suivants :'

  const checklist = document.createElement('div')
  checklist.className = 'dialog-checklist'

  const list = document.createElement('ul')
  items.forEach((parts) => {
    const item = document.createElement('li')
    item.append(...parts)
    list.appendChild(item)
  })
  checklist.appendChild(list)

  const support = document.createElement('p')
  support.append(supportText)

  const supportLink = document.createElement('a')
  supportLink.href = 'mailto:support@mcflowblock.com'
  supportLink.textContent = 'support@mcflowblock.com'
  support.append(supportLink, '.')

  content.append(introduction, prompt, checklist, support)
  return content
}

function createMissingXboxProfileMessage(): DocumentFragment {
  return createChecklistMessage(
    'Nous avons pu établir la connexion avec Microsoft, mais ce compte ne semble pas disposer d’un profil Xbox.',
    [
      [
        'Vous avez créé votre profil Xbox sur ',
        createExternalLink('Xbox Live', 'https://start.ui.xboxlive.com/CreateAccount'),
        '.'
      ],
      [
        'Votre date de naissance et vos ',
        createExternalLink('paramètres de confidentialité Xbox', 'https://account.xbox.com/Settings'),
        ' autorisent les services en ligne.'
      ]
    ],
    'Après avoir créé ou configuré votre profil Xbox, réessayez de vous connecter. Si le problème persiste, contactez nos équipes support à '
  )
}

function createMissingMinecraftProfileMessage(): DocumentFragment {
  return createChecklistMessage(
    'Nous avons pu établir la connexion avec Microsoft et Xbox, mais ce compte ne semble pas disposer d’un profil Minecraft valide.',
    [
      [
        'Vous disposez de ',
        createExternalLink(
          'Minecraft Java & Bedrock Edition',
          'https://www.minecraft.net/fr-fr/store/minecraft-java-bedrock-edition-pc'
        ),
        ' ou d’un ',
        createExternalLink('abonnement Xbox Game Pass compatible', 'https://www.xbox.com/fr-FR/xbox-game-pass'),
        '.'
      ],
      [
        'Votre profil est bien configuré sur ',
        createExternalLink('Minecraft.net', 'https://www.minecraft.net/msaprofile'),
        '.'
      ]
    ],
    'Si vous pensez toujours qu’il s’agit d’une erreur, contactez nos équipes support à '
  )
}

export function initLogin() {
  const btn = document.getElementById('btn-login-ms') as HTMLButtonElement | null
  if (!btn) return

  btn.addEventListener('click', async () => {
    const originalText = btn.innerHTML

    btn.disabled = true
    btn.innerHTML = '<i class="bi bi-circle-notch spin"></i> Connexion en cours...'

    try {
      const session = await auth.login()

      if (session.success) {
        const [__, skins, capes, avatar] = await Promise.all([skin.reload(session.account), skin.getSkin(), skin.getCape(), skin.getAvatar()])

        setUser(session.account, { skins, capes, avatar })
        setView('home')
      } else {
        if (session.code === 'AUTH_CANCELLED') return

        logger.error(session.error)
        if (session.code === 'XBOX_PROFILE_MISSING') {
          await Dialog.show(createMissingXboxProfileMessage(), [{ text: 'Fermer', type: 'ok' }], 'Profil Xbox introuvable')
        } else if (session.code === 'MINECRAFT_PROFILE_MISSING') {
          await Dialog.show(createMissingMinecraftProfileMessage(), [{ text: 'Fermer', type: 'ok' }], 'Profil Minecraft introuvable')
        } else {
          await Dialog.show('Une erreur est survenue lors de la connexion.', [{ text: 'Réessayer', type: 'ok' }])
        }
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

