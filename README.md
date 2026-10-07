# Kvitto-backend

Enkel proxy-server för Kvittoappen.

## Driftsätt på Railway

1. Gå till railway.app och logga in med GitHub
2. Klicka "New Project" → "Deploy from GitHub repo"
3. Ladda upp dessa filer ELLER kör:
   - Skapa ett nytt repo på GitHub
   - Ladda upp server.js och package.json
   - Koppla repot till Railway
4. Gå till Variables → lägg till:
   API_KEY = din-anthropic-nyckel
5. Railway ger dig en URL, t.ex:
   https://kvitto-backend-production.up.railway.app

## Lokalt test
npm install
API_KEY=sk-ant-xxx node server.js
