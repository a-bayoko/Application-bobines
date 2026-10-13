# Audit — Application Bobines (13/10/2026)

## État du dépôt
- `main` @ `6f49f5d` (PR #6 fusionnée). `release-v2.0.0-2026-10-03` = même commit.
- Branches anciennes non fusionnées : `codex/analyser-l-etat-actuel-du-projet-application-bobines` (version antérieure, plus en retard que main), `codex/creer-application-pwa-*`, `fix-*`, `feature-zones-16-lines` (fusionnées). Aucune action requise, suppression possible après vérification.
- Pas de CI. Déploiement Vercel (statique, aucun build).
- Application 100 % navigateur : HTML + JS modules, sans dépendance. Données dans `localStorage` (clé `application-bobines-v1`, conservée pour ne rien perdre).

## Structure (v2.1.0)
| Fichier | Rôle |
|---|---|
| `index.html` | Écran unique + fenêtres (ligne/OF, heure, déchet, anomalie, palette, bilan) |
| `src/calculations.js` | Postes, durée de cycle, projection, marge de relève (fonctions pures) |
| `src/production.js` | Bobines, palettes, bilan de poste, export CSV (fonctions pures) |
| `src/app.js` | État, migration, rendu, actions |
| `service-worker.js` | Hors connexion (réseau d'abord) |
| `test/*.test.js` | Tests unitaires (`npm test`) |
| `test/e2e/parcours_operateur.py` | Parcours navigateur |

## Limites connues (non corrigées, hors périmètre de ce lot)
1. **Pas de base centrale** : chaque tablette a ses propres données. La continuité entre équipes fonctionne **sur le même appareil** uniquement. Deux tablettes qui suivent la même ligne ne se voient pas.
2. Pas d'authentification ni de rôles (le n° opérateur est déclaratif ; l'objectif OF reste modifiable par l'opérateur).
3. Pas de lecture QR/photo de l'OF (phase 3 du cahier).
4. Pas d'impression (étiquettes, fiche palette).
5. Photo d'anomalie non gérée.
6. L'historique grossit sans purge (quelques années d'usage restent sous la limite du navigateur, à surveiller).

## Architecture proposée pour la migration backend (à valider avant tout développement)
- **Source de vérité** : base centrale (ex. PostgreSQL via Supabase, ou serveur interne Flexico selon la DSI).
- **Modèle** : `lignes`, `of`, `productions` (un OF sur une ligne), `sessions_operateur` (poste × opérateur), `evenements` (journal immuable : id client unique, heure réelle, heure de saisie, auteur, annulation par événement compensatoire), `palettes`.
- **Idempotence** : chaque action porte un identifiant généré sur la tablette (déjà le cas : `event.id`) → le serveur ignore un doublon (rafraîchissement, réseau coupé, double appui).
- **Hors connexion** : `localStorage`/IndexedDB = file d'attente + cache ; synchronisation à la reconnexion.
- **Temps réel** : vue responsable abonnée aux événements.
- Le format actuel des événements a été pensé pour cette migration (id unique, `productionId`, `declaredAt` ≠ `recordedAt`, `cancelledAt`).

## Questions métier à faire valider (ne pas deviner)
1. Seuils de marge : 20 min pile, et 36–38 min → quelle couleur ? (actuellement ≤ 20 rouge, ≤ 38 orange, paramétrable dans `CONFIG`).
2. 2 bobines par cycle : valable sur toutes les lignes ?
3. Horaires des postes et règle week-end (quels jours ?).
4. Groupes A1/A2/B1/B2 : composition définitive ?
5. Motifs d'arrêt et codes déchets : listes définitives ?
6. EMB15 : 12 bobines (Europe) ou 8 (plastique) — comment le savoir depuis l'OF ?
7. Tare officielle par conditionnement (pour calculer le poids net) ?
8. Champ CA de l'OF : nombre de bobines cible ou autre ?
9. Liste des 13 informations de pilotage attendues par le responsable.
10. Code opérateur : simple numéro déclaratif ou authentification réelle ?
