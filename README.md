# Game Recorder

Application Windows qui enregistre automatiquement les parties de **League of Legends** et **Valorant**, sépare les pistes audio et repère les moments forts pour en faire des clips.

On lance le jeu, l'enregistrement démarre tout seul. À la fin de la partie, la vidéo arrive dans la bibliothèque avec ses kills déjà marqués sur la timeline.

## Fonctionnalités

- **Détection automatique des parties** : surveillance des processus LoL et Valorant, démarrage et arrêt de l'enregistrement sans intervention.
- **Enregistrement via OBS Studio**, piloté par obs-websocket dans une instance isolée (profil et scènes séparés de l'OBS personnel de l'utilisateur). Encodage NVENC, résolution, FPS et débit réglables.
- **Pistes audio séparées** : mix complet, micro, Discord et son du jeu, pour pouvoir baisser ou couper chaque source au montage.
- **Highlights automatiques** :
  - LoL : événements lus en direct via l'API *Live Client Data* du client de jeu.
  - Valorant : historique du match récupéré via l'API HenrikDev, puis aligné sur la vidéo (estimation du décalage à partir des changements de score observés pendant la partie).
- **Marqueurs manuels** avec un raccourci global (F9 par défaut).
- **Post-traitement FFmpeg** : remux MKV → MP4 sans ré-encodage, extraction des pistes audio, miniature, métadonnées.
- **Bibliothèque et lecteur intégrés** : favoris, timeline des highlights, export de clips avec volume réglable par piste.
- **Gestion du stockage** : quota disque configurable, reprise d'un enregistrement interrompu après un crash.
- **Application de fond** : icône dans la barre des tâches, lancement au démarrage de Windows, notifications.

## Stack

- **Electron** (process main / renderer, IPC, protocole personnalisé pour servir les vidéos, tray, raccourcis globaux)
- **Node.js** (JavaScript, CommonJS)
- **obs-websocket-js** pour piloter OBS
- **FFmpeg** (ffmpeg-static) pour le post-traitement et l'export de clips
- **electron-builder** pour l'installeur Windows (NSIS)
- Interface en HTML / CSS / JavaScript sans framework

## Architecture

```
src/
├── main/
│   ├── main.js          fenêtre, tray, IPC, raccourcis
│   ├── recorder.js      orchestrateur : détecte les parties, pilote OBS, collecte les événements
│   ├── obs.js           instance OBS isolée, scènes, sources et pistes audio
│   ├── postprocess.js   MKV brut → dossier VOD (MP4, pistes, miniature, meta.json)
│   ├── clips.js         export de clips
│   ├── library.js       bibliothèque et quota disque
│   ├── games/           détection des processus, API client LoL, client Riot
│   └── highlights/      calcul des moments forts LoL et Valorant
└── renderer/            interface : bibliothèque, lecteur, réglages
```

## Prérequis

- Windows 10 ou 11
- [OBS Studio](https://obsproject.com/) 28 ou plus récent installé
- Une carte NVIDIA pour l'encodeur par défaut (modifiable dans les réglages)
- Pour les highlights Valorant : une clé API gratuite [HenrikDev](https://docs.henrikdev.xyz/), à saisir dans les réglages

## Lancer en local

```bash
npm install
npm start
```

## Construire l'installeur

```bash
npm run dist
```

L'installeur est généré dans `dist/`.

---

Projet personnel, développé avec l'aide de Claude Code.
