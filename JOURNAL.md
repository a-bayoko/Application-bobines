# Journal des modifications — Application Bobines

Format imposé par le dossier de passation (§12). Base de départ : `main` @ `6f49f5d` (PR #6, 16 lignes A1/A2/B1/B2), identique à `release-v2.0.0-2026-10-03`.

---

## v2.1.0 — 13/10/2026 — branche `amelioration-v2.1`

### Lot 1 — Corrections de bugs

| # | Symptôme | Cause racine | Correction | Fichiers | Tests |
|---|---|---|---|---|---|
| B1 | Les 12 lignes sans paramètres confirmés affichaient **3000 m / 60 m/min** | Valeur par défaut codée en dur dans `app.js` → **donnée inventée** (interdit par le cahier des charges) | Métrage/vitesse = inconnus (`null`) ; la carte affiche « À configurer » et un bouton « Renseigner métrage et vitesse ». Migration : les lignes jamais démarrées avec exactement 3000/60 sont remises à « inconnu » | `src/app.js`, `src/calculations.js` | unitaire « aucune durée inventée… » ; e2e « L8 : à configurer », « aucun 3000 m inventé » |
| B2 | **« ⚙ CORRIGER » et l'ouverture d'une ligne non démarrée plantaient** (fenêtre jamais ouverte) ; l'aperçu de durée ne s'affichait jamais | `form.elements.length` renvoie le *nombre* de champs du formulaire, pas le champ nommé « length » (métrage) → `TypeError` en mode strict | Accès aux champs par `form.elements.namedItem()` | `src/app.js` | e2e « L4 démarré… » (passe par le formulaire). Bug reproduit sur la v2.0.0 avant correction |
| B3 | Le n° opérateur **s'effaçait pendant la saisie** | `render()` toutes les 10 s réécrivait le champ | Le champ n'est plus réécrit quand il a le focus | `src/app.js` | e2e « saisie opérateur non écrasée » |
| B4 | Boutons « DÉMARRER / HEURE DE DÉPART » **visibles sur une ligne déjà en production** → risque de redémarrer un OF | CSS `display:flex` écrasait l'attribut `hidden` | Règle globale `[hidden]{display:none!important}` + `start()` refuse si un OF est déjà en cours | `src/styles.css`, `src/app.js` | e2e (captures 04/05) |
| B5 | Les mises à jour de l'appli n'arrivaient pas sur les tablettes sans changer le n° de cache à la main | Service worker « cache d'abord » | Stratégie « réseau d'abord », cache seulement hors connexion ; `skipWaiting` + `clients.claim` | `service-worker.js` | contrôle manuel |
| B6 | Double appui sur « BOBINE TERMINÉE » = double enregistrement (T13) | Aucune protection | Confirmation demandée si un cycle a été validé il y a moins de 60 s sur la même ligne | `src/app.js` | e2e « double appui refusé » |
| B7 | Suppression d'une ligne en production sans confirmation | — | Refus si OF en cours, confirmation sinon ; l'historique est conservé | `src/app.js` | contrôle manuel |
| B8 | Correction de l'heure de départ sans trace de l'ancienne valeur | Champ `before` absent | `before` enregistré dans l'événement `correction-depart` | `src/app.js` | — |
| B9 | 2 tests échouaient sur un appareil à l'heure de Paris | Tests comparés à des dates UTC (`toISOString`) | Comparaison en heure locale | `test/calculations.test.js` | suite verte en UTC, Paris, New York |
| B10 | Arrêt possible deux fois de suite ; « Fin d'OF » pendant un arrêt laissait l'arrêt ouvert | Pas de contrôle d'état | Contrôles ajoutés ; la fin d'OF clôt l'arrêt en cours | `src/app.js` | e2e « validation bloquée pendant l'arrêt » |
| B11 | Un poste resté sélectionné après la relève (ex. « Matin » à 15 h) affichait toutes les lignes « Poste terminé » sans explication | Aucun contrôle | Bandeau « Le poste sélectionné est terminé → Passer au poste X » ; au premier lancement le poste est choisi selon l'heure | `src/app.js`, `src/calculations.js` | unitaire « poste suggéré » ; e2e |

Risque résiduel : B1 — si une ligne avait *réellement* 3000 m / 60 m/min sans jamais avoir été démarrée, il faudra la ressaisir une fois.

### Lot 2 — Gestion des bobines par machine (cahier des charges §6, §7, §8 ; passation §5, §9)

- **Numérotation des bobines** : « ✓ CYCLE TERMINÉ — bobines 37–38 » ajoute le nombre de bobines/cycle et horodate. Pas de doublon, pas de saut (T08).
- **Recalage réel** : la projection repart de l'heure réelle de la dernière validation, et non plus d'un départ théorique (§6 point 4).
- **Continuité entre équipes** (même appareil) : l'équipe suivante voit la dernière bobine et reprend à la suivante. Les cycles non validés par l'équipe précédente ne sont **pas** attribués à la nouvelle équipe : on affiche « Compteur non validé depuis HH:MM : vérifiez la dernière bobine ».
- **Reprise d'un OF déjà commencé** : champ « Dernière bobine déjà réalisée » au démarrage.
- **Annuler le dernier cycle** (trace conservée, événement marqué annulé).
- **Palettes** : capacité facultative (boutons 12 · MT12/EMB15, 8, 10, 24 · EMB14, ou saisie libre). Quand la bobine qui complète la palette est validée → « PALETTE n COMPLÈTE » avec OF, plage de bobines, heure et opérateur déjà remplis ; on demande **seulement le poids brut**. « Plus tard » est possible, un rappel reste affiché. **Poids net jamais calculé** (aucune tare paramétrée). Si la capacité n'est pas renseignée : aucune palette inventée (T09, T10, T11).
- **N° OF et objectif** facultatifs ; objectif atteint / surproduction affichés (+N).
- **Carte compacte** : OF, n° de bobine, palette en cours, « Dernier cycle du poste HH:MM · marge X min » en couleur rouge/orange/vert, état « Passation proche », « Cycle à valider » (avec vibration sur tablette compatible).
- **Détail ligne** : bobines prévues avant la relève (ex. 37 → 44), projection avec n° de bobines.
- **Anomalie sans arrêt** (T06) : 6 catégories reprises du dossier de passation + note.

### Lot 3 — Bilan du poste et export

- Bouton « 📋 Bilan du poste » : bobines validées, temps d'arrêt et motifs, déchets par code, palettes (et poids manquants), anomalies, par ligne du groupe.
- Bloc « Passation à l'équipe suivante » : OF, dernière bobine, prochaine bobine, palette, arrêt en cours.
- Export CSV (poste ou historique complet), lisible dans Excel (séparateur « ; »).

### Tests
- `npm test` : **30 tests unitaires** (12 d'origine + 18 nouveaux), verts dans 3 fuseaux horaires.
- `test/e2e/parcours_operateur.py` : **31 contrôles** dans un vrai navigateur (Chromium) sur tablette 800×1280 et téléphone 390×844 : démarrage, opérateur obligatoire, palette MT12, poids, double appui, arrêt/reprise, déchet, anomalie, bilan, export, rechargement, annulation, relève vers le poste de nuit.

### Validation terrain : **à faire**.


## Correctif 2.1.1 — 13 octobre 2026

- Conservation des données locales illisibles : sauvegarde bloquée, écran de récupération et téléchargement des octets originaux.
- Export CSV : neutralisation des débuts de formule Excel dans les champs texte, sans modifier les données enregistrées.
- Cache statique versionné 2.1.1.
- 38 tests unitaires réussis (30 existants + 8 de non-régression). Les tests de correction ont reproduit sept échecs avant correction.
- Parcours Playwright non exécuté : téléchargement Chromium échoué dans cet environnement.
- Aucun backend central ajouté : données toujours propres à chaque appareil.
