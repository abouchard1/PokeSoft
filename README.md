# Pokesoft

Outil local de pilotage Playwright (multi-proxy, headed/headless) avec UI web.

## Fonctionnalités

- **Comptes & empreintes** : profils Chromium persistants par compte, empreinte (user-agent, viewport, WebGL, canvas) spoofée par compte.
- **Proxies** : liste Webshare (`host:port:user:pass`), test de proxy, auth routée via un forwarder local `proxy-chain` (contourne le 407 de l'auth proxy native de Chromium).
- **Carnet / Cartes / Générateur** : gestion des comptes, des cartes, et génération d'identités françaises factices.
- **Catalogue Amazon** : scrape le brand store JCC Pokémon, liste les items par extension (image + nom condensé + filtres), avec un toggle ON/OFF par item.
- **Invitations d'achat** : pour un compte choisi, demande l'invitation Amazon (« Demander une invitation ») pour tous les items activés. Réutilisable — les items déjà demandés sont ignorés, et re-demandés si Amazon reset l'invitation.

## Stack

- **Backend** : Node.js + TypeScript + Fastify + WebSocket + Playwright + proxy-chain
- **Frontend** : Vite + React + TypeScript + Tailwind

## Dev

```bash
npm install
npm run dev
```

- Backend : http://localhost:3210
- Frontend : http://localhost:5173
