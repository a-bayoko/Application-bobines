# Application Bobines — v2.1.1

Suivi des cycles de production de bobines par ligne (Flexico). PWA utilisable sur tablette atelier et téléphone.

## Utilisation au poste
1. Saisir son **n° opérateur** (obligatoire pour enregistrer une action).
2. Vérifier le **poste** (choisi automatiquement selon l'heure au premier lancement ; un bandeau prévient si le poste sélectionné est terminé).
3. Choisir son **groupe de lignes** (A1, A2, B1, B2).
4. Toucher une ligne :
   - non configurée → renseigner métrage et vitesse du banc de tirage (+ OF, objectif, bobines/palette, dernière bobine déjà faite si l'OF est déjà commencé) ;
   - puis **▶ DÉMARRER** ou **🕒 HEURE DE DÉPART**.
5. À chaque fin de cycle : **✓ CYCLE TERMINÉ** → bobines numérotées, projection recalée sur l'heure réelle, palette clôturée automatiquement si elle est complète (on saisit seulement le poids brut).
6. Arrêt/reprise, déchet, anomalie, correction, fin d'OF depuis le détail de la ligne.
7. **📋 Bilan du poste** en fin de poste : résumé, passation à l'équipe suivante, export CSV pour Excel.

## Lancer en local
```
npm start            # http://localhost:4173
npm test             # tests unitaires (Node 18+)
npm run test:e2e     # parcours navigateur (Python + Playwright, serveur lancé)
```

## Déploiement
Site statique : déposer les fichiers dans le dépôt GitHub, Vercel publie automatiquement. Aucun build.
Les tablettes reçoivent la nouvelle version au prochain chargement avec réseau.

## Documents
- `JOURNAL.md` : modifications, causes, tests.
- `AUDIT.md` : état technique, limites, architecture backend proposée, questions métier ouvertes.
